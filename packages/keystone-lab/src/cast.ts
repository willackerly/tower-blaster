// The star cast (docs/game/spectacle-mode.md, section 6, "Casting thresholds";
// roadmap G5.1): a bot plays an outcome level many times and the thresholds are
// quantiles of what it reached. Engine-agnostic: a CastPlayer plays lines
// (the Node lab on the reference or Rapier, the GPU cast page on WebGPU), and
// everything here is a pure function of the level, the seed and what the
// player returned, so the same seed on the same device casts the same stars.
//
// The recipe is the spec's short one (about 55 min at 10k on the M5): 64
// competent plays; a hill-climb from the best 2 of them, 8 moves each, every
// line judged by the lower quartile of 4 nudged plays; then 50 nudged plays of
// the best line. T2 = median of the competent ends, T3 = lower quartile of the
// nudge cloud, both rounded toward easier to two significant figures.
import type { Vec3 } from '@tb/engine-api';
import { aimAt, castPlay, checkStars, lowerIsBetter, type CastPlay, type CastSample, type CompiledLevel, compileLevel, isLaunchItem, type LevelDef, type RackItem, readShots, sampleValue, type Shot, type StarMetric, type StarsDef, writeShots } from '@tb/keystone';
import { type EngineSpec, engineSubsteps, makeEngine } from './engines.ts';
import { quantile } from './probe.ts';

/** Plays lines of an outcome level, each from the level's start on a fresh engine, in order. */
export interface CastPlayer {
  /** Where the plays ran: the GPU adapter ("apple metal-3 ...", "google swiftshader") or "node". */
  adapter: string;
  /** The game's engine kind the plays ran on (StarsDef.engine): gpu, rapier, or ref. */
  engine: string;
  /** Integrator substeps per step, which launch shots are aimed with. */
  substeps: number;
  play(level: LevelDef, lines: Shot[][]): Promise<CastPlay[]>;
}

export interface CastRecipe {
  /** Competent plays (64). */
  competent: number;
  /** Lines the hill-climb starts from (2), moves per line (8), nudged plays judging each line (4). */
  climbLines: number;
  climbMoves: number;
  climbNudges: number;
  /** Nudged plays of the best line (50). */
  cloud: number;
  /**
   * Confirmation before the cloud (3 lines, 8 nudges each; 0 skips it): the climb's best few distinct lines get
   * more nudges, pooled with those that judged them, and the best by that larger sample becomes the best line.
   * Without it the best line is whichever candidate was luckiest on 4 nudges (B2 seed 2: a line that meets the
   * objective about 55% of the time won on a 4-of-4 sample and its cloud then met it 54% of the time).
   */
  confirmLines?: number;
  confirmNudges?: number;
}

/** The spec's short recipe: 64 + 2 x (1 + 8) x 4 + 3 x 8 + 50 = 210 plays. */
export const SHORT_RECIPE: CastRecipe = { competent: 64, climbLines: 2, climbMoves: 8, climbNudges: 4, confirmLines: 3, confirmNudges: 8, cloud: 50 };
/** The spec's full recipe (64 + 3 x 17 x 8 + 3 x 8 + 50 = 546 plays): over the 60 min budget at 10k until the GPU can fork. */
export const FULL_RECIPE: CastRecipe = { competent: 64, climbLines: 3, climbMoves: 16, climbNudges: 8, confirmLines: 3, confirmNudges: 8, cloud: 50 };

export const playsOf = (r: CastRecipe): number =>
  r.competent + r.climbLines * (1 + r.climbMoves) * r.climbNudges + (r.confirmLines ?? 0) * (r.confirmNudges ?? 0) + r.cloud;

// ---- Seeded randomness (the cast must be repeatable from its seed) ----

/** mulberry32 over a 32-bit seed: uniform floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stream's seed from the cast seed and a label: independent streams that do not shift when another stream draws more. */
export function streamSeed(seed: number, ...label: Array<string | number>): number {
  let h = 0x811c9dc5 ^ (seed >>> 0);
  for (const ch of label.join('/')) h = Math.imul(h ^ ch.charCodeAt(0), 0x01000193) >>> 0;
  return h;
}

const randInt = (r: () => number, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));

/**
 * Plays lines in this thread on the lab's engines (lab engines.ts), each on a fresh engine. Slow at
 * scale (the f64 reference takes about 1 s a step on a 1k wall at 40 iterations): for chamber
 * levels and tests; big levels cast on the GPU page (pnpm keystone:cast --engine gpu).
 */
export function nodeCastPlayer(spec: EngineSpec): CastPlayer {
  return {
    adapter: 'node', engine: spec.kind, substeps: engineSubsteps(spec),
    async play(level, lines) {
      const c = compileLevel(level), out: CastPlay[] = [];
      for (const shots of lines) {
        const e = makeEngine(spec);
        try { out.push(await castPlay(e, c, shots)); } finally { e.dispose(); }
      }
      return out;
    },
  };
}

// ---- Aiming at the structure ----

/** Horizontal face directions: +x, -x, +z, -z. */
export const FACE_DIRS: ReadonlyArray<[number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];
/** Face sectors per height band the competent plays are stratified over (shared out among the face directions by exposed area), and height thirds. */
export const FACE_SECTORS = 8;
export const HEIGHT_BANDS = 3;
/** Most a competent shot comes in away from a face's normal, degrees. */
export const MAX_SKEW = 25;

/**
 * What a bot shot means to do, before it becomes quantised shot fields: hit an exposed face of
 * direction `dir` (FACE_DIRS) at height `yFrac` of the structure, `lateral` of the way along those
 * faces (0 to 1), fired from the launcher ring point that faces it, turned `skew` (-1 to 1, times
 * MAX_SKEW) off the face's normal, at `power` %. A competent player walks round to face what they shoot.
 */
export interface Intent { item: RackItem; dir: number; yFrac: number; lateral: number; skew: number; power: number }

/** Exposed side faces by direction: body indices whose face in that direction has nothing within 0.3 h in front of it. */
const exposedCache = new WeakMap<CompiledLevel, number[][]>();
const targetCache = new WeakMap<CompiledLevel, number[][]>();

/**
 * The exposed faces a competent player aims at: on a crowns level, those of the bodies under or beside
 * the crowns (their horizontal box grown by one cell, so the crown tower or column), since that is what
 * the level asks to bring down; on any other level, every exposed face. Falls back to every exposed face
 * when no crown body shows one.
 */
export function targetFaces(c: CompiledLevel): number[][] {
  const hit = targetCache.get(c);
  if (hit) return hit;
  const all = exposedFaces(c), m = c.meta;
  let out = all;
  if (c.def.objective.kind === 'crowns' && m.crowns.length) {
    const g = c.frame.unit * c.frame.pitch;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const i of m.crowns) {
      x0 = Math.min(x0, m.home[3 * i]! - m.half[3 * i]!); x1 = Math.max(x1, m.home[3 * i]! + m.half[3 * i]!);
      z0 = Math.min(z0, m.home[3 * i + 2]! - m.half[3 * i + 2]!); z1 = Math.max(z1, m.home[3 * i + 2]! + m.half[3 * i + 2]!);
    }
    const under = (i: number) => m.home[3 * i]! > x0 - g && m.home[3 * i]! < x1 + g && m.home[3 * i + 2]! > z0 - g && m.home[3 * i + 2]! < z1 + g;
    const near = all.map((f) => f.filter(under));
    if (near.some((f) => f.length)) out = near;
  }
  targetCache.set(c, out);
  return out;
}

export function exposedFaces(c: CompiledLevel): number[][] {
  const hit = exposedCache.get(c);
  if (hit) return hit;
  const m = c.meta, h = c.frame.unit, cell = h;
  const key = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  const grid = new Map<string, number[]>();
  for (let i = 0; i < m.n; i++) {
    const lo = [0, 1, 2].map((k) => m.home[3 * i + k]! - m.half[3 * i + k]!), hi = [0, 1, 2].map((k) => m.home[3 * i + k]! + m.half[3 * i + k]!);
    for (let x = Math.floor(lo[0]! / cell); x <= Math.floor(hi[0]! / cell); x++) for (let y = Math.floor(lo[1]! / cell); y <= Math.floor(hi[1]! / cell); y++) for (let z = Math.floor(lo[2]! / cell); z <= Math.floor(hi[2]! / cell); z++) {
      const k = `${x},${y},${z}`, list = grid.get(k);
      if (list) list.push(i); else grid.set(k, [i]);
    }
  }
  const inside = (p: Vec3, self: number) => (grid.get(key(...p)) ?? []).some((j) => j !== self && [0, 1, 2].every((k) => Math.abs(p[k]! - m.home[3 * j + k]!) < m.half[3 * j + k]!));
  const out = FACE_DIRS.map(([dx, dz]) => {
    const list: number[] = [];
    for (let i = 0; i < m.n; i++) {
      const p: Vec3 = [m.home[3 * i]! + dx * (m.half[3 * i]! + 0.3 * h), m.home[3 * i + 1]!, m.home[3 * i + 2]! + dz * (m.half[3 * i + 2]! + 0.3 * h)];
      if (!inside(p, i)) list.push(i);
    }
    return list;
  });
  exposedCache.set(c, out);
  return out;
}

/**
 * The exposed face an intent aims at: among the exposed faces of its direction at its height (else
 * the nearest in height), the one nearest its lateral point along them, frontmost on ties; the point is
 * on that face at the intended height. Authored poses: the bot aims before seeing the world.
 */
export function surfaceTarget(c: CompiledLevel, it: Intent): { body: number; point: Vec3; normal: [number, number] } {
  const m = c.meta, h = c.frame.unit, [dx, dz] = FACE_DIRS[it.dir]!, yT = Math.max(0, Math.min(1, it.yFrac)) * c.height;
  const faces = targetFaces(c)[it.dir]!;
  if (!faces.length) return { body: -1, point: [c.frame.centre[0], yT, c.frame.centre[1]], normal: [dx, dz] };
  let cand = faces.filter((i) => Math.abs(m.home[3 * i + 1]! - yT) <= m.half[3 * i + 1]! + 0.25 * h);
  if (!cand.length) {
    const best = Math.min(...faces.map((i) => Math.abs(m.home[3 * i + 1]! - yT)));
    cand = faces.filter((i) => Math.abs(m.home[3 * i + 1]! - yT) <= best + 1e-9);
  }
  // Along the faces: the coordinate across the normal (x for z faces, z for x faces).
  const along = (i: number) => (dx !== 0 ? m.home[3 * i + 2]! : m.home[3 * i]!), fwd = (i: number) => dx * m.home[3 * i]! + dz * m.home[3 * i + 2]!;
  let t0 = Infinity, t1 = -Infinity;
  for (const i of cand) { t0 = Math.min(t0, along(i)); t1 = Math.max(t1, along(i)); }
  const tT = t0 + Math.max(0, Math.min(1, it.lateral)) * (t1 - t0);
  const body = cand.reduce((b, i) => {
    const db = Math.abs(along(b) - tT), di = Math.abs(along(i) - tT);
    return di < db - 1e-9 || (Math.abs(di - db) <= 1e-9 && fwd(i) > fwd(b)) ? i : b;
  });
  const hy = m.half[3 * body + 1]!, by = m.home[3 * body + 1]!;
  return { body, point: [m.home[3 * body]! + dx * m.half[3 * body]!, Math.max(by - 0.9 * hy, Math.min(by + 0.9 * hy, yT)), m.home[3 * body + 2]! + dz * m.half[3 * body + 2]!], normal: [dx, dz] };
}

/** The launcher azimuth (0.5 deg quanta) on the ring where a ray from `point` along `normal` turned by `skewDeg` meets it. */
export function facingAzimuth(c: CompiledLevel, point: Vec3, normal: [number, number], skewDeg: number): number {
  const a = Math.atan2(normal[1], normal[0]) + (skewDeg * Math.PI) / 180, vx = Math.cos(a), vz = Math.sin(a);
  const R = c.frame.launcher.radius * c.frame.pitch * c.frame.unit, px = point[0] - c.frame.centre[0], pz = point[2] - c.frame.centre[1];
  // |p + s v| = R, s > 0 (p is inside the ring, so one positive root).
  const b = px * vx + pz * vz, s = -b + Math.sqrt(Math.max(0, b * b - (px * px + pz * pz - R * R)));
  const az = Math.round((Math.atan2(pz + s * vz, px + s * vx) * 180) / Math.PI * 2);
  return ((az % 720) + 720) % 720;
}

/**
 * The shot an intent fires: a launch aimed with aimAt from the ring point facing the target (at the
 * intent's power, or more if the target is out of reach there), or an anvil dropped over the target body.
 */
export function intentShot(c: CompiledLevel, it: Intent, substeps: number): Shot {
  const t = surfaceTarget(c, it);
  if (it.item === 'drop') {
    const q = (x: number) => Math.round((4 * x) / (c.frame.pitch * c.frame.unit));
    const b = Math.max(0, t.body);
    return { ammo: 'drop', x: q(c.meta.home[3 * b]!), z: q(c.meta.home[3 * b + 2]!) };
  }
  if (!isLaunchItem(it.item)) throw new Error(`the cast cannot aim ${it.item}: only launched items and drops`);
  // A competent player who cannot reach the target at the drawn power fires harder: the least power, in steps
  // of 5 up to 100, whose arc passes within a tenth of a block of it (at 100, the closest miss).
  const y = Math.round(4 * c.frame.launcher.y), item = it.item, az = facingAzimuth(c, t.point, t.normal, it.skew * MAX_SKEW);
  const aim = (power: number) => aimAt(c.frame, item, { az, y, power }, t.point, { substeps });
  let a = aim(it.power);
  for (let p = it.power + 5; a.error > REACH * c.frame.unit && p <= 100 + 4; p += 5) a = aim(Math.min(100, p));
  return a.shot;
}

/** How close (in blocks) an aimed arc must pass the target for the cast to call it reached. */
export const REACH = 0.1;

/** The face sectors given to each direction: FACE_SECTORS shared out by exposed face count (largest remainders). */
export function faceSectors(c: CompiledLevel): number[] {
  const counts = targetFaces(c).map((f) => f.length), total = counts.reduce((a, x) => a + x, 0);
  if (!total) return [FACE_SECTORS, 0, 0, 0];
  const raw = counts.map((k) => (FACE_SECTORS * k) / total), out = raw.map(Math.floor);
  const order = raw.map((x, i) => i).sort((a, b) => raw[b]! - out[b]! - (raw[a]! - out[a]!) || a - b);
  for (let k = 0, left = FACE_SECTORS - out.reduce((a, x) => a + x, 0); k < left; k++) out[order[k]!]!++;
  return out;
}

/**
 * The competent plays' intents: `n` lines, each firing the whole rack in order. Every shot slot is
 * stratified over face sector x height third (FACE_SECTORS x HEIGHT_BANDS strata dealt out in seeded
 * shuffled rounds; face sectors are shared among the four face directions by exposed area, so a
 * wall's broad faces get them all and its ends none); within a stratum the height, lateral point,
 * skew and power (powers[0] to powers[1] %) are uniform.
 */
export function competentIntents(c: CompiledLevel, n: number, seed: number, powers: [number, number] = [60, 100]): Intent[][] {
  const rack = c.def.rack, strata = FACE_SECTORS * HEIGHT_BANDS;
  const dirOf = faceSectors(c).flatMap((k, d) => Array<number>(k).fill(d));
  const deal = rack.map((_, slot) => {
    const out: number[] = [];
    for (let round = 0; out.length < n; round++) {
      const r = rng(streamSeed(seed, 'strata', slot, round)), perm = Array.from({ length: strata }, (_, k) => k);
      for (let k = strata - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [perm[k], perm[j]] = [perm[j]!, perm[k]!]; }
      out.push(...perm);
    }
    return out.slice(0, n);
  });
  return Array.from({ length: n }, (_, line) => rack.map((item, slot) => {
    const s = deal[slot]![line]!, r = rng(streamSeed(seed, 'intent', line, slot)), band = Math.floor(s / FACE_SECTORS);
    return { item, dir: dirOf[s % FACE_SECTORS]!, yFrac: (band + r()) / HEIGHT_BANDS, lateral: r(), skew: 2 * r() - 1, power: randInt(r, powers[0], powers[1]) };
  }));
}

/**
 * One hill-climb move: one shot of the line re-aimed a step away in one of height (5% of the
 * structure), lateral point (5% along the faces), skew (5 deg) or power (5%).
 */
export function moveIntents(line: readonly Intent[], r: () => number): Intent[] {
  const k = Math.floor(r() * line.length), kind = Math.floor(r() * 4), sign = r() < 0.5 ? -1 : 1;
  const it = { ...line[k]! }, clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x));
  if (kind === 0) it.yFrac = clamp(it.yFrac + 0.05 * sign, 0, 1);
  else if (kind === 1) it.lateral = clamp(it.lateral + 0.05 * sign, 0, 1);
  else if (kind === 2) it.skew = clamp(it.skew + (5 / MAX_SKEW) * sign, -1, 1);
  else it.power = clamp(it.power + 5 * sign, 50, 100);
  return line.map((x, i) => (i === k ? it : x));
}

/** Hand noise (spectacle-mode.md section 6, the design's): each launch shot's yaw within 0.6 deg and power within 3%; a drop within a quarter cell; a pull exact. */
export function nudgeLine(shots: readonly Shot[], r: () => number): Shot[] {
  return shots.map((s) => {
    if (s.ammo === 'drop') return { ...s, x: s.x + randInt(r, -1, 1), z: s.z + randInt(r, -1, 1) };
    if (s.ammo === 'cue') return { ...s, power: Math.max(0, Math.min(100, s.power + randInt(r, -3, 3))) };
    if (s.ammo === 'pull') return s; // a pull names a block: there is no hand noise in which one
    if (s.ammo === 'plunger') return s; // a timeline is exact steps: no hand noise either
    if (s.ammo === 'quake') return s; // a quake is dialled in on sliders: no hand noise
    return { ...s, yaw: s.yaw + randInt(r, -6, 6), power: Math.max(0, Math.min(100, s.power + randInt(r, -3, 3))) };
  });
}

// ---- Metrics, quantiles, thresholds ----

export const higherBetter = (metric: StarMetric): boolean => !lowerIsBetter(metric);
/** A metric value turned so that larger is better. */
const good = (metric: StarMetric, v: number) => (higherBetter(metric) ? v : -v);

/**
 * A play's metric as the player would bank it. Once the objective is met the player may bank at any settle, so
 * the play is worth its best met settle; until then there is nothing worth banking and it is worth its last
 * settle. Nothing settled counts as nothing achieved. For collapse, crowns and skyline, which only grow (shrink)
 * shot by shot, this is the last settle; it matters for score, where every shot after the objective costs the
 * rack-left bonus and may break heritage (B2: a competent play that met it on shot 1 scored 3,870 there and 2,680
 * at its end). Alternatives: the last settle (a player who never banks), or the first met settle (one who banks at
 * once, which undersells a skilled player who fires one more shot for collapse).
 */
export function endValue(p: CastPlay, metric: StarMetric): number {
  const last = p.samples.at(-1);
  if (!last) return metric === 'skyline' ? 1 : 0;
  let best: number | null = null;
  for (const s of p.samples) if (s.met) { const v = sampleValue(s, metric); if (best === null || good(metric, v) > good(metric, best)) best = v; }
  return best ?? sampleValue(last, metric);
}

/** Rounded to two significant figures toward easier: down when higher is better, up for skyline. */
export function roundEasier(x: number, higher: boolean): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  const p = 10 ** (Math.floor(Math.log10(Math.abs(x))) - 1), k = x / p;
  return Number(((higher ? Math.floor(k + 1e-9) : Math.ceil(k - 1e-9)) * p).toPrecision(2));
}

/** The worse-for-the-player quantile q: the lower quantile of a higher-is-better metric, the upper of skyline. */
const lowerQ = (metric: StarMetric, xs: readonly number[], q: number) => quantile(xs, higherBetter(metric) ? q : 1 - q);

/** Percentiles 10, 25, 50, 75, 90 of xs. */
export function summary(xs: readonly number[]): { n: number; p10: number; p25: number; p50: number; p75: number; p90: number; min: number; max: number } {
  return { n: xs.length, p10: quantile(xs, 0.1), p25: quantile(xs, 0.25), p50: quantile(xs, 0.5), p75: quantile(xs, 0.75), p90: quantile(xs, 0.9), min: Math.min(...xs), max: Math.max(...xs) };
}

/**
 * Bootstrap (`b` resamples, seeded) of the player-worse quartile of xs, T3's statistic: the 90%
 * interval and its half-width. Each resample draws `size` values (default xs.length): a smaller size
 * gives the interval a cloud of that many plays would land in, which is wider.
 */
export function bootstrapT3(metric: StarMetric, xs: readonly number[], seed: number, b = 2000, size = xs.length): { lo: number; hi: number; halfWidth: number } {
  if (!xs.length) return { lo: NaN, hi: NaN, halfWidth: NaN };
  const r = rng(streamSeed(seed, 'bootstrap')), stats: number[] = [];
  for (let k = 0; k < b; k++) stats.push(lowerQ(metric, Array.from({ length: size }, () => xs[Math.floor(r() * xs.length)]!), 0.25));
  const lo = quantile(stats, 0.05), hi = quantile(stats, 0.95);
  return { lo, hi, halfWidth: (hi - lo) / 2 };
}

// ---- The cast ----

export interface CastLine { phase: 'competent' | 'climb' | 'cloud'; shots: string; samples: CastSample[]; steps: number; complete: boolean; hash: string; limits: string[] }

export interface CastResult {
  level: string;
  hash: string;
  metric: StarMetric;
  recipe: CastRecipe;
  seed: number;
  adapter: string;
  engine: string;
  /** Lines played. */
  n: number;
  /** Wall time of the whole cast, ms (set by the caller that owns a clock; 0 when unknown). */
  wallMs: number;
  /** The raw quantiles; `stars` holds them rounded toward easier, with T3 at least as hard as T2. */
  raw: { t2: number; t3: number; best: number };
  stars: StarsDef;
  /** The best line (shot text) and its climb score (the mini-cloud's player-worse quartile). */
  bestLine: { shots: string; score: number; climbedFrom: string };
  competent: ReturnType<typeof summary>;
  cloud: ReturnType<typeof summary>;
  bootstrap: { lo: number; hi: number; halfWidth: number };
  gates: CastGates;
  lines: CastLine[];
}

export interface Gate { pass: boolean; value: number; need: number; note: string }
export interface CastGates { fair: Gate; skill: Gate; stable: Gate; limits: Gate; complete: Gate; budget?: Gate }

/** The skill gate's range of a metric: 1 for collapse and skyline, the crown count for crowns, the observed spread for score. */
export function metricRange(metric: StarMetric, c: CompiledLevel, all: readonly number[]): number {
  if (metric === 'collapse' || metric === 'skyline') return 1;
  if (metric === 'crowns') return Math.max(1, c.meta.crowns.length);
  return Math.max(1, Math.max(...all) - Math.min(...all));
}

export interface CastOptions {
  metric?: StarMetric;
  seed?: number;
  recipe?: CastRecipe;
  powers?: [number, number];
  /** Called after each batch of plays, for progress lines. */
  progress?(done: number, total: number, phase: string): void;
}

/** Budget gate: a cast at most 60 min on the target machine (spectacle-mode.md section 6). */
export const CAST_BUDGET_MS = 60 * 60_000;

/**
 * T2 (median of the competent ends), T3 (player-worse quartile of the nudge cloud's ends) and the best value
 * seen, raw and rounded toward easier, with T3 never easier than T2 (a level where aiming does not beat a
 * typical attempt fails the skill gate instead).
 */
export function thresholds(metric: StarMetric, compEnd: readonly number[], cloudEnd: readonly number[], all: readonly number[]): { raw: CastResult['raw']; t2: number; t3: number } {
  const hb = higherBetter(metric);
  const raw = { t2: quantile(compEnd, 0.5), t3: lowerQ(metric, cloudEnd, 0.25), best: all.length ? (hb ? Math.max(...all) : Math.min(...all)) : NaN };
  const t2 = roundEasier(raw.t2, hb);
  const t3 = hb ? Math.max(t2, roundEasier(raw.t3, hb)) : Math.min(t2, roundEasier(raw.t3, hb));
  return { raw, t2, t3 };
}

/** Casts an outcome level's stars on `player`: the plays, the thresholds and the gates. */
export async function castLevel(level: LevelDef, player: CastPlayer, opts: CastOptions = {}): Promise<CastResult> {
  const c = compileLevel(level);
  if ((level.scoring ?? 'par') !== 'outcome') throw new Error(`cast: ${level.id} is a par level`);
  const metric = opts.metric ?? level.stars?.metric ?? 'collapse', seed = opts.seed ?? 1, recipe = opts.recipe ?? SHORT_RECIPE;
  const total = playsOf(recipe), lines: CastLine[] = [];
  let done = 0;
  const play = async (phase: CastLine['phase'], batch: Shot[][]): Promise<CastPlay[]> => {
    const out = await player.play(level, batch);
    if (out.length !== batch.length) throw new Error(`cast: the player returned ${out.length} plays for ${batch.length} lines`);
    out.forEach((p, k) => lines.push({ phase, shots: writeShots(batch[k]!), samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits }));
    opts.progress?.((done += batch.length), total, phase);
    return out;
  };
  const toShots = (its: readonly Intent[]) => its.map((it) => intentShot(c, it, player.substeps));

  // 1. Competent plays.
  const intents = competentIntents(c, recipe.competent, seed, opts.powers);
  const comp = await play('competent', intents.map(toShots));
  const compEnd = comp.map((p) => endValue(p, metric));

  // 2. Hill-climb from the best competent lines; a line's score is the player-worse quartile of every nudged play
  // of it so far (a line judged twice pools both samples rather than keeping the luckier one).
  const order = compEnd.map((v, i) => i).sort((a, b) => good(metric, compEnd[b]!) - good(metric, compEnd[a]!) || a - b);
  const key = (its: readonly Intent[]) => writeShots(toShots(its));
  const judged = new Map<string, { its: Intent[]; ends: number[]; from: number }>();
  const scoreOf = (k: string) => good(metric, lowerQ(metric, judged.get(k)!.ends, 0.25));
  const judge = async (its: Intent[], from: number, n: number, tag: string): Promise<number> => {
    const r = rng(streamSeed(seed, 'mini', tag)), base = toShots(its), k = key(its);
    const ps = await play('climb', Array.from({ length: n }, () => nudgeLine(base, r)));
    const e = judged.get(k) ?? { its, ends: [], from };
    e.ends.push(...ps.map((p) => endValue(p, metric)));
    judged.set(k, e);
    return scoreOf(k);
  };
  for (const start of order.slice(0, recipe.climbLines)) {
    let cur = intents[start]!, score = await judge(cur, start, recipe.climbNudges, `${start}/0`);
    const r = rng(streamSeed(seed, 'moves', start));
    for (let k = 1; k <= recipe.climbMoves; k++) {
      // A move can land on the line it started from (a clamped power or aim, or a step lost to rounding):
      // draw again a few times; one that still lands there judges the current line again, pooling the samples.
      let cand = moveIntents(cur, r);
      for (let t = 0; t < 8 && key(cand) === key(cur); t++) cand = moveIntents(cur, r);
      const s = await judge(cand, start, recipe.climbNudges, `${start}/${k}`);
      if (key(cand) === key(cur)) score = s;
      else if (s > score) { cur = cand; score = s; }
    }
  }
  // Confirmation: the best few distinct lines judged so far get more nudges; the best by its pooled sample wins.
  const ranked = () => [...judged.keys()].sort((a, b) => scoreOf(b) - scoreOf(a) || (a < b ? -1 : 1));
  // (Fewer distinct lines than confirmLines, in a tiny recipe: the top ones are confirmed again, so a cast always plays playsOf.)
  const top = ranked(), nConfirm = (recipe.confirmNudges ?? 0) > 0 && top.length ? recipe.confirmLines ?? 0 : 0;
  for (let i = 0; i < nConfirm; i++) {
    const e = judged.get(top[i % top.length]!)!;
    await judge(e.its, e.from, recipe.confirmNudges!, `confirm/${i}`);
  }
  const bestKey = ranked()[0];
  const best = bestKey === undefined ? null : { ...judged.get(bestKey)!, score: scoreOf(bestKey) };
  const bestShots = best ? toShots(best.its) : toShots(intents[order[0]!]!);

  // 3. The nudge cloud.
  const rc = rng(streamSeed(seed, 'cloud'));
  const cloud = await play('cloud', Array.from({ length: recipe.cloud }, () => nudgeLine(bestShots, rc)));
  const cloudEnd = cloud.map((p) => endValue(p, metric));

  // 4. Thresholds and 5. gates, from the plays.
  const hb = higherBetter(metric);
  const { raw, t2, t3, boot, gates } = judgeCast(c, metric, seed, lines);
  const stars: StarsDef = { metric, t2, t3, best: raw.best, castOn: player.adapter, engine: player.engine, hash: c.hash, n: lines.length, seed };
  return {
    level: level.id, hash: c.hash, metric, recipe, seed, adapter: player.adapter, engine: player.engine, n: lines.length, wallMs: 0,
    raw, stars, bestLine: { shots: writeShots(bestShots), score: best ? (hb ? best.score : -best.score) : NaN, climbedFrom: lines[best?.from ?? order[0]!]!.shots },
    competent: summary(compEnd), cloud: summary(cloudEnd), bootstrap: boot, gates, lines,
  };
}

/**
 * A cast's thresholds and gates (all but budget) from its plays: T2 from the competent ends, T3 from the
 * cloud's (every cloud play, so an extended cloud counts whole), the gates as the spec gives them.
 */
export function judgeCast(c: CompiledLevel, metric: StarMetric, seed: number, lines: readonly CastLine[]): { raw: CastResult['raw']; t2: number; t3: number; boot: ReturnType<typeof bootstrapT3>; gates: CastGates } {
  const compEnd = lines.filter((l) => l.phase === 'competent').map((l) => endValue(l, metric));
  const cloud = lines.filter((l) => l.phase === 'cloud'), cloudEnd = cloud.map((l) => endValue(l, metric));
  const all = lines.flatMap((l) => l.samples.map((s) => sampleValue(s, metric)));
  const { raw, t2, t3 } = thresholds(metric, compEnd, cloudEnd, all);
  const boot = bootstrapT3(metric, cloudEnd, seed), range = metricRange(metric, c, all);
  const metRate = cloud.filter((p) => p.samples.at(-1)?.met).length / Math.max(1, cloud.length);
  const limited = lines.filter((l) => l.limits.length).length, incomplete = lines.filter((l) => !l.complete).length;
  const gap = good(metric, raw.t3) - good(metric, raw.t2);
  const gates: CastGates = {
    fair: { pass: metRate >= 0.8, value: metRate, need: 0.8, note: 'share of the nudge cloud meeting the objective' },
    skill: { pass: gap >= 0.1 * range, value: gap, need: 0.1 * range, note: 'T3 - T2 (raw), at least 10% of the metric range' },
    stable: { pass: boot.halfWidth < 0.05 * range, value: boot.halfWidth, need: 0.05 * range, note: "half-width of T3's bootstrap 90% interval, under 5% of the range (a recast with another seed is compareCasts)" },
    limits: { pass: limited === 0, value: limited, need: 0, note: 'plays where the engine hit a limit that changed the physics' },
    complete: { pass: incomplete === 0, value: incomplete, need: 0, note: 'plays that ran out of steps before every shot settled' },
  };
  return { raw, t2, t3, boot, gates };
}

/**
 * More nudges of a cast's best line, added to its cloud (the stable gate's fix: T3's bootstrap interval narrows
 * as the cloud grows, about as 1/sqrt(n)). The nudges come from their own stream, keyed by the cloud's size so
 * a second extension draws new ones. Returns the cast with the plays appended and its thresholds and gates
 * judged again (budget kept as it was: the extension's wall time is the caller's to add).
 */
export async function extendCloud(level: LevelDef, player: CastPlayer, cast: CastResult, n: number): Promise<CastResult> {
  const c = compileLevel(level);
  if (c.hash !== cast.hash) throw new Error(`extend: ${level.id} hashes ${c.hash} here but the cast was of ${cast.hash}`);
  if (player.adapter !== cast.adapter || player.engine !== cast.engine) throw new Error(`extend: the cast was on ${cast.adapter} (${cast.engine}), this player is ${player.adapter} (${player.engine}): extend it on the same device`);
  const had = cast.lines.filter((l) => l.phase === 'cloud').length, best = readShots(cast.bestLine.shots), r = rng(streamSeed(cast.seed, 'extend', had));
  const batch = Array.from({ length: n }, () => nudgeLine(best, r)), plays = await player.play(level, batch);
  const lines = [...cast.lines, ...plays.map((p, k): CastLine => ({ phase: 'cloud', shots: writeShots(batch[k]!), samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits }))];
  const { raw, t2, t3, boot, gates } = judgeCast(c, cast.metric, cast.seed, lines);
  const cloudEnd = lines.filter((l) => l.phase === 'cloud').map((l) => endValue(l, cast.metric));
  return {
    ...cast, n: lines.length, raw, stars: { ...cast.stars, t2, t3, best: raw.best, n: lines.length }, cloud: summary(cloudEnd), bootstrap: boot,
    gates: { ...gates, ...(cast.gates.budget ? { budget: cast.gates.budget } : {}) }, lines,
  };
}

/**
 * Adds the budget gate once the caller has timed the cast. A 10k level's short recipe takes about 3 h on the M5
 * (a play is about a minute at 40 iterations), so its cast passes a larger budget and the gate's note says so.
 */
export function withWallTime(r: CastResult, wallMs: number, budgetMs = CAST_BUDGET_MS): CastResult {
  const waived = budgetMs > CAST_BUDGET_MS ? `; budget raised from ${CAST_BUDGET_MS / 60_000} to ${budgetMs / 60_000} min for this level (--budget-min)` : '';
  return { ...r, wallMs, gates: { ...r.gates, budget: { pass: wallMs <= budgetMs, value: wallMs, need: budgetMs, note: `wall time of the cast, ms (judged on the M5 Max)${waived}` } } };
}

/**
 * The cross-device check (advisory since 2026-11-01: cross-computer fidelity is deferred, and the stars stay the
 * cast device's): T3 played on one device against the interval it would land in on the cast's device.
 * It passes unless the device is harder (T3 past the player-worse end of the interval): the stars are the cast
 * device's, so a device where the same aim does better only makes them easier to earn there, while one where it
 * does worse would make them unfair. The note says whether T3 sat inside the interval or shifted, and which way.
 * B1's first check (6 nudges on SwiftShader, collapse 0.948 to 0.954, five above Metal's P90) shifted easier by
 * 0.0035 past the top of the interval for 6 plays: every play earned three stars, and the two-sided gate it replaces failed it.
 */
export function crossDeviceGate(metric: StarMetric, t3: number, iv: { lo: number; hi: number; halfWidth: number }, here: string, there: string, what = 'T3'): Gate {
  const hb = higherBetter(metric), worse = hb ? iv.lo : iv.hi, better = hb ? iv.hi : iv.lo;
  const harder = good(metric, t3) < good(metric, worse), easier = good(metric, t3) > good(metric, better);
  const where = harder ? `harder on ${here} by ${Math.abs(t3 - worse).toFixed(4)}` : easier ? `easier on ${here} by ${Math.abs(t3 - better).toFixed(4)} (passes: the stars only get easier there)` : 'inside';
  return { pass: !harder, value: t3, need: iv.halfWidth, note: `${what} on ${here} against ${there}'s 90% interval [${iv.lo.toFixed(3)}, ${iv.hi.toFixed(3)}]: ${where}` };
}

/**
 * The stable gate's second half: a recast with another seed moves T3 by less than the first cast's bootstrap
 * half-width (raw T3). With it, the advisory cross-device check of b's T3 against a's interval.
 */
export function compareCasts(a: CastResult, b: CastResult): { recast: Gate; crossDevice: Gate } {
  const d = Math.abs(a.raw.t3 - b.raw.t3);
  return {
    recast: { pass: d < a.bootstrap.halfWidth, value: d, need: a.bootstrap.halfWidth, note: `|T3 ${a.adapter} seed ${a.seed} - T3 ${b.adapter} seed ${b.seed}|` },
    crossDevice: crossDeviceGate(a.metric, b.raw.t3, a.bootstrap, b.adapter, a.adapter),
  };
}

/** The ends of a cast's plays in one phase, by its metric. */
export const phaseEnds = (r: CastResult, phase: CastLine['phase']): number[] => r.lines.filter((l) => l.phase === phase).map((l) => endValue(l, r.metric));

/**
 * Stars from several casts of one level on one device (a cast and its recasts with other seeds), pooled: T2 is
 * the median of every competent play and T3 the player-worse quartile of every nudge cloud. T2 from 64 plays
 * moves with the seed (B1 on the M5: 0.659 and 0.735, 90% intervals about 0.1 wide) while T3 does not (0.944,
 * 0.946); pooling halves T2's variance at no extra plays. Refuses casts of another level hash, metric or device.
 */
/**
 * Gates a cast must have passed to be pooled. A failed fair or skill gate means its best line was not one a
 * skilled player can rely on (B2 seed 2: its cloud met the objective 54% of the time and its T3 was -4,468), so
 * its cloud would drag the pooled T3 toward a line nobody should aim for; failed limits or complete mean its
 * plays are not the game's physics. Stable is judged again on the pool (pooling is how a cast that missed it by
 * a little gets there), and budget is about the machine's wall time, not the stars.
 */
export const POOL_GATES = ['fair', 'skill', 'limits', 'complete'] as const;

/**
 * `def` with its Bounce (restitution) set: a number from 0 to 1, or 'off' (null, the engine's pass off). For
 * probing a level at another e before changing it (roadmap B6, spectacle-mode.md Q2): Bounce enters the level
 * hash, so stars cast on the variant never apply to the level itself.
 */
export function withBounce(def: LevelDef, value: string): LevelDef {
  const bounce = value === 'off' ? null : value.trim() === '' ? NaN : Number(value);
  if (bounce !== null && !(bounce >= 0 && bounce <= 1)) throw new Error(`--bounce is off or a number from 0 to 1: ${value}`);
  return { ...def, physics: { ...def.physics, bounce } };
}

/**
 * Gates a person may waive (`--waive`): skill and stable are judgements about how far the targets sit apart and
 * how noisy T3 is, so a near miss can be accepted as a documented call (B3: skill 0.099 against 0.100, Will
 * 2026-11-06). Fair, limits and complete are not waivable: they say whether the best line meets the objective
 * and whether the plays are the game's physics; recast and budget are about the search and the machine, not stars.
 */
export const WAIVABLE = ['skill', 'stable'] as const;

/**
 * Whether `gates` pass once `waive` is applied: every gate passes or is named in `waive`. Throws for a name that
 * is not a gate here or not waivable, so a typo never passes silently. `waived` lists only the named gates that
 * failed (waiving a gate that passed records nothing), in `waive`'s order: what a stars file's `waived` says.
 */
export function applyWaivers<G extends { [K in keyof G]: Gate | undefined }>(gateSet: G, waive: readonly string[]): { pass: boolean; waived: string[] } {
  const gates = gateSet as Readonly<Record<string, Gate | undefined>>;
  for (const w of waive) {
    if (!(WAIVABLE as readonly string[]).includes(w)) throw new Error(`--waive: ${w} cannot be waived (only ${WAIVABLE.join(', ')})`);
    if (!gates[w]) throw new Error(`--waive: no ${w} gate here`);
  }
  const waived = [...new Set(waive)].filter((w) => !gates[w]!.pass);
  const pass = Object.entries(gates).every(([k, g]) => !g || g.pass || waived.includes(k));
  return { pass, waived };
}

/** The gates of a pool: fair, skill and stable on the pooled plays (limits and complete passed in every cast). */
export interface PoolGates { fair: Gate; skill: Gate; stable: Gate }

/**
 * How a pool sets T3. 'pooled': the player-worse quartile of every cast's cloud together (B1's stars), for casts
 * whose climbs found the same basin. 'best': the cloud of the cast whose best line is best (the highest T3 of
 * any cast that passed fair), for levels where seeds' climbs find different lines (B2, B3): a target set by the
 * best line known, as the spec means T3 (small variations of the best line found), and another seed finding a
 * worse line does not lower it. T2 is every cast's competent plays together either way.
 */
export type PoolT3 = 'pooled' | 'best';

export function poolCasts(casts: readonly CastResult[], t3From: PoolT3 = 'pooled'): { raw: CastResult['raw']; stars: StarsDef; competent: CastResult['competent']; cloud: CastResult['cloud']; seeds: number[]; gates: PoolGates; t3From: PoolT3; t3Seed?: number } {
  const a = casts[0];
  if (!a) throw new Error('pool: no casts');
  for (const b of casts) {
    if (b.hash !== a.hash || b.metric !== a.metric || b.adapter !== a.adapter || b.engine !== a.engine) throw new Error(`pool: cast seed ${b.seed} (${b.hash}, ${b.metric}, ${b.adapter} ${b.engine}) is not of ${a.level} ${a.hash} by ${a.metric} on ${a.adapter} ${a.engine}`);
    // 'best' takes competent plays from any cast whose plays are the game's physics; its T3 cast must pass fair.
    const need = t3From === 'pooled' ? POOL_GATES : (['limits', 'complete'] as const);
    const failed = need.filter((g) => b.gates[g] && !b.gates[g].pass);
    if (failed.length) throw new Error(`pool: cast seed ${b.seed} failed ${failed.map((g) => `${g} (${b.gates[g].value.toFixed(3)}, need ${b.gates[g].need.toFixed(3)})`).join(', ')}: it cannot be pooled; recast that seed`);
  }
  const m = a.metric;
  let from: readonly CastResult[] = casts, t3Seed: number | undefined;
  if (t3From === 'best') {
    const fair = casts.filter((r) => r.gates.fair.pass);
    if (!fair.length) throw new Error('pool: no cast passed fair, so none has a best line to set T3');
    const top = fair.reduce((x, y) => (good(m, lowerQ(m, phaseEnds(y, 'cloud'), 0.25)) > good(m, lowerQ(m, phaseEnds(x, 'cloud'), 0.25)) ? y : x));
    from = [top];
    t3Seed = top.seed;
  }
  const comp = casts.flatMap((r) => phaseEnds(r, 'competent')), cloud = from.flatMap((r) => phaseEnds(r, 'cloud'));
  const all = casts.flatMap((r) => r.lines.flatMap((l) => l.samples.map((s) => sampleValue(s, m))));
  const { raw, t2, t3 } = thresholds(m, comp, cloud, all), n = casts.reduce((k, r) => k + r.n, 0);
  // The metric's range as castLevel judged it (metricRange): fixed for collapse, skyline and crowns (each cast's
  // skill need is a tenth of it), the observed spread of every play for score.
  const range = m === 'score' ? Math.max(1, Math.max(...all) - Math.min(...all)) : a.gates.skill.need / 0.1;
  const clouds = from.flatMap((r) => r.lines.filter((l) => l.phase === 'cloud'));
  const metRate = clouds.filter((l) => l.samples.at(-1)?.met).length / Math.max(1, clouds.length);
  const gap = good(m, raw.t3) - good(m, raw.t2), boot = bootstrapT3(m, cloud, (t3Seed ?? a.seed));
  const which = t3From === 'best' ? `seed ${t3Seed}'s nudge cloud (the best line of the casts)` : 'the pooled nudge clouds';
  const gates: PoolGates = {
    fair: { pass: metRate >= 0.8, value: metRate, need: 0.8, note: `share of ${which} meeting the objective` },
    skill: { pass: gap >= 0.1 * range, value: gap, need: 0.1 * range, note: 'T3 - pooled T2 (raw), at least 10% of the metric range' },
    stable: { pass: boot.halfWidth < 0.05 * range, value: boot.halfWidth, need: 0.05 * range, note: `half-width of T3's bootstrap 90% interval over ${which}, under 5% of the range` },
  };
  return { raw, stars: { metric: m, t2, t3, best: raw.best, castOn: a.adapter, engine: a.engine, hash: a.hash, n, seed: t3Seed ?? a.seed }, competent: summary(comp), cloud: summary(cloud), seeds: casts.map((r) => r.seed), gates, t3From, ...(t3Seed !== undefined ? { t3Seed } : {}) };
}

/** A nudge cloud of another device's best line, played here: the cross-device gate at a smaller N than a whole cast. */
export interface CloudCheck {
  level: string;
  hash: string;
  adapter: string;
  engine: string;
  /** The cast whose best line and bootstrap interval this checks. */
  against: { adapter: string; seed: number; t3: number; lo: number; hi: number };
  n: number;
  seed: number;
  t3: number;
  cloud: ReturnType<typeof summary>;
  crossDevice: Gate;
  limits: Gate;
  complete: Gate;
  lines: CastLine[];
}

/**
 * Plays `n` nudges of `cast`'s best line on this player and checks the spec's cross-device gate: T3 (the
 * player-worse quartile of these ends) inside `cast`'s bootstrap 90% interval. The nudges come from their
 * own seeded stream, so they are not the cast's own cloud replayed. The level must hash as the cast's did.
 */
export async function cloudCheck(level: LevelDef, player: CastPlayer, cast: CastResult, n: number, seed = 1): Promise<CloudCheck> {
  const c = compileLevel(level);
  if (c.hash !== cast.hash) throw new Error(`cloud check: ${level.id} hashes ${c.hash} here but the cast was of ${cast.hash}`);
  const best = readShots(cast.bestLine.shots), r = rng(streamSeed(seed, 'cross-device'));
  const batch = Array.from({ length: n }, () => nudgeLine(best, r));
  const plays = await player.play(level, batch);
  const ends = plays.map((p) => endValue(p, cast.metric)), t3 = lowerQ(cast.metric, ends, 0.25);
  const limited = plays.filter((p) => p.limits.length).length, incomplete = plays.filter((p) => !p.complete).length;
  // The interval a cloud of n plays would land in on the cast's device: the cast's own cloud resampled n at a time
  // (at n below the cast's 50 the quartile spreads wider than the cast's bootstrap interval).
  const { lo, hi, halfWidth } = bootstrapT3(cast.metric, phaseEnds(cast, 'cloud'), seed, 2000, n);
  return {
    level: level.id, hash: c.hash, adapter: player.adapter, engine: player.engine,
    against: { adapter: cast.adapter, seed: cast.seed, t3: cast.raw.t3, lo, hi }, n, seed, t3, cloud: summary(ends),
    crossDevice: crossDeviceGate(cast.metric, t3, { lo, hi, halfWidth }, player.adapter, cast.adapter, `T3 of ${n} nudges`),
    limits: { pass: limited === 0, value: limited, need: 0, note: 'plays where the engine hit a limit that changed the physics' },
    complete: { pass: incomplete === 0, value: incomplete, need: 0, note: 'plays that ran out of steps before every shot settled' },
    lines: plays.map((p, k) => ({ phase: 'cloud', shots: writeShots(batch[k]!), samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits })),
  };
}

/** One recorded play replayed: its end state's hash and banked value then and now. */
export interface ReplayRow { i: number; shots: string; was: { hash: string; value: number; steps: number }; now: { hash: string; value: number; steps: number } }

/** A recorded cast's plays played again here, exactly (no nudge): which end bit for bit as they did. */
export interface ReplayCheck {
  level: string;
  hash: string;
  adapter: string;
  engine: string;
  against: { adapter: string; engine: string; seed: number };
  phase: CastLine['phase'];
  /** Plays that ended in the same state (hash and steps) as recorded. */
  same: number;
  rows: ReplayRow[];
  lines: CastLine[];
}

/**
 * Compares recorded plays with the same lines played again: a play is the same when its end hash and step
 * count match. On the recording's adapter and engine build, every play matches unless the physics or the
 * rules changed (or the engine is not deterministic there); on another adapter, matches are not expected.
 */
export function compareReplay(recorded: readonly CastLine[], now: readonly CastPlay[], metric: StarMetric): { same: number; rows: ReplayRow[] } {
  if (recorded.length !== now.length) throw new Error(`replay: ${now.length} plays for ${recorded.length} recorded`);
  const rows = recorded.map((l, i): ReplayRow => ({
    i, shots: l.shots,
    was: { hash: l.hash, value: endValue(l, metric), steps: l.steps },
    now: { hash: now[i]!.hash, value: endValue(now[i]!, metric), steps: now[i]!.steps },
  }));
  return { same: rows.filter((r) => r.was.hash === r.now.hash && r.was.steps === r.now.steps).length, rows };
}

/**
 * Plays the first `n` recorded lines of `phase` from `cast` again here, exactly, and compares their ends
 * (compareReplay): whether a cast still describes the level as the engine plays it now. The level must hash
 * as the cast's did.
 */
export async function replayCast(level: LevelDef, player: CastPlayer, cast: CastResult, phase: CastLine['phase'] = 'cloud', n = 16): Promise<ReplayCheck> {
  const c = compileLevel(level);
  if (c.hash !== cast.hash) throw new Error(`replay: ${level.id} hashes ${c.hash} here but the cast was of ${cast.hash}`);
  const rec = cast.lines.filter((l) => l.phase === phase).slice(0, n);
  if (!rec.length) throw new Error(`replay: the cast has no ${phase} plays`);
  const plays = await player.play(level, rec.map((l) => readShots(l.shots)));
  const { same, rows } = compareReplay(rec, plays, cast.metric);
  return {
    level: level.id, hash: c.hash, adapter: player.adapter, engine: player.engine, against: { adapter: cast.adapter, engine: cast.engine, seed: cast.seed },
    phase, same, rows, lines: plays.map((p, k) => ({ phase, shots: rec[k]!.shots, samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits })),
  };
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

/**
 * Wall time per engine step over the whole cast, as text for the markdown: a cast whose ms per step is well over
 * the machine's usual (B2 seed 2 on the M5: 30 ms against 15 for seed 1, at the same level) shared the GPU with
 * something else, and its budget gate says more about the machine than the level.
 */
function msPerStep(r: CastResult): string {
  const steps = r.lines.reduce((a, l) => a + l.steps, 0);
  return r.wallMs > 0 && steps > 0 ? ` (${(r.wallMs / steps).toFixed(1)} ms per engine step over ${steps} steps)` : '';
}

/** The cast as markdown for docs/game/levels/<id>.md: settings, thresholds, the two clouds, the gates. */
export function castMarkdown(r: CastResult): string {
  const row = (name: string, s: CastResult['cloud']) => `| ${name} | ${s.n} | ${[s.min, s.p10, s.p25, s.p50, s.p75, s.p90, s.max].map(f3).join(' | ')} |`;
  const gate = (name: string, g: Gate | undefined) => (g ? `| ${name} | ${g.pass ? 'pass' : '**fail**'} | ${f3(g.value)} | ${f3(g.need)} | ${g.note} |` : '');
  return [
    `### Cast ${r.level} on ${r.adapter} (${r.engine}), seed ${r.seed}`,
    '',
    `Level hash \`${r.hash}\`; metric ${r.metric}; recipe ${r.recipe.competent} competent + ${r.recipe.climbLines} x (1 + ${r.recipe.climbMoves}) x ${r.recipe.climbNudges} climb + ${r.recipe.confirmLines ?? 0} x ${r.recipe.confirmNudges ?? 0} confirm + ${r.recipe.cloud} cloud = ${r.n} plays; ${(r.wallMs / 60_000).toFixed(1)} min${msPerStep(r)}.`,
    '',
    `Thresholds: T2 ${f3(r.stars.t2)} (median of competent ends, raw ${f3(r.raw.t2)}), T3 ${f3(r.stars.t3)} (lower quartile of the nudge cloud, raw ${f3(r.raw.t3)}), beat the bot above ${f3(r.raw.best)}.`,
    '',
    `Best line \`${r.bestLine.shots}\` (climbed from \`${r.bestLine.climbedFrom}\`).`,
    '',
    '| Cloud | n | min | P10 | P25 | P50 | P75 | P90 | max |',
    '|---|---|---|---|---|---|---|---|---|',
    row('competent ends', r.competent),
    row('nudge cloud ends', r.cloud),
    '',
    '| Gate | Result | Value | Need | What |',
    '|---|---|---|---|---|',
    ...[gate('fair', r.gates.fair), gate('skill matters', r.gates.skill), gate('stable', r.gates.stable), gate('no limit hit', r.gates.limits), gate('complete', r.gates.complete), gate('budget', r.gates.budget)].filter(Boolean),
    '',
  ].join('\n');
}

// ---- Exploration (designing a level before casting it) ----

export interface Exploration {
  level: string;
  hash: string;
  bodies: number;
  adapter: string;
  engine: string;
  n: number;
  seed: number;
  /**
   * Per shot k (after k + 1 shots settled): the competent plays' collapse, crowns down, heritage broken and
   * objective rate, over the `plays` that got there. A play that ended early (it banked) counts at its last
   * settle; one that ran out of steps counts only at the settles it reached.
   */
  shots: Array<{ plays: number; collapse: ReturnType<typeof summary>; crowns: ReturnType<typeof summary>; heritage: ReturnType<typeof summary>; met: number }>;
  /** Engine steps per play, and the plays that hit a limit or ran out of steps. */
  steps: ReturnType<typeof summary>;
  limited: number;
  incomplete: number;
  lines: CastLine[];
}

/**
 * The competent plays alone (castLevel's step 1): what a typical player gets after each shot, for
 * choosing a level's structure, rack and objective before casting its stars.
 */
export async function exploreLevel(level: LevelDef, player: CastPlayer, n: number, seed = 1, powers?: [number, number]): Promise<Exploration> {
  const c = compileLevel(level);
  const lines = competentIntents(c, n, seed, powers).map((its) => its.map((it) => intentShot(c, it, player.substeps)));
  const plays = await player.play(level, lines);
  return {
    level: level.id, hash: c.hash, bodies: c.meta.n, adapter: player.adapter, engine: player.engine, n, seed,
    shots: level.rack.map((_, k) => shotSummary(plays, k)),
    steps: summary(plays.map((p) => p.steps)),
    limited: plays.filter((p) => p.limits.length).length,
    incomplete: plays.filter((p) => !p.complete).length,
    lines: plays.map((p, k) => ({ phase: 'competent', shots: writeShots(lines[k]!), samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits })),
  };
}

/** Exploration row k: the plays that settled shot k, or ended complete before it (counted at their last settle). */
export function shotSummary(plays: readonly CastPlay[], k: number): Exploration['shots'][number] {
  const got = plays.flatMap((p) => { const s = p.samples[k] ?? (p.complete ? p.samples.at(-1) : undefined); return s ? [s] : []; });
  const of = (f: (s: CastSample) => number) => summary(got.length ? got.map(f) : [NaN]);
  return { plays: got.length, collapse: of((s) => s.collapse), crowns: of((s) => s.crowns), heritage: of((s) => s.heritage), met: got.length ? got.filter((s) => s.met).length / got.length : NaN };
}

/** An exploration as a markdown table: one row per shot. */
export function explorationMarkdown(e: Exploration, extra = ''): string {
  const q = (s: ReturnType<typeof summary>) => `${f3(s.p10)} / ${f3(s.p25)} / ${f3(s.p50)} / ${f3(s.p75)} / ${f3(s.p90)}`;
  return [
    `### ${e.level}: ${e.bodies} bodies, ${e.n} competent plays on ${e.adapter} (${e.engine}), seed ${e.seed}${extra}`,
    '',
    '| after shot | plays | collapse P10 / P25 / P50 / P75 / P90 | crowns down P50 (max) | heritage broken P50 (max) | objective met |',
    '|---|---|---|---|---|---|',
    ...e.shots.map((s, k) => s.plays ? `| ${k + 1} | ${s.plays} | ${q(s.collapse)} | ${s.crowns.p50} (${s.crowns.max}) | ${s.heritage.p50} (${s.heritage.max}) | ${(100 * s.met).toFixed(0)}% |` : `| ${k + 1} | 0 | none got here | | | |`),
    '',
    `Steps per play P50 ${e.steps.p50}, max ${e.steps.max}; plays with a limit hit ${e.limited}, out of steps ${e.incomplete}.`,
    '',
  ].join('\n');
}

/**
 * The text of a stars file (@tb/keystone stars.json: level id -> StarsDef) with level `id`'s stars set to
 * `stars`, one level per line in id order, so a cast's drop-in is a one-line diff. The file's other entries
 * are kept as they are (each must still be valid stars); `text` empty or absent starts a new file.
 */
export function mergeStarsFile(text: string | null, id: string, stars: StarsDef): string {
  const all = text?.trim() ? JSON.parse(text) as Record<string, unknown> : {};
  if (typeof all !== 'object' || all === null || Array.isArray(all)) throw new Error('stars file: not an object of level id -> stars');
  all[id] = checkStars(stars, `stars for ${id}`);
  const ids = Object.keys(all).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const line = (o: StarsDef) => `{ ${Object.entries(o).map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')} }`;
  return `{\n${ids.map((k) => ` ${JSON.stringify(k)}: ${line(checkStars(all[k], `stars file ${k}`))}`).join(',\n')}\n}\n`;
}

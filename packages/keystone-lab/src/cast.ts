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
import { aimAt, castPlay, type CastPlay, type CastSample, type CompiledLevel, compileLevel, isLaunchItem, type LevelDef, type RackItem, readShots, sampleValue, type Shot, type StarMetric, type StarsDef, writeShots } from '@tb/keystone';
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
}

/** The spec's short recipe: 64 + 2 x (1 + 8) x 4 + 50 = 186 plays. */
export const SHORT_RECIPE: CastRecipe = { competent: 64, climbLines: 2, climbMoves: 8, climbNudges: 4, cloud: 50 };
/** The spec's full recipe (64 + 3 x 17 x 8 + 50 = 522 plays): over the 60 min budget at 10k until the GPU can fork. */
export const FULL_RECIPE: CastRecipe = { competent: 64, climbLines: 3, climbMoves: 16, climbNudges: 8, cloud: 50 };

export const playsOf = (r: CastRecipe): number => r.competent + r.climbLines * (1 + r.climbMoves) * r.climbNudges + r.cloud;

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
  const faces = exposedFaces(c)[it.dir]!;
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
  const counts = exposedFaces(c).map((f) => f.length), total = counts.reduce((a, x) => a + x, 0);
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

/** Hand noise (spectacle-mode.md section 6, the design's): each launch shot's yaw within 0.6 deg and power within 3%; a drop within a quarter cell. */
export function nudgeLine(shots: readonly Shot[], r: () => number): Shot[] {
  return shots.map((s) => {
    if (s.ammo === 'drop') return { ...s, x: s.x + randInt(r, -1, 1), z: s.z + randInt(r, -1, 1) };
    if (s.ammo === 'cue') return { ...s, power: Math.max(0, Math.min(100, s.power + randInt(r, -3, 3))) };
    return { ...s, yaw: s.yaw + randInt(r, -6, 6), power: Math.max(0, Math.min(100, s.power + randInt(r, -3, 3))) };
  });
}

// ---- Metrics, quantiles, thresholds ----

export const higherBetter = (metric: StarMetric): boolean => metric !== 'skyline';
/** A metric value turned so that larger is better. */
const good = (metric: StarMetric, v: number) => (higherBetter(metric) ? v : -v);

/** A play's metric at its end (its last settle); nothing settled counts as nothing achieved. */
export function endValue(p: CastPlay, metric: StarMetric): number {
  const s = p.samples.at(-1);
  return s ? sampleValue(s, metric) : metric === 'skyline' ? 1 : 0;
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
 * interval and its half-width.
 */
export function bootstrapT3(metric: StarMetric, xs: readonly number[], seed: number, b = 2000): { lo: number; hi: number; halfWidth: number } {
  if (!xs.length) return { lo: NaN, hi: NaN, halfWidth: NaN };
  const r = rng(streamSeed(seed, 'bootstrap')), stats: number[] = [];
  for (let k = 0; k < b; k++) stats.push(lowerQ(metric, Array.from(xs, () => xs[Math.floor(r() * xs.length)]!), 0.25));
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

  // 2. Hill-climb from the best competent lines; a line's score is its mini-cloud's player-worse quartile.
  const order = compEnd.map((v, i) => i).sort((a, b) => good(metric, compEnd[b]!) - good(metric, compEnd[a]!) || a - b);
  const judge = async (its: readonly Intent[], tag: string): Promise<number> => {
    const r = rng(streamSeed(seed, 'mini', tag)), base = toShots(its);
    const ps = await play('climb', Array.from({ length: recipe.climbNudges }, () => nudgeLine(base, r)));
    return good(metric, lowerQ(metric, ps.map((p) => endValue(p, metric)), 0.25));
  };
  let best: { its: Intent[]; score: number; from: number } | null = null;
  for (const start of order.slice(0, recipe.climbLines)) {
    let cur = intents[start]!, score = await judge(cur, `${start}/0`);
    const r = rng(streamSeed(seed, 'moves', start));
    for (let k = 1; k <= recipe.climbMoves; k++) {
      const cand = moveIntents(cur, r), s = await judge(cand, `${start}/${k}`);
      if (s > score) { cur = cand; score = s; }
    }
    if (!best || score > best.score) best = { its: cur, score, from: start };
  }
  const bestShots = best ? toShots(best.its) : toShots(intents[order[0]!]!);

  // 3. The nudge cloud.
  const rc = rng(streamSeed(seed, 'cloud'));
  const cloud = await play('cloud', Array.from({ length: recipe.cloud }, () => nudgeLine(bestShots, rc)));
  const cloudEnd = cloud.map((p) => endValue(p, metric));

  // 4. Thresholds.
  const all = lines.flatMap((l) => l.samples.map((s) => sampleValue(s, metric)));
  const hb = higherBetter(metric);
  const raw = { t2: quantile(compEnd, 0.5), t3: lowerQ(metric, cloudEnd, 0.25), best: all.length ? (hb ? Math.max(...all) : Math.min(...all)) : NaN };
  const t2 = roundEasier(raw.t2, hb);
  // T3 is never easier than T2: a level where aiming does not beat a typical attempt fails the skill gate instead.
  const t3 = hb ? Math.max(t2, roundEasier(raw.t3, hb)) : Math.min(t2, roundEasier(raw.t3, hb));

  // 5. Gates.
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
  const stars: StarsDef = { metric, t2, t3, best: raw.best, castOn: player.adapter, engine: player.engine, hash: c.hash, n: lines.length, seed };
  return {
    level: level.id, hash: c.hash, metric, recipe, seed, adapter: player.adapter, engine: player.engine, n: lines.length, wallMs: 0,
    raw, stars, bestLine: { shots: writeShots(bestShots), score: best ? (hb ? best.score : -best.score) : NaN, climbedFrom: lines[best?.from ?? order[0]!]!.shots },
    competent: summary(compEnd), cloud: summary(cloudEnd), bootstrap: boot, gates, lines,
  };
}

/** Adds the budget gate once the caller has timed the cast. */
export function withWallTime(r: CastResult, wallMs: number, budgetMs = CAST_BUDGET_MS): CastResult {
  return { ...r, wallMs, gates: { ...r.gates, budget: { pass: wallMs <= budgetMs, value: wallMs, need: budgetMs, note: 'wall time of the cast, ms (judged on the M5 Max)' } } };
}

/**
 * The stable gate's second half: a recast with another seed moves T3 by less than the first cast's
 * bootstrap half-width. The cross-device gate: T3 cast on one device lies inside another's
 * bootstrap 90% interval. Both on the raw T3.
 */
export function compareCasts(a: CastResult, b: CastResult): { recast: Gate; crossDevice: Gate } {
  const d = Math.abs(a.raw.t3 - b.raw.t3);
  return {
    recast: { pass: d < a.bootstrap.halfWidth, value: d, need: a.bootstrap.halfWidth, note: `|T3 ${a.adapter} seed ${a.seed} - T3 ${b.adapter} seed ${b.seed}|` },
    crossDevice: { pass: b.raw.t3 >= a.bootstrap.lo && b.raw.t3 <= a.bootstrap.hi, value: b.raw.t3, need: a.bootstrap.halfWidth, note: `T3 on ${b.adapter} inside ${a.adapter}'s 90% interval [${a.bootstrap.lo.toFixed(3)}, ${a.bootstrap.hi.toFixed(3)}]` },
  };
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
  const { lo, hi } = cast.bootstrap;
  return {
    level: level.id, hash: c.hash, adapter: player.adapter, engine: player.engine,
    against: { adapter: cast.adapter, seed: cast.seed, t3: cast.raw.t3, lo, hi }, n, seed, t3, cloud: summary(ends),
    crossDevice: { pass: t3 >= lo && t3 <= hi, value: t3, need: cast.bootstrap.halfWidth, note: `T3 of ${n} nudges on ${player.adapter} inside ${cast.adapter}'s 90% interval [${lo.toFixed(3)}, ${hi.toFixed(3)}]` },
    limits: { pass: limited === 0, value: limited, need: 0, note: 'plays where the engine hit a limit that changed the physics' },
    complete: { pass: incomplete === 0, value: incomplete, need: 0, note: 'plays that ran out of steps before every shot settled' },
    lines: plays.map((p, k) => ({ phase: 'cloud', shots: writeShots(batch[k]!), samples: p.samples, steps: p.steps, complete: p.complete, hash: p.hash, limits: p.limits })),
  };
}

const f3 = (x: number) => (Number.isFinite(x) ? x.toFixed(3) : String(x));

/** The cast as markdown for docs/game/levels/<id>.md: settings, thresholds, the two clouds, the gates. */
export function castMarkdown(r: CastResult): string {
  const row = (name: string, s: CastResult['cloud']) => `| ${name} | ${s.n} | ${[s.min, s.p10, s.p25, s.p50, s.p75, s.p90, s.max].map(f3).join(' | ')} |`;
  const gate = (name: string, g: Gate | undefined) => (g ? `| ${name} | ${g.pass ? 'pass' : '**fail**'} | ${f3(g.value)} | ${f3(g.need)} | ${g.note} |` : '');
  return [
    `### Cast ${r.level} on ${r.adapter} (${r.engine}), seed ${r.seed}`,
    '',
    `Level hash \`${r.hash}\`; metric ${r.metric}; recipe ${r.recipe.competent} competent + ${r.recipe.climbLines} x (1 + ${r.recipe.climbMoves}) x ${r.recipe.climbNudges} climb + ${r.recipe.cloud} cloud = ${r.n} plays; ${(r.wallMs / 60_000).toFixed(1)} min.`,
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

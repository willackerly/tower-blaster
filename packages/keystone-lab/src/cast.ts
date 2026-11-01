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
import { aimAt, castPlay, type CastPlay, type CastSample, type CompiledLevel, compileLevel, isLaunchItem, type LevelDef, type RackItem, sampleValue, type Shot, type StarMetric, type StarsDef, writeShots } from '@tb/keystone';
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

/** Azimuth sectors (of 720 half-degree quanta) and height thirds the competent plays are stratified over. */
export const AZ_SECTORS = 8;
export const HEIGHT_BANDS = 3;

/**
 * What a bot shot means to do, before it is turned into quantised shot fields: from azimuth `az`
 * (0.5 deg) hit the structure at height `yFrac` of its height, `lateral` of the way across it as
 * seen from there (0 = left edge, 1 = right edge), at `power` %.
 */
export interface Intent { item: RackItem; az: number; yFrac: number; lateral: number; power: number }

/**
 * The structure surface point an intent aims at: among the bodies at that height, the one nearest
 * the lateral line that is frontmost toward the launcher, on its face toward the launcher. Uses the
 * authored poses (the bot aims before seeing the world, as a competent but unseeing player would).
 */
export function surfaceTarget(c: CompiledLevel, it: Intent): { body: number; point: Vec3 } {
  const m = c.meta, h = c.frame.unit, [cx, cz] = c.frame.centre;
  const a = it.az * 0.5 * (Math.PI / 180), ux = Math.cos(a), uz = Math.sin(a), wx = -uz, wz = ux;
  const yT = Math.max(0, Math.min(1, it.yFrac)) * c.height;
  if (m.n === 0) return { body: -1, point: [cx, yT, cz] };
  // Bodies whose vertical extent reaches the height, else the nearest in height.
  let cand: number[] = [];
  for (let i = 0; i < m.n; i++) if (Math.abs(m.home[3 * i + 1]! - yT) <= m.half[3 * i + 1]! + 0.25 * h) cand.push(i);
  if (!cand.length) {
    let best = Infinity;
    for (let i = 0; i < m.n; i++) best = Math.min(best, Math.abs(m.home[3 * i + 1]! - yT));
    for (let i = 0; i < m.n; i++) if (Math.abs(m.home[3 * i + 1]! - yT) <= best + 1e-9) cand.push(i);
  }
  const lat = (i: number) => (m.home[3 * i]! - cx) * wx + (m.home[3 * i + 2]! - cz) * wz;
  const fwd = (i: number) => (m.home[3 * i]! - cx) * ux + (m.home[3 * i + 2]! - cz) * uz;
  let v0 = Infinity, v1 = -Infinity;
  for (const i of cand) { v0 = Math.min(v0, lat(i)); v1 = Math.max(v1, lat(i)); }
  const vT = v0 + Math.max(0, Math.min(1, it.lateral)) * (v1 - v0);
  const latHalf = (i: number) => Math.abs(wx) * m.half[3 * i]! + Math.abs(wz) * m.half[3 * i + 2]!;
  const onLine = cand.filter((i) => Math.abs(lat(i) - vT) <= latHalf(i) + 0.25 * h);
  if (onLine.length) cand = onLine;
  else {
    const d = Math.min(...cand.map((i) => Math.abs(lat(i) - vT)));
    cand = cand.filter((i) => Math.abs(lat(i) - vT) <= d + 1e-9);
  }
  const body = cand.reduce((b, i) => (fwd(i) > fwd(b) + 1e-9 ? i : b));
  const face = Math.abs(ux) * m.half[3 * body]! + Math.abs(uz) * m.half[3 * body + 2]!;
  const hy = m.half[3 * body + 1]!, by = m.home[3 * body + 1]!;
  return { body, point: [m.home[3 * body]! + ux * face, Math.max(by - 0.9 * hy, Math.min(by + 0.9 * hy, yT)), m.home[3 * body + 2]! + uz * face] };
}

/** The shot an intent fires: a launch aimed with aimAt from the launcher's height, or an anvil dropped over the target body. */
export function intentShot(c: CompiledLevel, it: Intent, substeps: number): Shot {
  const t = surfaceTarget(c, it);
  if (it.item === 'drop') {
    const q = (x: number) => Math.round((4 * x) / (c.frame.pitch * c.frame.unit));
    const b = Math.max(0, t.body);
    return { ammo: 'drop', x: q(c.meta.home[3 * b]!), z: q(c.meta.home[3 * b + 2]!) };
  }
  if (!isLaunchItem(it.item)) throw new Error(`the cast cannot aim ${it.item}: only launched items and drops`);
  return aimAt(c.frame, it.item, { az: it.az, y: Math.round(4 * c.frame.launcher.y), power: it.power }, t.point, { substeps }).shot;
}

/**
 * The competent plays' intents: `n` lines, each firing the whole rack in order. Every shot slot is
 * stratified over azimuth sector x height third (24 strata dealt out in shuffled rounds, so 64 lines
 * cover each stratum 2 or 3 times per slot); within a stratum the azimuth, height, lateral point and
 * power (powers[0] to powers[1] %) are uniform.
 */
export function competentIntents(c: CompiledLevel, n: number, seed: number, powers: [number, number] = [60, 100]): Intent[][] {
  const rack = c.def.rack, strata = AZ_SECTORS * HEIGHT_BANDS, sector = 720 / AZ_SECTORS;
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
    const s = deal[slot]![line]!, r = rng(streamSeed(seed, 'intent', line, slot));
    const az = (s % AZ_SECTORS) * sector + Math.floor(r() * sector), band = Math.floor(s / AZ_SECTORS);
    return { item, az, yFrac: (band + r()) / HEIGHT_BANDS, lateral: r(), power: randInt(r, powers[0], powers[1]) };
  }));
}

/**
 * One hill-climb move: one shot of the line re-aimed a step away in one of azimuth (5 deg),
 * height (5% of the structure), lateral point (5% across) or power (5%).
 */
export function moveIntents(line: readonly Intent[], r: () => number): Intent[] {
  const k = Math.floor(r() * line.length), kind = Math.floor(r() * 4), sign = r() < 0.5 ? -1 : 1;
  const it = { ...line[k]! }, clamp01 = (x: number) => Math.max(0, Math.min(1, x));
  if (kind === 0) it.az = (((it.az + 10 * sign) % 720) + 720) % 720;
  else if (kind === 1) it.yFrac = clamp01(it.yFrac + 0.05 * sign);
  else if (kind === 2) it.lateral = clamp01(it.lateral + 0.05 * sign);
  else it.power = Math.max(50, Math.min(100, it.power + 5 * sign));
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

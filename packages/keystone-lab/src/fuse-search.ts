// Fuse & Fold's design search and its order-matters gate (M5, docs/game/fuse-and-fold.md; probe X2 extended).
// A fold level is judged over nudged builds (keystone nudgedLevel: every body moved up to 1 mm and turned up to
// 0.2 deg), so a lucky chaotic outcome cannot pass. Lines are plunger timelines: every charge, each with a
// delay on the 0.1 s grid. The structured lines a demolition engineer would try are sweeps: a direction
// (one of 8 compass points) and a spacing, each charge going `spacing` after the row before it along the
// direction. The naive line fires everything at once.
//
// The gate (the brief's, X2's rule on a level): the best line's mean fold beats the naive line's by at least
// 0.1 (a tenth of the metric's range) and by more than 3 standard errors of the nudge means, and the best line
// meets the objective on at least 80% of the nudges (the cast's fair gate).
import { castPlay, type CastPlay, type CompiledLevel, compileLevel, Driver, type LevelDef, nudgedLevel, playShots, type PlungerShot, sampleOf, type CastSample } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';
import { forkDeep } from './fork.ts';

/** Engine steps per 0.1 s at 60 Hz: the timeline's snap. */
export const SNAP_STEPS = 6;
/** The longest delay a fold line uses, in snaps (2 s). */
export const MAX_SNAPS = 20;

export interface FoldLine { name: string; shot: PlungerShot }

/** The 8 compass directions as unit vectors in (x, z), name first: W means "the west row goes first", so it falls west. */
export const COMPASS: ReadonlyArray<[string, number, number]> = [
  ['W', -1, 0], ['NW', -Math.SQRT1_2, -Math.SQRT1_2], ['N', 0, -1], ['NE', Math.SQRT1_2, -Math.SQRT1_2],
  ['E', 1, 0], ['SE', Math.SQRT1_2, Math.SQRT1_2], ['S', 0, 1], ['SW', -Math.SQRT1_2, Math.SQRT1_2],
];

/** The plunger charges of a level (arm 'plunger'), by index. */
export function plungerCharges(c: CompiledLevel): number[] {
  return (c.def.charges ?? []).flatMap((ch, i) => ((ch.arm ?? 'plunger') === 'plunger' ? [i] : []));
}

/** A plunger shot from per-charge delays in snaps (every plunger charge, ordered by delay then index). */
export function lineOf(charges: readonly number[], snaps: readonly number[]): PlungerShot {
  const fuse = charges.map((ch, k): [number, number] => [ch, snaps[k]! * SNAP_STEPS]);
  fuse.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  return { ammo: 'plunger', fuse };
}

/**
 * The rank of each charge's host along a direction: hosts whose projections on (dx, dz) lie within a quarter
 * cell share a row; the row nearest the direction's far side (its most-negative projection: the side it
 * falls to) is rank 0.
 */
export function rowRanks(c: CompiledLevel, charges: readonly number[], dx: number, dz: number): number[] {
  const defs = c.def.charges!, m = c.meta, cell = c.frame.unit * c.frame.pitch;
  // Projection on the fall direction: the row furthest along it fires first.
  const proj = charges.map((ch) => { const b = defs[ch]!.host; return -(dx * m.home[3 * b]! + dz * m.home[3 * b + 2]!); });
  const sorted = [...new Set(proj.map((p) => Math.round(p / (0.25 * cell))))].sort((a, b) => a - b);
  // Merge keys within one key of each other (a quarter cell): a row's hosts differ by float noise only.
  const rowOf = new Map<number, number>();
  let row = -1, last = -Infinity;
  for (const k of sorted) { if (k - last > 1) row++; rowOf.set(k, row); last = k; }
  return proj.map((p) => rowOf.get(Math.round(p / (0.25 * cell)))!);
}

/** The naive line (all at once) and every sweep: 8 directions x spacings 1 to maxSpacing snaps, delays capped at MAX_SNAPS. */
export function sweepLines(c: CompiledLevel, maxSpacing = 10): FoldLine[] {
  const ch = plungerCharges(c), out: FoldLine[] = [{ name: 'all at once', shot: lineOf(ch, ch.map(() => 0)) }];
  const seen = new Set([JSON.stringify(out[0]!.shot)]);
  for (const [name, dx, dz] of COMPASS) {
    const rank = rowRanks(c, ch, dx, dz);
    for (let sp = 1; sp <= maxSpacing; sp++) {
      const shot = lineOf(ch, rank.map((r) => Math.min(MAX_SNAPS, r * sp)));
      const key = JSON.stringify(shot);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: `${name} ${(sp / 10).toFixed(1)} s`, shot });
    }
  }
  return out;
}

/** One play's end: the sample banked at the line's settle (fold, collapse, spill via fold, met, heritage). */
export interface FoldEnd { fold: number; collapse: number; met: boolean; heritage: number; steps: number; limits: number }

const endOf = (p: CastPlay): FoldEnd => {
  const s: CastSample | undefined = p.samples.at(-1);
  return { fold: s?.fold ?? 0, collapse: s?.collapse ?? 0, met: s?.met ?? false, heritage: s?.heritage ?? 0, steps: p.steps, limits: p.limits.length };
};

/**
 * Every line on one nudged build of `level`. On a forkable engine (the reference) the build pre-settles once
 * and each line plays from a copy of it; otherwise each line plays from a fresh engine (castPlay). Either way a
 * line's play is the session the game would run from the level's start.
 */
export async function playNudge(level: LevelDef, lines: readonly FoldLine[], nudge: number, spec: EngineSpec = { kind: 'ref' }): Promise<FoldEnd[]> {
  const c = nudgedLevel(compileLevel(level), nudge), out: FoldEnd[] = [];
  if (spec.kind !== 'ref') {
    for (const L of lines) {
      const e = makeEngine(spec);
      try { out.push(endOf(await castPlay(e, c, [L.shot]))); } finally { e.dispose(); }
    }
    return out;
  }
  const e = makeEngine(spec), d0 = new Driver(e, c);
  await d0.reset();
  for (const L of lines) {
    const d = forkDeep(d0, [c]);
    const r = await playShots(d, [L.shot], 0);
    const s = sampleOf(r.session, r.steps);
    out.push({ fold: s.fold ?? 0, collapse: s.collapse, met: s.met, heritage: s.heritage, steps: r.steps, limits: 0 });
  }
  return out;
}

export interface LineStats { name: string; n: number; fold: number; sd: number; se: number; collapse: number; met: number; heritage: number }

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sdOf = (xs: readonly number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

/** Per-line statistics over nudges: ends[nudge][line]. */
export function lineStats(lines: readonly FoldLine[], ends: readonly FoldEnd[][]): LineStats[] {
  return lines.map((L, k) => {
    const e = ends.map((row) => row[k]!), f = e.map((x) => x.fold), sd = sdOf(f);
    return { name: L.name, n: e.length, fold: mean(f), sd, se: sd / Math.sqrt(e.length), collapse: mean(e.map((x) => x.collapse)), met: mean(e.map((x) => (x.met ? 1 : 0))), heritage: mean(e.map((x) => (x.heritage > 0 ? 1 : 0))) };
  });
}

/** The gate's rule, in numbers. */
export const GATE = { diff: 0.1, z: 3, fair: 0.8 } as const;
/**
 * Standard errors a zero-spread pair is treated as having: one nudge's worth of the reference's float noise.
 * With every nudge landing the same (the felled frame lands the same to 3 decimals), z is the difference over
 * this floor, so a difference of 0.1 is 100 floors: a pass, as it should be.
 */
export const SE_FLOOR = 1e-3;

export interface GateResult { pass: boolean; best: LineStats; naive: LineStats; diff: number; z: number; fair: number; detail: string }

/** The order-matters gate over a level's line statistics (the first line is the naive one). */
export function orderGate(stats: readonly LineStats[]): GateResult {
  const naive = stats[0]!;
  // Best by mean fold among lines that meet the objective most often; ties by fold.
  const best = [...stats].sort((a, b) => b.met - a.met || b.fold - a.fold)[0]!;
  const diff = best.fold - naive.fold, z = diff / Math.max(SE_FLOOR, Math.hypot(best.se, naive.se));
  // 1e-9: 0.3 - 0.2 is 0.0999... in floating point, and a tenth means a tenth.
  const pass = diff >= GATE.diff - 1e-9 && z > GATE.z && best.met >= GATE.fair;
  return { pass, best, naive, diff, z, fair: best.met, detail: `best "${best.name}" fold ${best.fold.toFixed(3)} (met ${(100 * best.met).toFixed(0)}%) vs all at once ${naive.fold.toFixed(3)} (met ${(100 * naive.met).toFixed(0)}%): +${diff.toFixed(3)}, ${z > 1e3 ? '>1000' : z.toFixed(1)} SE` };
}

/** One unit of work: some lines on one nudged build. */
export interface FoldTask { lines: readonly FoldLine[]; nudge: number }

/** Plays tasks on a pool of `jobs` worker threads (1: in this thread); results in task order. */
export async function playTasks(level: LevelDef, tasks: readonly FoldTask[], jobs: number, spec: EngineSpec = { kind: 'ref' }, log?: (line: string) => void): Promise<FoldEnd[][]> {
  const out: FoldEnd[][] = new Array(tasks.length);
  if (jobs <= 1) {
    for (let k = 0; k < tasks.length; k++) { out[k] = await playNudge(level, tasks[k]!.lines, tasks[k]!.nudge, spec); log?.(`  ${k + 1}/${tasks.length}`); }
    return out;
  }
  const { Worker } = await import('node:worker_threads');
  let next = 0, done = 0;
  const run = async () => {
    const w = new Worker(new URL('./boot.mjs', import.meta.url), { workerData: { entry: new URL('./fuse-worker.ts', import.meta.url).href, spec } });
    try {
      while (next < tasks.length) {
        const id = next++, t = tasks[id]!;
        out[id] = await new Promise<FoldEnd[]>((resolve, reject) => {
          const onMsg = (m: { id: number; result?: FoldEnd[]; error?: string }) => { w.off('error', onErr); if (m.error) reject(new Error(m.error)); else resolve(m.result!); };
          const onErr = (e: unknown) => { w.off('message', onMsg); reject(e); };
          w.once('message', onMsg);
          w.once('error', onErr);
          w.postMessage({ id, level, lines: t.lines, nudge: t.nudge });
        });
        log?.(`  ${++done}/${tasks.length}`);
      }
    } finally { await w.terminate(); }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, run));
  return out;
}

export interface SearchResult { level: string; hash: string; bodies: number; charges: number; screen: LineStats[]; confirm: LineStats[]; gate: GateResult; wallS: number }

export interface SearchOptions { screenNudges?: number[]; confirmNudges?: number[]; keep?: number; maxSpacing?: number; jobs?: number; spec?: EngineSpec; extra?: FoldLine[]; log?: (l: string) => void }

/**
 * The two-stage search on one level: every sweep (and `extra` lines) on `screenNudges` builds, then the naive
 * line and the best `keep` lines (objective met most often, then mean fold) on `confirmNudges` builds, and the
 * gate over those.
 */
export async function searchLevel(level: LevelDef, o: SearchOptions = {}): Promise<SearchResult> {
  const t0 = performance.now(), c = compileLevel(level), spec = o.spec ?? { kind: 'ref' as const }, jobs = o.jobs ?? 1;
  const lines = [...sweepLines(c, o.maxSpacing ?? 10), ...(o.extra ?? [])];
  const sn = o.screenNudges ?? [1], cn = o.confirmNudges ?? [1, 2, 3, 4, 5, 6, 7, 8];
  o.log?.(`${level.id}: screening ${lines.length} lines on ${sn.length} build(s)`);
  // Screen: each build's lines split into one task per worker, so the pool stays busy on a single build.
  const per = Math.max(1, Math.ceil(jobs / sn.length)), tasks: FoldTask[] = [], where: Array<[number, number[]]> = [];
  sn.forEach((n, b) => { for (let k = 0; k < per; k++) { const idx = lines.map((_, i) => i).filter((i) => i % per === k); if (idx.length) { tasks.push({ lines: idx.map((i) => lines[i]!), nudge: n }); where.push([b, idx]); } } });
  const parts = await playTasks(level, tasks, jobs, spec, o.log);
  const screenEnds: FoldEnd[][] = sn.map(() => new Array<FoldEnd>(lines.length));
  parts.forEach((p, t) => { const [b, idx] = where[t]!; idx.forEach((i, j) => { screenEnds[b]![i] = p[j]!; }); });
  const screen = lineStats(lines, screenEnds);
  const ranked = screen.map((s, i) => ({ s, i })).slice(1).sort((a, b) => b.s.met - a.s.met || b.s.fold - a.s.fold);
  const keepLines = [lines[0]!, ...ranked.slice(0, o.keep ?? 4).map((x) => lines[x.i]!)];
  o.log?.(`${level.id}: confirming ${keepLines.length} lines on ${cn.length} builds`);
  const confirmEnds = await playTasks(level, cn.map((n) => ({ lines: keepLines, nudge: n })), jobs, spec, o.log);
  const confirm = lineStats(keepLines, confirmEnds);
  return { level: level.id, hash: c.hash, bodies: c.meta.n, charges: plungerCharges(c).length, screen, confirm, gate: orderGate(confirm), wallS: (performance.now() - t0) / 1000 };
}

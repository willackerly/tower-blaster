// Aftershock's design search and its choice-matters gate (M7, docs/game/aftershock.md; probe X6's follow-up).
//
// Two stages, both on the reference engine (f64; the GPU engine runs the CI-size check in a browser):
//
// 1. Threshold curves (towerCurve): one tower alone on the ground, a ladder of quake peaks at each (hz, sec, axis),
//    on nudged builds. Each run ends where the quake shot settles; the tower is `down` if its top is below the crown
//    line a level would give it (half its height) and `standing` if it has neither dropped 0.3 h nor tilted 15
//    degrees (the 'standing' heritage rule). The curve is the share of builds down, and standing, at each peak.
//    X6 found no resonance: a curve is a threshold, rising with frequency; its shape against duration and axis is
//    what tells towers apart.
// 2. Levels (searchQuakeLevel): a site of condemned and protected towers (keystone aftershock-levels.ts) and a grid
//    of quakes, played as the game plays them (a quake shot through the Driver and Session, on nudged builds). A
//    level ships only if it passes the gate (quakeGate): the best quake meets the objective (every condemned crown
//    down, every protected tower standing) on at least 80% of 8 builds; its tower score beats the naive quake's
//    (the dial's brute end: strongest, lowest, longest, along +x) by at least 0.1 and by more than 3 standard
//    errors; and the naive quake meets the objective on at most 20% of the builds. So the choice of quake matters.
//
// A nudged build moves every body up to 1 mm and turns it up to 0.2 degrees (probe X2's nudge), so a lucky chaotic
// outcome cannot pass.
import type { BodyDesc, Quat } from '@tb/engine-api';
import {
  type CompiledLevel, compileLevel, crownDown, Driver, forkDeep, heritageFallen, type LevelDef, naiveQuake, parseTower, playShots, QUAKE, quakeEnergy,
  type QuakeShot, towerHeight, towerParts, writeShots,
} from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';

/** mulberry32: one stream per seed, identical everywhere. */
function stream(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Jitter of a nudged build (probe X2's): up to 1 mm across and 0.2 deg of yaw per body. */
export const NUDGE_MM = 1, NUDGE_DEG = 0.2;

/**
 * The level as built by a slightly different hand: every moving body shifted up to NUDGE_MM horizontally and turned
 * up to NUDGE_DEG about +y from its own seed (nudge 0: the level itself). Pinned bodies stay where they are bolted.
 * Same bodies, metadata and hash; only the scene moves.
 */
export function nudgeLevel(c: CompiledLevel, nudge: number): CompiledLevel {
  if (nudge === 0) return c;
  const r = stream(0x5eed0000 + nudge), sym = () => 2 * r() - 1;
  const bodies = c.scene.bodies.map((b): BodyDesc => {
    const a = (sym() * NUDGE_DEG * Math.PI) / 180, dx = sym() * NUDGE_MM * 1e-3, dz = sym() * NUDGE_MM * 1e-3;
    if (b.pinned) return b;
    const q: Quat = [0, Math.sin(a / 2), 0, Math.cos(a / 2)], [x, y, z, w] = b.rot;
    const rot: Quat = [q[3] * x + q[1] * z, q[3] * y + q[1] * w, q[3] * z - q[1] * x, q[3] * w - q[1] * y];
    return { ...b, pos: [b.pos[0] + dx, b.pos[1], b.pos[2] + dz], rot };
  });
  return { ...c, scene: { ...c.scene, bodies } };
}

/** A quake as the shot the dial makes. */
export const quake = (peak: number, hz: number, sec: number, axis = 0): QuakeShot => ({ ammo: QUAKE, peak, hz, sec, axis });
/** A quake's name in tables: `0.30 g 1.0 Hz 1.5 s 0 deg`. */
export const quakeName = (q: QuakeShot): string => `${(q.peak / 100).toFixed(2)} g ${(q.hz / 10).toFixed(1)} Hz ${(q.sec / 10).toFixed(1)} s ${q.axis} deg`;

/** How one quake left one build: per tower whether it is down and whether it stands, and the level's verdict. */
export interface QuakeEnd { down: boolean[]; standing: boolean[]; met: boolean; steps: number }

/**
 * Plays every quake on one nudged build of `level`, each from a copy of the build pre-settled once (the reference
 * engine is plain data, so forkDeep copies it). `towers[i]` is tower i's top body (engine id) and `down` its crown
 * line in metres; a site level passes them from its crowns and heritage (siteTops).
 */
export async function playQuakes(level: LevelDef, quakes: readonly QuakeShot[], nudge: number, spec: EngineSpec = { kind: 'ref' }): Promise<QuakeEnd[]> {
  const c = nudgeLevel(compileLevel(level), nudge), tops = siteTops(c), out: QuakeEnd[] = [];
  const e = makeEngine(spec), d0 = new Driver(e, c);
  await d0.reset();
  try {
    for (const q of quakes) {
      const d = spec.kind === 'ref' ? forkDeep(d0, [c]) : await fresh(spec, c);
      const r = await playShots(d, [q], 0, { maxSteps: d.engine.stepIndex + 60 * 60 });
      const s = r.snapshot, home = r.session.home;
      const down: boolean[] = [], standing: boolean[] = [];
      for (const t of tops) {
        const b = t.body, p: [number, number, number] = [s.pos[3 * b]!, s.pos[3 * b + 1]!, s.pos[3 * b + 2]!], rq = s.rot.subarray(4 * b, 4 * b + 4);
        down.push(p[1] < t.line || crownDown(c, p));
        standing.push(!heritageFallen(c, p, [rq[0]!, rq[1]!, rq[2]!, rq[3]!], [home[3 * b]!, home[3 * b + 1]!, home[3 * b + 2]!]));
      }
      out.push({ down, standing, met: r.session.objectiveDone, steps: r.steps });
      if (spec.kind !== 'ref') d.engine.dispose();
    }
  } finally { e.dispose(); }
  return out;
}

async function fresh(spec: EngineSpec, c: CompiledLevel): Promise<Driver> {
  const d = new Driver(makeEngine(spec), c);
  await d.reset();
  return d;
}

/** Each tower's top body in site order (crowns and heritage bodies, by body id) and the height under which it is down (m). */
export function siteTops(c: CompiledLevel): { body: number; line: number }[] {
  const tops = [...c.meta.crowns, ...c.meta.heritage].sort((a, b) => a - b);
  return tops.map((b) => ({ body: b, line: c.meta.crowns.includes(b) ? c.def.crownLine * c.frame.unit : (c.meta.home[3 * b + 1]! + c.meta.half[3 * b + 1]!) / 2 }));
}

// ---- Stage 1: threshold curves ----

/** A single-tower level for its threshold curve: the tower at the origin, its top a crown with the line at half its height. */
export function towerLevel(tower: string): LevelDef {
  const t = parseTower(tower), n = towerHeight(t), grow = n + 2;
  return {
    id: `T-${tower}`, name: tower, version: 1, world: 7, parts: towerParts(t, [0, 0], 'crown'), lot: { min: [-grow, -grow], max: [grow + t.w, grow + t.w] },
    crownLine: (n - 0.5) / 2, objective: { kind: 'crowns' }, par: 1, rack: [QUAKE], scoring: 'outcome', heritage: 'standing', launcher: { radius: grow - 1, y: 1, dropY: n + 4 },
  };
}

export interface CurvePoint { peak: number; down: number; standing: number; n: number }
export interface TowerCurve { tower: string; hz: number; sec: number; axis: number; points: CurvePoint[]; downAt: number | null; holdsTo: number | null }

/**
 * The tower's curve at (hz, sec, axis): every peak in `peaks` on every build. downAt: the lowest peak from which it
 * is down on at least 90% of builds at that peak and every peak above it tested; holdsTo: the highest peak up to
 * which it stands on at least 90% of builds at every peak tested. Null when there is none.
 */
export async function towerCurve(tower: string, hz: number, sec: number, axis: number, peaks: readonly number[], nudges: readonly number[], spec: EngineSpec = { kind: 'ref' }): Promise<TowerCurve> {
  const level = towerLevel(tower), quakes = peaks.map((p) => quake(p, hz, sec, axis));
  const ends = await Promise.all(nudges.map((n) => playQuakes(level, quakes, n, spec)));
  const points = peaks.map((peak, k): CurvePoint => ({ peak, n: nudges.length, down: mean(ends.map((e) => (e[k]!.down[0] ? 1 : 0))), standing: mean(ends.map((e) => (e[k]!.standing[0] ? 1 : 0))) }));
  return { tower, hz, sec, axis, points, ...curveMarks(points) };
}

/** downAt and holdsTo of a curve (towerCurve). */
export function curveMarks(points: readonly CurvePoint[]): { downAt: number | null; holdsTo: number | null } {
  let downAt: number | null = null, holdsTo: number | null = null;
  for (let k = points.length - 1; k >= 0 && points[k]!.down >= 0.9; k--) downAt = points[k]!.peak;
  for (let k = 0; k < points.length && points[k]!.standing >= 0.9; k++) holdsTo = points[k]!.peak;
  return { downAt, holdsTo };
}

// ---- Stage 2: levels and the gate ----

const mean = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
const sdOf = (xs: readonly number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

/** A quake's statistics over builds: tower score (the share of towers judged right: condemned down, protected standing), objective met, energy. */
export interface QuakeStats { name: string; shot: QuakeShot; n: number; score: number; sd: number; se: number; met: number; energy: number }

/** Per-quake statistics over builds: ends[build][quake]; roles[i] is tower i's class. */
export function quakeStats(c: CompiledLevel, quakes: readonly QuakeShot[], ends: readonly QuakeEnd[][]): QuakeStats[] {
  const roles = siteTops(c).map((t) => (c.meta.crowns.includes(t.body) ? 'condemned' : 'protected'));
  return quakes.map((q, k) => {
    const scores = ends.map((row) => { const e = row[k]!; return mean(roles.map((r, i) => (r === 'condemned' ? (e.down[i] ? 1 : 0) : e.standing[i] ? 1 : 0))); });
    const sd = sdOf(scores);
    return { name: quakeName(q), shot: q, n: ends.length, score: mean(scores), sd, se: sd / Math.sqrt(ends.length), met: mean(ends.map((row) => (row[k]!.met ? 1 : 0))), energy: quakeEnergy(c, q) };
  });
}

/** The gate's rule, in numbers. */
export const QUAKE_GATE = { diff: 0.1, z: 3, fair: 0.8, naiveMax: 0.2 } as const;
/** Standard errors a zero-spread pair is treated as having (as Fuse & Fold's gate): one build's float noise. */
export const SE_FLOOR = 1e-3;

export interface QuakeGate { pass: boolean; best: QuakeStats; naive: QuakeStats; diff: number; z: number; detail: string }

/** The choice-matters gate over a level's confirmed quakes (the first is the naive one). The best: met most often, then score, then least energy. */
export function quakeGate(stats: readonly QuakeStats[]): QuakeGate {
  const naive = stats[0]!;
  const best = [...stats.slice(1)].sort((a, b) => b.met - a.met || b.score - a.score || a.energy - b.energy)[0] ?? naive;
  const diff = best.score - naive.score, z = diff / Math.max(SE_FLOOR, Math.hypot(best.se, naive.se));
  const pass = diff >= QUAKE_GATE.diff - 1e-9 && z > QUAKE_GATE.z && best.met >= QUAKE_GATE.fair && naive.met <= QUAKE_GATE.naiveMax;
  return { pass, best, naive, diff, z, detail: `best ${best.name} meets ${(100 * best.met).toFixed(0)}% (towers ${best.score.toFixed(3)}) vs naive ${naive.name} ${(100 * naive.met).toFixed(0)}% (${naive.score.toFixed(3)}): +${diff.toFixed(3)}, ${z > 1e3 ? '>1000' : z.toFixed(1)} SE` };
}

/** A grid of quakes: every combination, axes last. */
export function quakeGrid(g: { peaks: readonly number[]; hz: readonly number[]; sec: readonly number[]; axes: readonly number[] }): QuakeShot[] {
  const out: QuakeShot[] = [];
  for (const hz of g.hz) for (const sec of g.sec) for (const axis of g.axes) for (const peak of g.peaks) out.push(quake(peak, hz, sec, axis));
  return out;
}

/** Quakes on one nudged build; `level`: a build of its own (a retrofit's bracing), else the pool's level. */
export interface QuakeTask { quakes: readonly QuakeShot[]; nudge: number; level?: LevelDef }

/** Plays tasks on a pool of `jobs` worker threads (1: in this thread); results in task order. */
export async function playQuakeTasks(level: LevelDef, tasks: readonly QuakeTask[], jobs: number, spec: EngineSpec = { kind: 'ref' }, log?: (line: string) => void): Promise<QuakeEnd[][]> {
  const out: QuakeEnd[][] = new Array(tasks.length);
  if (jobs <= 1) {
    for (let k = 0; k < tasks.length; k++) { out[k] = await playQuakes(tasks[k]!.level ?? level, tasks[k]!.quakes, tasks[k]!.nudge, spec); log?.(`  ${k + 1}/${tasks.length}`); }
    return out;
  }
  const { Worker } = await import('node:worker_threads');
  let next = 0, done = 0;
  const run = async () => {
    const w = new Worker(new URL('./boot.mjs', import.meta.url), { workerData: { entry: new URL('./quake-worker.ts', import.meta.url).href, spec } });
    try {
      while (next < tasks.length) {
        const id = next++, t = tasks[id]!;
        out[id] = await new Promise<QuakeEnd[]>((resolve, reject) => {
          const onMsg = (m: { id: number; result?: QuakeEnd[]; error?: string }) => { w.off('error', onErr); if (m.error) reject(new Error(m.error)); else resolve(m.result!); };
          const onErr = (e: unknown) => { w.off('message', onMsg); reject(e); };
          w.once('message', onMsg);
          w.once('error', onErr);
          w.postMessage({ id, level: t.level ?? level, quakes: t.quakes, nudge: t.nudge });
        });
        log?.(`  ${++done}/${tasks.length}`);
      }
    } finally { await w.terminate(); }
  };
  await Promise.all(Array.from({ length: Math.min(jobs, tasks.length) }, run));
  return out;
}

/** Splits quakes on one build into about `parts` tasks (so a pool stays busy on a single build). */
function split(quakes: readonly QuakeShot[], nudge: number, parts: number): { tasks: QuakeTask[]; idx: number[][] } {
  const tasks: QuakeTask[] = [], idx: number[][] = [];
  for (let k = 0; k < parts; k++) { const ix = quakes.map((_, i) => i).filter((i) => i % parts === k); if (ix.length) { tasks.push({ quakes: ix.map((i) => quakes[i]!), nudge }); idx.push(ix); } }
  return { tasks, idx };
}

export interface QuakeSearchResult { level: string; hash: string; bodies: number; screen: QuakeStats[]; confirm: QuakeStats[]; gate: QuakeGate; wallS: number }
export interface QuakeSearchOptions { screenNudges?: number[]; confirmNudges?: number[]; keep?: number; jobs?: number; spec?: EngineSpec; log?: (l: string) => void }

/**
 * The two-stage search on one level: the naive quake and `grid` on the screen builds, then the naive quake and the
 * best `keep` (met most often, then tower score, then least energy) on the confirm builds, and the gate over those.
 */
export async function searchQuakeLevel(level: LevelDef, grid: readonly QuakeShot[], o: QuakeSearchOptions = {}): Promise<QuakeSearchResult> {
  const t0 = performance.now(), c = compileLevel(level), spec = o.spec ?? { kind: 'ref' as const }, jobs = o.jobs ?? 1;
  const naive = naiveQuake(c), seen = new Set([writeShots([naive])]);
  const quakes = [naive, ...grid.filter((q) => { const k = writeShots([q]); if (seen.has(k)) return false; seen.add(k); return true; })];
  const sn = o.screenNudges ?? [1], cn = o.confirmNudges ?? [1, 2, 3, 4, 5, 6, 7, 8];
  o.log?.(`${level.id}: screening ${quakes.length} quakes on ${sn.length} build(s)`);
  const screenEnds: QuakeEnd[][] = [];
  for (const n of sn) {
    const { tasks, idx } = split(quakes, n, jobs), parts = await playQuakeTasks(level, tasks, jobs, spec, o.log);
    const row = new Array<QuakeEnd>(quakes.length);
    parts.forEach((p, t) => idx[t]!.forEach((i, j) => { row[i] = p[j]!; }));
    screenEnds.push(row);
  }
  const screen = quakeStats(c, quakes, screenEnds);
  const ranked = screen.map((s, i) => ({ s, i })).slice(1).sort((a, b) => b.s.met - a.s.met || b.s.score - a.s.score || a.s.energy - b.s.energy);
  const keep = [quakes[0]!, ...ranked.slice(0, o.keep ?? 4).map((x) => quakes[x.i]!)];
  o.log?.(`${level.id}: confirming ${keep.length} quakes on ${cn.length} builds`);
  const confirmEnds = await playQuakeTasks(level, cn.map((n) => ({ quakes: keep, nudge: n })), jobs, spec, o.log);
  const confirm = quakeStats(c, keep, confirmEnds);
  return { level: level.id, hash: c.hash, bodies: c.meta.n, screen, confirm, gate: quakeGate(confirm), wallS: (performance.now() - t0) / 1000 };
}


/** x rounded up to two significant figures: a star line or a budget a little easier than the measured number. */
export function roundUp2(x: number): number {
  if (!(x > 0)) return x;
  const p = 10 ** (Math.floor(Math.log10(x)) - 1);
  return Math.ceil(x / p - 1e-9) * p;
}

/** Room left above the best quake's energy for its third star: the dial is discrete, so a tenth. */
export const T3_SLACK = 1.1;
/** A level's budget over its two-star line: room to explore, none for the brute end of the dial. */
export const BUDGET_OVER_T2 = 4;

/**
 * A searched level's stars, cast on the energy metric (lower is better), and its budget: three stars at the cheapest
 * confirmed quake (met on at least QUAKE_GATE.fair of the builds) with T3_SLACK; two at the median energy of the grid
 * quakes that met the objective on the screen; one for meeting it at all. The budget is BUDGET_OVER_T2 times the
 * two-star line. All rounded up to two figures. Energy is the shot's (quakeEnergy), so the lines read the same on
 * every engine; only whether a quake meets the objective comes from the physics. Null when the gate failed.
 */
export function quakeStars(r: QuakeSearchResult): { t2: number; t3: number; best: number; budget: number; n: number } | null {
  if (!r.gate.pass) return null;
  const best = Math.min(...r.confirm.slice(1).filter((s) => s.met >= QUAKE_GATE.fair).map((s) => s.energy));
  const met = r.screen.slice(1).filter((s) => s.met > 0).map((s) => s.energy).sort((a, b) => a - b);
  const mid = met.length % 2 ? met[(met.length - 1) / 2]! : (met[met.length / 2 - 1]! + met[met.length / 2]!) / 2;
  const t3 = roundUp2(best * T3_SLACK), t2 = Math.max(t3, roundUp2(mid));
  return { t2, t3, best, budget: roundUp2(BUDGET_OVER_T2 * t2), n: r.screen.length - 1 };
}

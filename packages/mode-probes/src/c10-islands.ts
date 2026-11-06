// C10's verify: many worlds in one solve, run through the primitive itself
// (engine-api islands.ts and island-observer.ts), not hand-placed as X8 did.
//
// The level and its jittered shots are X8's (x8-islands.ts world()): a block of
// 0.5 m plaster cubes struck at mid-height by the cannonball, shot k and block k
// jittered from seed k. Two arms:
//   islands  the K worlds packed by Islands (island 0 at the origin, square
//            rings around it, the gap from the worlds' footprint plus the
//            default reach), every shot released by the id map (pack());
//   solo     each world alone at the origin, as a cast runs today.
// Per world, 4 s after the shot (1.5 s at CI size): down, the share of cubes
// more than one cell below where they stood just before the shot, and moved,
// the share whose centre moved more than 0.1 m. Each is read twice from the
// islands run: from the world's own snapshot (Islands.local, f64, the rule's
// numbers) and from one per-island histogram per question (reduceIslands, the
// observer's integer arithmetic at 2^-16 and 2^-15 m), which must agree.
// The rule (nodes.json C10): the islands' down and moved distributions match
// the solo runs' (two-sample KS, p > 0.05); cost per body within 10 % of a
// solo 9.6k scene (the 40 x 40 x 6 block), read only off a Metal run. Also
// checked: no body leaves its island's cell at any sample (Islands.leaks).
// A diagnostic: island 0 sits at the origin, so it and solo world 0 start from
// the same f32 coordinates and differ only by sharing the solve.
import { type Pred, Islands, reduceIslands, type Snapshot, type Vec3 } from '@tb/engine-api';
import { GAME_PARAMS, gameScene, ks2 } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';
import { CELL, type Level, SHOT_STEP, world } from './x8-islands.ts';

export type C10Arm = 'islands' | 'solo' | 'block';
export interface C10Case { arm: C10Arm; level: Level; K: number; world: number; presettle: number; readAfter: number }

const scale = { down: 16, moved: 15 } as const;
/** The rule's two questions as observer predicates on the displacement from ref slot 0 (the pose just before the shot). */
export const C10_PREDS: readonly Pred[] = [
  { cmp: { comp: { disp: 0 }, axis: 1, s: scale.down }, op: '<', k: -CELL * 2 ** scale.down },
  { cmp: { norm2: { disp: 0 }, s: scale.moved }, op: '>', k: Math.floor((0.1 * 2 ** scale.moved) ** 2) },
];

/** World k of the case as its own scene, at the origin. */
export function c10World(c: Pick<C10Case, 'level' | 'presettle'>, k: number) {
  const w = world(c.level, k, [0, 0, 0], c.presettle);
  return gameScene(`C10-${k}`, { W: c.level.W, D: c.level.D, H: c.level.H, world: k }, w.bodies, [w.shot]);
}

/** The case's islands (islands arm): K worlds packed with every shot released. */
export function c10Islands(c: C10Case): Islands {
  return new Islands(Array.from({ length: c.K }, (_, k) => c10World(c, k)));
}

const shotAt = (c: C10Case) => c.presettle + SHOT_STEP;

export function c10Spec(c: C10Case): RunSpec {
  const scene = c.arm === 'islands' ? c10Islands(c).pack()
    : c.arm === 'solo' ? c10World(c, c.world)
    : gameScene('C10-block', { W: 40, D: 40, H: 6 }, world({ W: 40, D: 40, H: 6 }, 0, [0, 0, 0], c.presettle).bodies);
  const n = scene.bodies.length + scene.inputs.filter((e) => e.kind === 'spawn').length;
  const steps = c.arm === 'block' ? c.presettle + 300 : shotAt(c) + c.readAfter;
  return { scene: { ...scene, id: `C10-${c.arm}` }, steps, params: GAME_PARAMS, opts: { capacity: n, pairsPerBody: 24, boxBroadphase: true } };
}

export interface C10World {
  world: number; down: number; moved: number;
  /** The block's centroid, relative to its island's offset (m). */
  centroid: Vec3;
}
export interface C10Result {
  worlds: C10World[];
  bodies: number;
  stepMs: number;
  /** Islands arm: the gap, the farthest island offset from the origin (m), bodies seen outside their cell (summed over samples), worlds whose observer counts differ from the snapshot's, and bodies the observer read as ⊥ (the shots: no ref pose). */
  gap?: number; farthest?: number; leaks?: number; disagree?: number; invalid?: number;
}

function c10Meter(c: C10Case, spec: RunSpec): Meter<C10Result> {
  const perWorld = c.level.W * c.level.D * c.level.H, at = shotAt(c);
  const isl = c.arm === 'islands' ? c10Islands(c) : null;
  if (isl) isl.pack();
  let start: Float64Array | null = null, t0 = 0, s0 = 0, stepMs = NaN, leaks = 0, disagree = 0, invalid = 0;
  let worlds: C10World[] = [];
  const outcome = (k: number, s: Snapshot, p0: Float64Array): C10World => {
    // Island k's cubes are its first perWorld local bodies; solo: the scene's first perWorld bodies.
    const ids = isl ? isl.idsOf(k).slice(0, perWorld) : Array.from({ length: perWorld }, (_, i) => i), o: Vec3 = isl ? isl.offsets[k]! as Vec3 : [0, 0, 0];
    let down = 0, moved = 0;
    const centroid: Vec3 = [0, 0, 0];
    for (const i of ids) {
      for (let a = 0; a < 3; a++) centroid[a] = centroid[a]! + (s.pos[3 * i + a]! - o[a]!) / perWorld;
      if (p0[3 * i + 1]! - s.pos[3 * i + 1]! > CELL) down++;
      if (Math.hypot(s.pos[3 * i]! - p0[3 * i]!, s.pos[3 * i + 1]! - p0[3 * i + 1]!, s.pos[3 * i + 2]! - p0[3 * i + 2]!) > 0.1) moved++;
    }
    return { world: c.arm === 'islands' ? k : c.world, down: down / perWorld, moved: moved / perWorld, centroid };
  };
  return {
    every: 30,
    sample(step, s: Snapshot) {
      if (isl) leaks += isl.leaks(s).length;
      // The pose just before the shot (after the pre-settle) is the one outcomes are measured from.
      if (step >= at - 30 && !start) { start = s.pos.slice(0, 3 * s.count); t0 = performance.now(); s0 = step; }
      if (step < spec.steps) return;
      stepMs = (performance.now() - t0) / Math.max(1, step - s0);
      if (c.arm === 'block' || !start) return;
      const p0 = start;
      if (!isl) { worlds = [outcome(0, s, p0)]; return; }
      worlds = Array.from({ length: c.K }, (_, k) => outcome(k, s, p0));
      const r = reduceIslands(isl, s, C10_PREDS, { refs: [p0] });
      invalid = r.invalid[0]!;
      disagree = worlds.filter((w, k) => r.counts[0]![k] !== Math.round(w.down * perWorld) || r.counts[1]![k] !== Math.round(w.moved * perWorld)).length;
    },
    result: () => ({
      worlds, bodies: spec.scene.bodies.length, stepMs,
      ...(isl ? { gap: isl.gap, farthest: Math.max(...isl.offsets.map((o) => Math.max(Math.abs(o[0]), Math.abs(o[2])))), leaks, disagree, invalid } : {}),
    }),
  };
}

const LEVELS: Record<Size, { level: Level; K: number; presettle: number; readAfter: number }> = {
  ci: { level: { W: 3, D: 3, H: 4 }, K: 8, presettle: 30, readAfter: 90 },
  full: { level: { W: 5, D: 5, H: 6 }, K: 64, presettle: 300, readAfter: 240 },
};

function c10Cases(size: Size): C10Case[] {
  const { level, K, presettle, readAfter } = LEVELS[size];
  const out: C10Case[] = [{ arm: 'islands', level, K, world: -1, presettle, readAfter }];
  for (let k = 0; k < K; k++) out.push({ arm: 'solo', level, K, world: k, presettle, readAfter });
  if (size === 'full') out.push({ arm: 'block', level, K, world: -1, presettle, readAfter });
  return out;
}

function c10Verdict(runs: CaseRun<C10Case, C10Result>[], size: Size): Verdict {
  const { K } = LEVELS[size], table: string[] = [], checks: Check[] = [];
  const isRun = runs.find((r) => r.c.arm === 'islands'), block = runs.find((r) => r.c.arm === 'block');
  const isl = isRun?.result.worlds ?? [], solo = runs.filter((r) => r.c.arm === 'solo').flatMap((r) => r.result.worlds).sort((a, b) => a.world - b.world);
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  table.push('| arm | worlds | down mean | moved mean |', '|---|---|---|---|');
  for (const [name, xs] of [['islands', isl], ['solo', solo]] as const) table.push(`| ${name} | ${xs.length} | ${mean(xs.map((o) => o.down)).toFixed(3)} | ${mean(xs.map((o) => o.moved)).toFixed(3)} |`);
  let ok = true;
  for (const m of ['down', 'moved'] as const) {
    const t = ks2(isl.map((o) => o[m]), solo.map((o) => o[m])), pass = t.p > 0.05;
    ok &&= pass;
    checks.push({ name: `islands vs solo: the ${m} distributions agree (KS p > 0.05)`, pass, detail: `D ${t.D.toFixed(3)}, p ${t.p.toFixed(3)}, ${isl.length} vs ${solo.length} worlds` });
  }
  const r = isRun?.result;
  if (r) {
    checks.push({ name: 'no body left its island\'s cell (every sample)', pass: r.leaks === 0, detail: `${r.leaks} body-samples outside; gap ${r.gap} m, farthest island ${r.farthest} m from the origin` });
    checks.push({ name: 'per-island observer counts equal each world\'s own snapshot counts', pass: r.disagree === 0, detail: `${r.disagree} of ${isl.length} worlds differ; ${r.invalid} bodies read as no-value (the ${K} shots, which have no pose before the shot)` });
    ok &&= r.leaks === 0 && r.disagree === 0;
  }
  const w0 = isl.find((o) => o.world === 0), s0 = solo.find((o) => o.world === 0);
  if (w0 && s0) {
    const d = Math.hypot(w0.centroid[0] - s0.centroid[0], w0.centroid[1] - s0.centroid[1], w0.centroid[2] - s0.centroid[2]);
    checks.push({ name: '(diagnostic) island 0 and solo world 0 start from the same coordinates: centroid shift', pass: true, detail: `${d.toExponential(2)} m; down ${w0.down.toFixed(3)} vs ${s0.down.toFixed(3)}, moved ${w0.moved.toFixed(3)} vs ${s0.moved.toFixed(3)}` });
  }
  table.push('', '| timing (Metal only; SwiftShader times are not results) | bodies | ms per step | us per body-step |', '|---|---|---|---|');
  for (const x of [isRun, block].filter(Boolean) as CaseRun<C10Case, C10Result>[]) table.push(`| ${x.c.arm} | ${x.result.bodies} | ${x.result.stepMs.toFixed(2)} | ${((1000 * x.result.stepMs) / x.result.bodies).toFixed(3)} |`);
  if (isRun && block) {
    const ratio = (isRun.result.stepMs / isRun.result.bodies) / (block.result.stepMs / block.result.bodies);
    checks.push({ name: '(reported; decided on Metal only) islands cost per body within 10% of the 9.6k block', pass: ratio <= 1.1, detail: `ratio ${ratio.toFixed(3)}` });
  }
  checks.push({ name: 'every world was read', pass: isl.length === K && solo.length === K, detail: `${isl.length} / ${solo.length}` });
  const limits = runs.every((x) => x.limits.length === 0);
  checks.push({ name: 'no engine limit hit', pass: limits, detail: runs.flatMap((x) => x.limits)[0] ?? 'none' });
  return { pass: size === 'full' ? ok && limits && isl.length === K && solo.length === K : null, checks, table };
}

export const C10: Probe<C10Case, C10Result> = {
  id: 'C10',
  title: 'Many worlds in one solve (the C10 primitive)',
  question: 'Do K worlds packed by Islands, read per island, give the same outcome distributions as K solo runs, at the cost per body of one big scene?',
  rule: 'Outcome distributions match (two-sample KS, p > 0.05, on down and moved); per-island observer counts equal per-world snapshot counts; no leaks; cost per body within 10% of a solo 9.6k scene (read off a Metal run only).',
  cases: c10Cases,
  label: (c) => (c.arm === 'islands' ? `islands x${c.K}` : c.arm === 'block' ? 'block 9.6k' : `solo world ${c.world}`),
  spec: c10Spec,
  meter: c10Meter,
  verdict: c10Verdict,
};

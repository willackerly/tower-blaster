// The GPU sleep differential (engine-sleep-diff-*.test.ts; sleep.ts, roadmap E2): with sleep on, a collapse moves
// and breaks as many cubes as with it off, judged against the all-awake run's own chaotic spread (the CPU tier's
// method, @tb/lattice compare.ts): each scene runs 4 times, the k-th with its impact 1% x k stronger, with sleep off
// and on. One scene per test file, each about 3 minutes on SwiftShader.
import { expect } from 'vitest';
import type { InputEvent, SceneDesc, Snapshot } from '@tb/engine-api';
import { compare, compareBonds } from '@tb/lattice';
import { toSnap } from './harness.ts';
import { run, SLEEP } from './sleep-case.ts';

const RUNS = 4;
const PARAMS = { iterations: 20 };

/** The scene with its k-th impact: spawned bodies' velocities and blast impulses scaled by 1 + 0.01 k. */
function nudged(scene: SceneDesc, k: number): SceneDesc {
  const inputs: InputEvent[] = scene.inputs.map((ev) => {
    if (ev.kind === 'spawn') return { ...ev, body: { ...ev.body, linVel: ev.body.linVel.map((v) => v * (1 + 0.01 * k)) as [number, number, number] } };
    if (ev.kind === 'blast') return { ...ev, blast: { ...ev.blast, impulse: ev.blast.impulse * (1 + 0.01 * k) } };
    return ev;
  });
  return { ...scene, inputs };
}

/** The final state of each run; with sleep, each run is checked to have most of its bodies asleep at `impact`. */
async function finals(scene: SceneDesc, steps: number, sleep: boolean, impact: number): Promise<Snapshot[]> {
  const out: Snapshot[] = [];
  for (let k = 0; k < RUNS; k++) {
    const r = await run(nudged(scene, k), steps, sleep ? SLEEP : {}, impact, PARAMS);
    const before = r.snaps.find((s) => s.step === impact)!;
    const asleep = before.awake!.filter((a) => a === 0).length;
    if (sleep) expect(asleep, `${scene.id} run ${k}: asleep at step ${impact}`).toBeGreaterThan(0.9 * scene.bodies.length);
    else expect(asleep).toBe(0);
    out.push(toSnap(r.snaps.at(-1)!));
  }
  return out;
}

/** Moved and broken cubes of each run, and each run's moved-set Jaccard index against the first all-awake run. */
function outcomes(scene: SceneDesc, ref0: Snapshot, runs: Snapshot[]) {
  return runs.map((s) => {
    const c = compare(scene, ref0, s), b = compareBonds(scene, ref0, s);
    return { moved: c.movedTest, broken: b.brokenTest, jaccard: c.jaccard };
  });
}

/** Runs and judges the scene; `impact` is the step its impact is due (the sleep runs must be asleep by then). */
export async function differential(scene: SceneDesc, steps: number, impact: number) {
  const off = await finals(scene, steps, false, impact), on = await finals(scene, steps, true, impact);
  const a = outcomes(scene, off[0]!, off), b = outcomes(scene, off[0]!, on);
  console.log(`${scene.id}: awake ${JSON.stringify(a)}\n${scene.id}: sleep ${JSON.stringify(b)}`);
  // Within the all-awake spread: each sleep-on count lies in the range of the all-awake runs, widened by a fifth of
  // that range's top (and 2 cubes) for a spread of 4 runs; its overlap with the first run is no worse than theirs
  // by more than 0.1.
  for (const key of ['moved', 'broken'] as const) {
    const lo = Math.min(...a.map((x) => x[key])), hi = Math.max(...a.map((x) => x[key]));
    const slack = 0.2 * hi + 2;
    for (const x of b) expect(x[key], `${scene.id} ${key}: awake ${lo}-${hi}`).toBeGreaterThanOrEqual(lo - slack);
    for (const x of b) expect(x[key], `${scene.id} ${key}: awake ${lo}-${hi}`).toBeLessThanOrEqual(hi + slack);
  }
  const worst = Math.min(...a.slice(1).map((x) => x.jaccard));
  for (const x of b) expect(x.jaccard, `${scene.id} jaccard: awake runs ${worst}`).toBeGreaterThanOrEqual(worst - 0.1);
  return { a, b };
}


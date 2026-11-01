// Settle (GpuEngineOptions.settleSteps / settleIterations; roadmap E2 step 2b): the first settleSteps steps solve at
// settleIterations, the rest at AvbdParams.iterations. A tower that stands only at many iterations settles at them
// and falls asleep; what wakes it later collapses at the game's count.
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { gpu } from './harness.ts';
import type { PlainSnapshot } from './page.ts';
import { asleep, at, run, SLEEP } from './sleep-case.ts';

const state = (s: PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];

describe('GPU settle iterations', () => {
  it('runs its first settleSteps steps bit-identical to an engine at settleIterations, and the rest at AvbdParams.iterations', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A ball into a small wall: contacts from step 0, and a hit at step 15 that the iteration count shapes.
    const scene = buildScenario('S5', { N: 24, F: 1, H: 4, street: 2, fireStep: 15, radius: 0.6, speed: 15 }, 1);
    const K = 20, steps = 40;
    const settled = await run(scene, steps, { settleSteps: K, settleIterations: 12 }, 1, { iterations: 4 });
    const at12 = await run(scene, steps, {}, 1, { iterations: 12 });
    const at4 = await run(scene, steps, {}, 1, { iterations: 4 });
    // snaps[k] is after step k: steps 0 .. K - 1 ran at 12.
    for (let k = 0; k < K; k++) expect(state(settled.snaps[k]!), `step ${k}`).toEqual(state(at12.snaps[k]!));
    // From step K it runs at 4 from the 12-iteration state, so it leaves both the 12- and the 4-iteration runs.
    const last = settled.snaps.at(-1)!;
    expect(state(last)).not.toEqual(state(at12.snaps.at(-1)!));
    expect(state(last)).not.toEqual(state(at4.snaps.at(-1)!));
    // A settle at the run's own count, or of no steps, changes nothing.
    const same = await run(scene, steps, { settleSteps: K, settleIterations: 4 }, 1, { iterations: 4 });
    const none = await run(scene, steps, { settleSteps: 0, settleIterations: 12 }, 1, { iterations: 4 });
    expect(state(same.snaps.at(-1)!)).toEqual(state(at4.snaps.at(-1)!));
    expect(state(none.snaps.at(-1)!)).toEqual(state(at4.snaps.at(-1)!));
  });

  it('settles with sleep: a resting city sleeps whole after a settle at more iterations, as without it', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const city = buildScenario('S14', { towers: 2, W: 2, D: 2, H: 3, street: 3 }, 1);
    const r = await run({ ...city, sleep: true }, 70, { ...SLEEP, settleSteps: 40, settleIterations: 20 }, 10);
    expect(asleep(at(r.snaps, 70))).toBe(city.bodies.length);
  });
});

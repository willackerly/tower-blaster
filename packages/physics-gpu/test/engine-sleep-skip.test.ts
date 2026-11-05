// The all-asleep skip (GpuEngineOptions.sleepSkip; roadmap E2 step 3a): once a step ends with no body awake, every
// step after it changes nothing until an input arrives, so step() skips it. Exact: each run here is compared step by
// step, bit for bit, with the same run at sleepSkip false (every step run), and must have skipped steps.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { cube, gpu, sceneOf } from './harness.ts';
import type { PlainSnapshot } from './page.ts';
import { asleep, at, run, SLEEP, sleepy } from './sleep-case.ts';

const state = (s: PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel, s.awake, s.tier];

async function same(scene: SceneDesc, steps: number, opts = SLEEP, params: Record<string, number> = { iterations: 8 }) {
  const skip = await run(scene, steps, opts, 1, params), all = await run(scene, steps, { ...opts, sleepSkip: false }, 1, params);
  expect(skip.snaps.length).toBe(all.snaps.length);
  skip.snaps.forEach((s, k) => expect(state(s), `step ${s.step}`).toEqual(state(all.snaps[k]!)));
  expect(all.final.sleepSkippedSteps).toBe(0);
  return { skip, all, skipped: skip.final.sleepSkippedSteps };
}

describe('GPU sleep: skipping steps while nothing is awake', () => {
  it('skips a sleeping city\'s steps, and a blast wakes it exactly as in the run that ran every step', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const city = buildScenario('S14', { towers: 2, W: 2, D: 2, H: 3, street: 3 }, 1);
    const p0 = city.bodies[0]!.pos;
    const { skip, skipped } = await same(sleepy(city, [{ step: 90, kind: 'blast', blast: { centre: [p0[0] - 0.6, 0.5, p0[2]], radius: 1.2, impulse: 2 } }]), 130);
    // Asleep by step 60 (engine-sleep.test.ts), so steps from a little after it to 89 are skippable.
    expect(asleep(at(skip.snaps, 89))).toBe(city.bodies.length);
    expect(skipped).toBeGreaterThan(15);
    expect(asleep(at(skip.snaps, 91))).toBeLessThan(city.bodies.length);
  });

  it('a body spawned onto sleepers, a removal and a settle run as without skipping', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const quiet = sleepy(sceneOf([cube([0, 0.5, 0]), cube([3, 0.5, 0]), cube([3, 1.5, 0])]), [
      { step: 60, kind: 'spawn', body: cube([0, 1.5, 0]) },
      { step: 130, kind: 'remove', id: 1 },
    ]);
    const { skipped } = await same(quiet, 170, { ...SLEEP, settleSteps: 20, settleIterations: 16 });
    expect(skipped).toBeGreaterThan(20);
  });

  it('never skips without sleep, or while a body is awake', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await run(sceneOf([cube([0, 0.5, 0])]), 80, {});
    expect(off.final.sleepSkippedSteps).toBe(0);
    // A cube gliding on frictionless ground never sleeps (engine-sleep.test.ts), so nothing is skipped beside it.
    const glider = { ...cube([5, 0.5, 0], [0.04, 0, 0]), friction: 0 };
    const r = await run({ ...sleepy(sceneOf([cube([0, 0.5, 0]), glider])), ground: { y: 0, friction: 0 } }, 120, SLEEP);
    expect(r.snaps.at(-1)!.awake).toEqual([0, 1]);
    expect(r.final.sleepSkippedSteps).toBe(0);
  });
});

// Bodies that start asleep (engine-api asleep.ts, roadmap C22) on the GPU engine: the shared case of @tb/testkit's
// asleep.ts. With sleep they are sleepers from step 0 (flags 0, the sleep state of a body that fell asleep there),
// each woken only when the wave reaches it; without sleep (the engine's or the scene's) they run awake.
import { describe, expect, it } from 'vitest';
import { ASLEEP_CASE, asleepFailures, asleepReport, asleepScene } from '@tb/testkit';
import { call, gpu, toSnap } from './harness.ts';

const KEYSTONE = { iterations: 40, gapSlop: 3e-5 };

describe('GPU AVBD engine: bodies that start asleep', () => {
  it('with sleep: asleep and bit for bit still until the wave reaches each one; the far one never wakes; a spin given asleep is ignored', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('simulateGpu', asleepScene(true, true, true), ASLEEP_CASE.end, KEYSTONE, 1, { sleep: true });
    expect(r.error).toBeNull();
    const rep = asleepReport(r.snaps.map(toSnap));
    console.log(`asleep on GPU: woke at ${rep.wokeAt.join(' ')}; reached at ${rep.reachedAt.join(' ')}; fell at ${rep.fallenAt.join(' ')}`);
    expect(asleepFailures(rep, true)).toEqual([]);
  });

  it('without sleep (engine option off, or the scene\'s) they run awake and stand until the push', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const [sceneSleep, engineSleep] of [[true, false], [false, true]] as const) {
      const r = await call('simulateGpu', asleepScene(true, sceneSleep), ASLEEP_CASE.end, KEYSTONE, 1, { sleep: engineSleep });
      expect(r.error).toBeNull();
      expect(asleepFailures(asleepReport(r.snaps.map(toSnap)), false)).toEqual([]);
    }
  });
});

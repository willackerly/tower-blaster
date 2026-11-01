// Removals (engine-api remove.ts) on the GPU engine: the shared cases of @tb/testkit's remove.ts in f32.
import { describe, expect, it } from 'vitest';
import { REMOVE_CASE, removeErrors, removeScene, STACK_CASE, stackScene } from '@tb/testkit';
import { gpu, runGpu } from './harness.ts';

describe('GPU AVBD engine: removals', () => {
  it('takes removed bodies out where they were, at rest and tier free, and leaves every other body bit for bit as it was', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const base = await runGpu(removeScene(false), REMOVE_CASE.end, {}, 1), removed = await runGpu(removeScene(true), REMOVE_CASE.end, {}, 1);
    expect(base.all[REMOVE_CASE.end]!.tier).toBeUndefined();
    const r = removeErrors(base.all, removed.all);
    expect(r.badTiers).toEqual([]);
    expect(r.kept).toBe(0);
    expect(r.removedMoved).toBeLessThan(1e-6);
    expect(r.removedSpeed).toBe(0);
  });

  it('a cube whose support is removed falls to the ground; the one beside it stands as it stood', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const b = (await runGpu(stackScene(false), STACK_CASE.end)).s1, r = (await runGpu(stackScene(true), STACK_CASE.end)).s1;
    expect(b.pos[4]).toBeCloseTo(1.5, 1);
    expect(r.pos[4]).toBeCloseTo(0.5, 1);
    expect(Math.abs(r.pos[3]!) + Math.abs(r.pos[5]!)).toBeLessThan(0.01);
    expect([...r.pos.subarray(6, 9)]).toEqual([...b.pos.subarray(6, 9)]);
    expect([...r.tier!]).toEqual([255, 0, 0]);
  });
});

// Field events (engine-api field.ts, roadmap C7) on the GPU engine: the shared cases of @tb/testkit's field.ts in f32,
// the wake-all under sleep, and the gravity in force kept by checkpoints.
import { describe, expect, it } from 'vitest';
import { quantiseVec3, type SceneDesc } from '@tb/engine-api';
import { FIELD_CASE, fieldErrors, fieldScene, TILT_CASE, tiltExpected, tiltResult, tiltScene } from '@tb/testkit';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { call, gpu, toSnap } from './harness.ts';

describe('GPU AVBD engine: field events', () => {
  it('free flight follows the gravity schedule and the kicks (f32); pinned and removed bodies are not kicked, a body spawned after a kick is not', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('simulateGpu', fieldScene(), FIELD_CASE.end, {}, 1);
    expect(r.error).toBeNull();
    const e = fieldErrors(r.snaps.map(toSnap), 1);
    // f32 positions near y = 60: a few ulps (4e-6) a step.
    expect(e.pos).toBeLessThan(1e-4);
    expect(e.vel).toBeLessThan(1e-4);
    expect(e.counts.at(-1)).toBe(6);
  });

  it.for([[20, false], [40, false], [20, true], [40, true]] as const)('a cube under gravity tilted %i degrees (sleep %s) sticks below the friction angle and slides at g (sin t - mu cos t) above it, as the reference does', { timeout: 300_000 }, async ([deg, sleep], ctx) => {
    if (!gpu) return ctx.skip();
    const scene = tiltScene(deg, sleep);
    const g = await call('simulateGpu', scene, TILT_CASE.end, {}, TILT_CASE.at, { sleep });
    expect(g.error).toBeNull();
    const at = g.snaps.find((s) => s.step === TILT_CASE.at)!, end = g.snaps.at(-1)!;
    const r = tiltResult(toSnap(at), toSnap(end)), want = tiltExpected(deg);
    // With sleep the cube fell asleep before the tilt, which woke it (it slides, or at 20 degrees settles again).
    expect(r.asleepAtTilt).toBe(sleep);
    if (want === 0) expect(Math.abs(r.slide)).toBeLessThan(0.005);
    else expect(Math.abs(r.slide - want) / want).toBeLessThan(0.05);
    expect(r.across).toBeLessThan(1e-4);
    expect(r.lift).toBeLessThan(0.005);
    // The reference (no sleep) on the same scene: the slides agree within 2% of the analytic one (or 5 mm).
    const e = new AvbdReferenceEngine();
    await e.init({ ...scene, sleep: false });
    for (let i = 0; i < TILT_CASE.at; i++) e.step();
    const x0 = e.snapshot().pos[0]!;
    for (let i = TILT_CASE.at; i < TILT_CASE.end; i++) e.step();
    expect(Math.abs(r.slide - (e.snapshot().pos[0]! - x0))).toBeLessThan(Math.max(0.005, 0.02 * want));
  });

  it('with sleep, a field event that changes gravity wakes every sleeper but the pin; one that repeats it, or a zero kick, wakes none', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const G = quantiseVec3([0, -9.81, 0]), tilt = quantiseVec3([0.5, -9.8, 0]);
    const cube = (pos: [number, number, number], pinned = false) => ({ shape: { kind: 'box' as const, half: [0.5, 0.5, 0.5] as [number, number, number] }, pos, rot: [0, 0, 0, 1] as [number, number, number, number], linVel: [0, 0, 0] as [number, number, number], angVel: [0, 0, 0] as [number, number, number], density: 1, friction: 0.6, restitution: 0, tag: 0, ...(pinned ? { pinned } : {}) });
    const scene: SceneDesc = {
      id: 'field-wake', params: {}, seed: 0, gravity: G, dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: true,
      bodies: [cube([0, 0.5, 0]), cube([0, 1.5, 0]), cube([4, 0.5, 0]), cube([8, 2, 0], true)],
      inputs: [{ step: 150, kind: 'field', gravity: G }, { step: 160, kind: 'field', kick: [0, 0, 0] }, { step: 170, kind: 'field', gravity: tilt }],
    };
    const r = await call('simulateGpu', scene, 175, {}, 5, { sleep: true });
    expect(r.error).toBeNull();
    const awake = (step: number) => r.snaps.find((s) => s.step === step)!.awake!;
    expect(awake(150)).toEqual([0, 0, 0, 0]);
    // Gravity set to its value at 150, a zero kick at 160: nothing wakes.
    expect(awake(155)).toEqual([0, 0, 0, 0]);
    expect(awake(165)).toEqual([0, 0, 0, 0]);
    // A new gravity at 170: every body but the pin, the lone cube included (not touching the stack).
    expect(awake(175)).toEqual([1, 1, 1, 0]);
  });

  it('a checkpoint keeps the gravity in force: restored from before a tilt, the run repeats bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Taken before the tilt (step 50, the tilt at 90), restored once the run has tilted: had the restore kept the tilted
    // gravity, steps 50 to 90 would slide the cube early.
    const r = await call('checkpointReplay', tiltScene(40), TILT_CASE.end, 50);
    expect(r.error).toBeNull();
    expect(r.second.pos).toEqual(r.first.pos);
    expect(r.second.pos[0]).toBeGreaterThan(0.3);
  });
});

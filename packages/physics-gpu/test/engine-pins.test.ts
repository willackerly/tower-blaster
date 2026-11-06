// Pinned bodies (engine-api pinned.ts, roadmap C8; pins.ts) on the GPU engine: the shared cases of @tb/testkit's
// pinned.ts in f32, with and without sleep, the sleep pass's rules for pins, and the anchor path's cost to a scene
// without pins (none: the same floats).
import { describe, expect, it } from 'vitest';
import type { BodyDesc, SceneDesc } from '@tb/engine-api';
import { PIN_CASE, PIN_SLIDE_CASE, pinErrors, pinScene, pinSlideErrors, pinSlideScene } from '@tb/testkit';
import { buildScenario } from '@tb/scenarios';
import { call, gpu, toSnap } from './harness.ts';

const box = (half: [number, number, number], pos: [number, number, number], pinned = false): BodyDesc => ({
  shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0, ...(pinned ? { pinned } : {}),
});

describe('GPU AVBD engine: pinned bodies', () => {
  it.for([false, true])('holds a pinned body bit for bit where it was given, at rest and not awake, under a load, a ball and a blast; a removed pin drops its load (sleep %s)', { timeout: 300_000 }, async (sleep, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('simulateGpu', { ...pinScene(), sleep }, PIN_CASE.end, {}, 1, { sleep });
    expect(r.error).toBeNull();
    const e = pinErrors(r.snaps.map(toSnap));
    expect(e.pinMoved).toBe(0);
    expect(e.pinSpeed).toBe(0);
    expect(e.pinAwake).toEqual([]);
    expect(e.droppedRests).toBe(true);
    expect(e.cubeDrop).toBeCloseTo(2.5, 1);
  });

  it('a cube slides on a pinned slab as on the ground plane at the slab\'s height', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const [p, g] = [await call('simulateGpu', pinSlideScene(true), PIN_SLIDE_CASE.end, {}, 1), await call('simulateGpu', pinSlideScene(false), PIN_SLIDE_CASE.end, {}, 1)];
    expect(p.error).toBeNull();
    const r = pinSlideErrors(p.snaps.map(toSnap), g.snaps.map(toSnap));
    expect(r.path).toBeGreaterThan(1);
    expect(r.diff).toBeLessThan(0.01 + 0.01 * r.path);
  });

  it('with sleep, stacks on a pin fall asleep, and waking one does not wake the other through the pin', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A pinned shelf (top at 3.5) with a 3-cube stack at each end; at step 240 a blast wakes the left stack.
    const stack = (x: number) => [0, 1, 2].map((k) => box([0.5, 0.5, 0.5], [x, 4 + k, 0]));
    const scene: SceneDesc = {
      id: 'pin-sleep', params: {}, seed: 0, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: true,
      bodies: [box([10, 0.5, 2], [0, 3, 0], true), ...stack(-6), ...stack(6)],
      inputs: [{ step: 240, kind: 'blast', blast: { centre: [-6, 3.5, 0], radius: 2, impulse: 2 } }],
    };
    const r = await call('simulateGpu', scene, 250, {}, 5, { sleep: true });
    expect(r.error).toBeNull();
    const at = (step: number) => r.snaps.find((s) => s.step === step)!.awake!;
    // Asleep before the blast: every body (the pin was never awake).
    expect(at(240)).toEqual([0, 0, 0, 0, 0, 0, 0]);
    // After it: the left stack awake, the pin and the right stack asleep.
    expect(at(245)).toEqual([0, 1, 1, 1, 0, 0, 0]);
  });

  it('a pinned body pushed after init: refused without anchors, held with GpuEngineOptions.pins', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene: SceneDesc = { ...pinSlideScene(false), id: 'pin-push', ground: { y: 0, friction: 0.6 }, bodies: [box([0.5, 0.5, 0.5], [0, 5, 0])] };
    const shelf = box([2, 0.25, 2], [0, 3, 0], true);
    const refused = await call('pushedRun', scene, 60, {}, { capacity: 2, maxRadius: 3 }, [[10, [{ step: 10, kind: 'spawn', body: shelf }]]]);
    expect(refused.pushError).toMatch(/pinned body, but the engine was built without anchors/);
    const held = await call('pushedRun', scene, 90, {}, { capacity: 2, maxRadius: 3, pins: true }, [[10, [{ step: 10, kind: 'spawn', body: shelf }]]]);
    expect(held.error).toBeNull();
    expect(held.pushError).toBeNull();
    const end = held.snaps.at(-1)!;
    // The shelf where it was spawned; the cube came to rest on its top (3.25 + 0.5).
    expect(end.pos.slice(3, 6)).toEqual([0, 3, 0]);
    expect(end.pos[1]).toBeCloseTo(3.75, 2);
    expect(end.awake).toEqual([1, 0]);
  });

  it('refuses pinned bodies with restitution on', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('pushedRun', pinScene(), 1, { restitution: true }, {}, []);
    expect(r.initError).toMatch(/pinned bodies are not implemented with AvbdParams.restitution/);
  });

  it('the anchor path changes no float of a scene without pins (GpuEngineOptions.pins)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const knock = buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);
    const [a, b] = [await call('simulateGpu', knock, 30, { iterations: 6 }, 0, {}), await call('simulateGpu', knock, 30, { iterations: 6 }, 0, { pins: true })];
    expect(b.error).toBeNull();
    expect(b.snaps.at(-1)).toEqual(a.snaps.at(-1));
  });
});

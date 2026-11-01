// Per-body sleep (sleep.ts; roadmap E2), step 1: the bookkeeping alone. With GpuEngineOptions.sleep on, the
// trajectory is bit-identical to the run with it off, and Body.flags bit 0 (Snapshot.awake) says which bodies
// the sleep rule would put to sleep: quiet (|v| + |w| r < v_sleep, drift under 2% of r) for T steps, with every
// contact neighbour quiet for T / 2.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import type { GpuEngineOptions } from '../src/engine.ts';
import { DEFAULT_SLEEP } from '../src/sleep.ts';
import { call, cube, gpu, sceneOf } from './harness.ts';

const SLEEP: GpuEngineOptions = { sleep: true };
const sleepy = (s: SceneDesc): SceneDesc => ({ ...s, sleep: true });
const ball = (pos: [number, number, number], angVel: [number, number, number]): BodyDesc => ({
  shape: { kind: 'sphere', radius: 0.5 }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel, density: 1, friction: 0, restitution: 0, tag: 0,
});
const frictionless = (bodies: BodyDesc[]): SceneDesc => ({ ...sleepy(sceneOf(bodies)), ground: { y: 0, friction: 0 } });

async function run(scene: SceneDesc, steps: number, opts: Omit<GpuEngineOptions, 'device'>, every = 1, params = { iterations: 8 }) {
  const r = await call('simulateGpu', scene, steps, params, every, opts);
  expect(r.error).toBeNull();
  expect(r.final.pairsOverflowSteps).toBe(0);
  return r;
}
const asleep = (awake: number[] | undefined) => awake!.filter((a) => a === 0).length;

describe('GPU sleep, step 1: bookkeeping', () => {
  it('leaves the trajectory bit-identical (a ball through a wall, then the debris) and only changes awake bits', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(buildScenario('S5', { N: 96, F: 2, H: 8, street: 2, fireStep: 20, radius: 0.6, speed: 15 }, 1));
    const off = await run(scene, 150, {}, 10), on = await run(scene, 150, SLEEP, 10);
    expect(on.snaps.length).toBe(off.snaps.length);
    let slept = 0;
    on.snaps.forEach((s, k) => {
      const o = off.snaps[k]!;
      expect([s.pos, s.rot, s.linVel, s.angVel], `step ${s.step}`).toEqual([o.pos, o.rot, o.linVel, o.angVel]);
      expect(o.awake!.every((a) => a === 1)).toBe(true);
      slept += asleep(s.awake);
    });
    // The rule did put bodies to sleep somewhere in the run (the far end of the wall rests).
    expect(slept).toBeGreaterThan(0);
  });

  it('reports every body of a resting city eligible after 1 s, and none before T steps', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(buildScenario('S14', { towers: 4, W: 3, D: 3, H: 6, street: 4 }, 1));
    const r = await run(scene, 60, SLEEP);
    const n = scene.bodies.length;
    for (const s of r.snaps) if (s.step < DEFAULT_SLEEP.steps) expect(asleep(s.awake), `step ${s.step}`).toBe(0);
    expect(asleep(r.snaps.at(-1)!.awake)).toBe(n);
  });

  it('never puts a falling body to sleep', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // From 30 m it is still falling at 1.5 s (11 m down).
    const r = await run(sleepy(sceneOf([cube([0, 30, 0])])), 90, SLEEP);
    for (const s of r.snaps) expect(s.awake, `step ${s.step}`).toEqual([1]);
  });

  it('displacement: a cube gliding at 0.04 units/s, under v_sleep, never sleeps; the same cube at rest does by step T + 1', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // On frictionless ground it keeps its speed; over a window of T = 30 steps it moves 0.02, more than 2% of r (0.0173).
    const glide = await run(frictionless([{ ...cube([0, 0.5, 0], [0.04, 0, 0]), friction: 0 }]), 240, SLEEP);
    expect(glide.snaps.at(-1)!.linVel[0]).toBeCloseTo(0.04, 3);
    for (const s of glide.snaps) expect(s.awake, `step ${s.step}`).toEqual([1]);
    // It is the drift rule that keeps it awake: with the window as wide as the body, the speed test alone lets it sleep.
    const loose = await run(frictionless([{ ...cube([0, 0.5, 0], [0.04, 0, 0]), friction: 0 }]), 40, { ...SLEEP, sleepDrift: 1 });
    expect(loose.snaps.at(-1)!.awake).toEqual([0]);
    const rest = await run(frictionless([{ ...cube([0, 0.5, 0]), friction: 0 }]), 40, SLEEP);
    const first = rest.snaps.find((s) => s.awake![0] === 0)!.step;
    expect(first).toBeGreaterThanOrEqual(DEFAULT_SLEEP.steps);
    expect(first).toBeLessThanOrEqual(DEFAULT_SLEEP.steps + 1);
  });

  it('neighbours: a cube beside a ball spinning in place stays awake; beside the same ball at rest it sleeps', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Frictionless, and 0.01 apart (inside the contact margin): a speculative contact joins them, and the
    // spinning ball (|w| r = 1.5 units/s) neither slows nor pushes the cube.
    const box = { ...cube([1.01, 0.5, 0]), friction: 0 };
    const spin = await run(frictionless([ball([0, 0.5, 0], [0, 3, 0]), box]), 120, SLEEP);
    for (const s of spin.snaps) expect(s.awake, `step ${s.step}`).toEqual([1, 1]);
    const last = spin.snaps.at(-1)!;
    expect(Math.hypot(last.linVel[3]!, last.linVel[4]!, last.linVel[5]!)).toBeLessThan(1e-3);
    expect(last.angVel[1]).toBeCloseTo(3, 2);
    const still = await run(frictionless([ball([0, 0.5, 0], [0, 0, 0]), box]), 60, SLEEP);
    expect(still.snaps.at(-1)!.awake).toEqual([0, 0]);
  });

  it('acts only when the scene allows sleep (SceneDesc.sleep), and keeps a spawned body awake until it is quiet', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await run(sceneOf([cube([0, 0.5, 0])]), 60, SLEEP);
    for (const s of off.snaps) expect(s.awake).toEqual([1]);
    // A cube dropped beside a resting one at step 45: awake on arrival while the first sleeps on.
    const scene = sleepy(sceneOf([cube([0, 0.5, 0])]));
    scene.inputs = [{ step: 45, kind: 'spawn', body: cube([3, 0.5, 0]) }];
    const r = await run(scene, 50, SLEEP);
    const at = r.snaps.find((s) => s.step === 46)!;
    expect(at.awake).toEqual([0, 1]);
  });
});

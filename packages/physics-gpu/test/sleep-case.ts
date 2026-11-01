// Shared helpers for the GPU sleep tests (engine-sleep*.test.ts; sleep.ts, roadmap E2).
import { expect } from 'vitest';
import type { BodyDesc, InputEvent, SceneDesc } from '@tb/engine-api';
import type { GpuEngineOptions } from '../src/engine.ts';
import { DEFAULT_SLEEP } from '../src/sleep.ts';
import { call, cube, sceneOf } from './harness.ts';
import type { PlainSnapshot } from './page.ts';

export const SLEEP: GpuEngineOptions = { sleep: true };
export const T = DEFAULT_SLEEP.steps;
export const sleepy = (s: SceneDesc, inputs: InputEvent[] = []): SceneDesc => ({ ...s, sleep: true, inputs });
export const ball = (pos: [number, number, number], angVel: [number, number, number], linVel: [number, number, number] = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'sphere', radius: 0.5 }, pos, rot: [0, 0, 0, 1], linVel, angVel, density: 1, friction: 0, restitution: 0, tag: 0,
});
export const frictionless = (bodies: BodyDesc[]): SceneDesc => ({ ...sleepy(sceneOf(bodies)), ground: { y: 0, friction: 0 } });
/** A column of k unit cubes on the ground. */
export const column = (k: number, x = 0) => Array.from({ length: k }, (_, j) => cube([x, 0.5 + j, 0]));

export async function run(scene: SceneDesc, steps: number, opts: Omit<GpuEngineOptions, 'device'>, every = 1, params: Record<string, number> = { iterations: 8 }) {
  const r = await call('simulateGpu', scene, steps, params, every, opts);
  expect(r.error).toBeNull();
  expect(r.final.pairsOverflowSteps).toBe(0);
  return r;
}
export const asleep = (s: PlainSnapshot) => s.awake!.filter((a) => a === 0).length;
export const at = (snaps: PlainSnapshot[], step: number) => snaps.find((s) => s.step === step)!;
export const y = (s: PlainSnapshot, i: number) => s.pos[3 * i + 1]!;

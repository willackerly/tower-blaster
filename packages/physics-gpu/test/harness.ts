// Shared setup for the GPU AVBD engine tests (engine*.test.ts): one browser
// page per test file with the page.ts drivers loaded, and the scene helpers.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect } from 'vitest';
import { type BodyDesc, emptySnapshot, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './page.ts';

export let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__phys');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

export type D = typeof Drivers;
export function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __phys: Record<string, (...x: unknown[]) => unknown> }).__phys[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

export const toSnap = (p: Drivers.PlainSnapshot): Snapshot => {
  const s = emptySnapshot(p.pos.length / 3);
  s.pos.set(p.pos); s.rot.set(p.rot); s.linVel.set(p.linVel); s.angVel.set(p.angVel); s.awake.fill(1);
  return s;
};
export async function runGpu(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}, every = 0, kicks: Drivers.Kick[] = []) {
  const r = await call('simulateGpu', scene, steps, params, every, {}, kicks);
  expect(r.error).toBeNull();
  // No step dropped broadphase pairs: every step, not only the sampled ones (the broadphase's sticky counter).
  expect(r.final.pairsOverflowSteps).toBe(0);
  expect(r.worst.uncolored).toBe(0);
  expect(r.worst.colorOverflow).toBe(0);
  expect(r.worst.pairsRequired).toBeLessThanOrEqual(r.worst.pairsWritten);
  return { ...r, s0: toSnap(r.snaps[0]!), s1: toSnap(r.snaps[r.snaps.length - 1]!), all: r.snaps.map(toSnap) };
}
export async function runRef(scene: SceneDesc, steps: number) {
  const e = new AvbdReferenceEngine();
  await e.init(scene);
  for (let i = 0; i < steps; i++) e.step();
  return e.snapshot();
}

export const cube = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0,
});
export const sceneOf = (bodies: BodyDesc[], gravity: Vec3 = [0, -9.81, 0]): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity, dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: false, bodies, inputs: [],
});
export const G = 9.81, MU = 0.6;
export const stopping = (v0: number, h = 1 / 60) => {
  let x = 0;
  for (let v = v0 - MU * G * h; v > 0; v -= MU * G * h) x += h * v;
  return x;
};

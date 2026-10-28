// Shared setup for the lattice colouring tests (lattice*.test.ts:
// AvbdParams.colorMode and colorPriority on the GPU engine): one browser page
// per test file with the lattice-page.ts drivers loaded, the runners and the
// scenes.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect } from 'vitest';
import type { BodyDesc, SceneDesc } from '@tb/engine-api';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type { GpuEngineOptions } from '../src/index.ts';
import type * as Drivers from './lattice-page.ts';

export let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./lattice-page.ts', import.meta.url)), '__lattice');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
export function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __lattice: Record<string, (...x: unknown[]) => unknown> }).__lattice[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

export async function runGpu(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every = 0, opts: Omit<GpuEngineOptions, 'device'> = {}) {
  const r = await call('simulateGpu', scene, steps, params, every, opts, []);
  expect(r.error).toBeNull();
  expect(r.worst.uncolored).toBe(0);
  expect(r.worst.colorOverflow).toBe(0);
  // No step dropped broadphase pairs (the sticky counter covers every step, not only the sampled ones).
  expect(r.final.pairsOverflowSteps).toBe(0);
  return r;
}
export async function runRef(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every = 0) {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const snaps = [{ step: 0, pos: [...e.snapshot().pos] }];
  for (let i = 1; i <= steps; i++) { e.step(); if ((every && i % every === 0) || i === steps) snaps.push({ step: i, pos: [...e.snapshot().pos] }); }
  return snaps;
}
export const maxDiff = (a: ArrayLike<number>, b: ArrayLike<number>) => {
  let m = 0;
  for (let k = 0; k < a.length; k++) m = Math.max(m, Math.abs(a[k]! - b[k]!));
  return m;
};

// One 8x8x10 tower (640 cubes) and a ball fired into it at step 20; it strikes at about step 36.
export const impact = () => buildScenario('S5', { N: 640, F: 8, H: 10, fireStep: 20, radius: 1.5, speed: 15 }, 1);
// A 4x4x4 block whose cubes sit 2 mm closer than their size on every axis: the in-plane diagonal and corner
// neighbours overlap too, so both 4-colour patterns meet contacts along their kernel and need the fallback.
export const squeezed = (): SceneDesc => {
  const pitch = 0.998, bodies: BodyDesc[] = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) {
    bodies.push({ shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos: [0.5 + x * pitch, 0.5 + y * pitch, 0.5 + z * pitch], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0 });
  }
  return { id: 'squeezed', params: {}, seed: 1, gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: false, bodies, inputs: [] };
};

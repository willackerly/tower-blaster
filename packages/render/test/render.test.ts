// The renderer's data path: CPU-side packing and references here, GPU
// culling and drawing in headless Chromium (SwiftShader without a GPU).
// Correctness only: timings from here are never performance results.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptySnapshot, TAG_BALL, type BodyDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { Body, readStruct, Shape } from '@tb/schema';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { frustumPlanes, listMatches, lookAt, lookOf, lookRange, MATERIAL, multiply, packBodies, packShapes, paletteOf, perspective, unpackLook } from '../src/index.ts';
import type * as Drivers from './page.ts';

describe('looks', () => {
  const scene = buildScenario('S1', { F: 2, H: 5 });
  const range = lookRange(scene.bodies);

  it('ramp follows original height, bottom 0 to top 255', () => {
    const ramps = scene.bodies.map((b, i) => unpackLook(lookOf(b, i, range)).ramp);
    const ys = scene.bodies.map((b) => b.pos[1]);
    expect(Math.min(...ramps)).toBe(0);
    expect(Math.max(...ramps)).toBe(255);
    scene.bodies.forEach((_, i) => scene.bodies.forEach((__, j) => { if (ys[i]! < ys[j]!) expect(ramps[i]).toBeLessThanOrEqual(ramps[j]!); }));
  });

  it('packs hue, material and a per-slot seed', () => {
    const ball: BodyDesc = { ...scene.bodies[0]!, tag: TAG_BALL };
    expect(unpackLook(lookOf(ball, 7, range))).toMatchObject({ hue: paletteOf(TAG_BALL), material: MATERIAL.ball });
    expect(unpackLook(lookOf(scene.bodies[0]!, 0, range)).material).toBe(MATERIAL.candy);
    const seeds = new Set(scene.bodies.map((b, i) => unpackLook(lookOf(b, i, range)).seed));
    expect(seeds.size).toBeGreaterThan(scene.bodies.length * 0.9);
  });
});

describe('packBodies / packShapes', () => {
  it('write the schema layouts, slot i = body i', () => {
    const scene = buildScenario('S5', { N: 64, F: 2, H: 4, fireStep: 0 });
    const descs: BodyDesc[] = [...scene.bodies, scene.inputs[0]!.body];
    const s = emptySnapshot(descs.length);
    descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.linVel.set([i, 0, 0], 3 * i); s.awake[i] = i % 2; });
    const view = new DataView(packBodies(s, descs));
    const last = descs.length - 1;
    for (const i of [0, 1, last]) {
      const b = readStruct(view, Body, i);
      b.pos!.forEach((x, k) => expect(x).toBeCloseTo(descs[i]!.pos[k]!, 5));
      expect(b.linVel![0]).toBe(i);
      expect(b.shape).toEqual([i]);
      expect(b.flags).toEqual([i % 2]); // awake bit, tier 0 (active)
    }
    const shapes = new DataView(packShapes(descs).buffer);
    expect(readStruct(shapes, Shape, 0)).toEqual({ half: [0.5, 0.5, 0.5], kind: [0] });
    const r = (descs[last]!.shape as { radius: number }).radius;
    expect(readStruct(shapes, Shape, last)).toEqual({ half: [r, r, r].map(Math.fround), kind: [1] });
  });
});

describe('frustumPlanes', () => {
  it('a point is inside every plane exactly when it projects inside the clip volume', () => {
    const m = multiply(perspective(1, 1.5, 0.5, 50), lookAt([0, 0, 0], [0, 0, -1]));
    const pl = frustumPlanes(m);
    const inside = (p: number[]) => [0, 1, 2, 3, 4, 5].every((k) => pl[4 * k]! * p[0]! + pl[4 * k + 1]! * p[1]! + pl[4 * k + 2]! * p[2]! + pl[4 * k + 3]! >= 0);
    expect(inside([0, 0, -10])).toBe(true);
    expect(inside([0, 0, 10])).toBe(false); // behind
    expect(inside([0, 0, -60])).toBe(false); // past far
    expect(inside([0, 0, -0.4])).toBe(false); // before near
    expect(inside([20, 0, -10])).toBe(false);
    expect(inside([0, -9, -10])).toBe(false);
  });
});

describe('listMatches', () => {
  it('accepts lists between must and may, in order', () => {
    expect(listMatches([1, 3], [1], [1, 3])).toBeNull();
    expect(listMatches([3, 1], [1], [1, 3])).toMatch(/ascending/);
    expect(listMatches([1], [1, 3], [1, 3])).toMatch(/missing/);
    expect(listMatches([1, 2], [1], [1, 3])).toMatch(/culled/);
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__render');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __render: Record<string, (...x: unknown[]) => unknown> }).__render[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

describe('GPU cull and compaction', () => {
  it('lists, counts and records match the CPU reference', async (ctx) => {
    if (!gpu) return ctx.skip();
    const cases = [
      { seed: 1, count: 3000, capacity: 3000, alpha: 0.37, noCull: false },
      { seed: 2, count: 1000, capacity: 1500, alpha: 1, noCull: false }, // free tail beyond count
      { seed: 3, count: 600, capacity: 600, alpha: 0, noCull: false },
      { seed: 4, count: 600, capacity: 700, alpha: 0.5, noCull: true },
      { seed: 5, count: 1, capacity: 1, alpha: 0.5, noCull: false },
      { seed: 6, count: 0, capacity: 64, alpha: 0.5, noCull: false },
    ];
    const out = await call('cull', cases);
    for (const r of out) {
      expect(r.error, `seed ${r.seed}`).toBeNull();
      expect(r.lists, `seed ${r.seed}`).toEqual([null, null, null, null]);
      expect(r.argsOk).toBe(true);
      expect(r.recordErr, `seed ${r.seed}`).toBeLessThan(2e-5);
    }
    // The random camera culls some but not all.
    expect(out[0]!.counts[0]).toBeGreaterThan(50);
    expect(out[0]!.counts[0]).toBeLessThan(2500);
    expect(out[5]!.listed).toBe(0);
  });
});

describe('drawing', () => {
  it('ID pixels at stable probes equal a CPU raycast', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Seed 11 caught spheres drawn inside out (back faces kept by the cull mode).
    for (const seed of [11, 12, 13]) {
      const r = await call('idProbes', seed);
      expect(r.error).toBeNull();
      expect(r.probes).toBeGreaterThan(500);
      expect(r.hitProbes).toBeGreaterThan(50);
      expect(r.mismatches, r.examples.join('; ')).toBe(0);
    }
  });

  it('culling never changes an ID pixel', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('cullInvariance', 21, 4000);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.distinctOnScreen).toBeGreaterThan(100);
    expect(r.drawnBoxes + r.drawnSpheres).toBeLessThan(3000); // most of the cloud is behind or beside the camera
  });

  it('interpolates between the last two steps', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('interpolation', 31);
    expect(r.error).toBeNull();
    // alpha 0 / 1 reproduce prev / current, allowing a few edge pixels for quaternion renormalization.
    expect(r.diff0).toBeLessThan(r.pixels * 0.001);
    expect(r.diff1).toBe(0);
    expect(Math.abs(r.c1 - r.c0)).toBeGreaterThan(5);
    expect(Math.abs(r.c5 - (r.c0 + r.c1) / 2)).toBeLessThan(1);
  });

  it("draws a GPU engine's buffers in place: same image, uniforms-only uploads", async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('gpuSource', 41);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.prevEqual).toBe(true); // beforeStep() copied the state into prev
    expect(r.bytesPerFrame).toBeLessThanOrEqual(1024);
  });
});

// The renderer's data path: CPU-side packing and references here, GPU
// culling and drawing in headless Chromium (SwiftShader without a GPU).
// Correctness only: timings from here are never performance results.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptySnapshot, TAG_BALL, type BodyDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { Body, readStruct, Shape } from '@tb/schema';
import { isSoftwareAdapter, loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { agx, bevelNormal, CANDY_NIGHT, frustumPlanes, linearToOklab, listMatches, oklabToLinear, srgbToLinear, lookAt, lookOf, lookRange, MATERIAL, multiply, packBodies, packShapes, paletteOf, perspective, unpackLook } from '../src/index.ts';
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

describe('look math (CPU twins)', () => {
  const r = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 2 ** 32); })();

  it('OKLab round-trips linear sRGB', () => {
    for (let i = 0; i < 1000; i++) {
      const c: [number, number, number] = [r(), r(), r()];
      oklabToLinear(linearToOklab(c)).forEach((v, k) => expect(v).toBeCloseTo(c[k]!, 6));
    }
    // White is L = 1, a = b = 0.
    linearToOklab([1, 1, 1]).forEach((v, k) => expect(v).toBeCloseTo(k ? 0 : 1, 4));
  });

  // Monotone up to a quarter of an 8-bit step: near white, the punchy
  // saturation plus the output clamp dips luma by up to ~5e-4.
  it('AgX maps black to black, stays in 0..1, and is monotone in exposure', () => {
    expect(Math.max(...agx([0, 0, 0]))).toBeLessThan(0.01);
    for (let i = 0; i < 200; i++) {
      const c: [number, number, number] = [r() * 4, r() * 4, r() * 4];
      let prev = -1;
      for (let ev = -8; ev <= 8; ev += 0.5) {
        const out = agx(c.map((x) => x * 2 ** ev) as [number, number, number]);
        out.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); });
        const luma = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
        expect(luma).toBeGreaterThanOrEqual(prev - 1 / 1024);
        prev = luma;
      }
    }
  });

  it('every ramp colour keeps its hue ordering through OKLab (no channel clipping)', () => {
    for (const c of CANDY_NIGHT.ramp) {
      const lin = c.map(srgbToLinear) as [number, number, number];
      oklabToLinear(linearToOklab(lin)).forEach((v) => { expect(v).toBeGreaterThanOrEqual(-1e-6); expect(v).toBeLessThanOrEqual(1 + 1e-6); });
    }
  });

  it('bevel normals are unit, never face inward, and flat at face centres', () => {
    for (let i = 0; i < 5000; i++) {
      const half: [number, number, number] = [0.05 + r() * 1.5, 0.05 + r() * 1.5, 0.05 + r() * 1.5];
      const axis = Math.floor(r() * 3), sgn = r() < 0.5 ? -1 : 1;
      const faceN: [number, number, number] = [0, 0, 0];
      faceN[axis] = sgn;
      const lp = half.map((h, k) => (k === axis ? sgn * h : (r() * 2 - 1) * h)) as [number, number, number];
      const pxM = 10 ** (r() * 4 - 4), rb = 0.005 + r() * 0.2;
      const n = bevelNormal(lp, faceN, half, pxM, rb);
      expect(Math.hypot(...n)).toBeCloseTo(1, 9);
      expect(n[axis]! * sgn).toBeGreaterThan(0.3); // tilts at most to the 45 degree edge normal (and less near corners' sides)
      const centre = half.map((h, k) => (k === axis ? sgn * h : 0)) as [number, number, number];
      bevelNormal(centre, faceN, half, pxM, rb).forEach((v, k) => expect(v).toBeCloseTo(faceN[k]!, 9));
    }
  });

  it('bevel fades to the flat face once the radius is under a third of a pixel', () => {
    const half: [number, number, number] = [0.5, 0.5, 0.5];
    const edge: [number, number, number] = [0.5, 0.499, 0.2];
    expect(bevelNormal(edge, [1, 0, 0], half, 0.001, 0.06)[1]).toBeGreaterThan(0.1); // resolved: tilted
    expect(bevelNormal(edge, [1, 0, 0], half, 0.2, 0.06)).toEqual([1, 0, 0]); // 3x the radius per pixel: flat
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

  // A packed tower showed dark vertical dashes: at edge pixels the MSAA
  // shading point lies outside the triangle, and a face guessed from the
  // extrapolated local position named the neighbouring face (that guess
  // makes 1735 of these pixels unstable).
  it('tower faces shade as their own face at every sub-pixel edge', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('towerFaces');
    expect(r.error).toBeNull();
    expect(r.checked).toBeGreaterThan(2000);
    expect(r.unstable, r.examples.join('; ')).toBe(0);
    // A few pixels on a shared edge see the neighbour's inner face: the two
    // meet exactly there, and snapped vertices decide either way. Measured
    // 5 of 2897; neither depth32float nor dilating boxes by up to 1 px
    // removes them, and in the shaded image they are one sample of four on
    // an already darkened seam.
    expect(r.wrong, r.examples.join('; ')).toBeLessThan(r.checked * 0.005);
  });

  it('colour and bevel WGSL match their TypeScript twins', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('lookTwins', 41);
    expect(r.error).toBeNull();
    expect(r.agxErr).toBeLessThan(1 / 1024); // a quarter of an 8-bit step
    expect(r.labErr).toBeLessThan(1e-5);
    expect(r.bevErr).toBeLessThan(1e-4);
  });

  it('bloom without Karis weighting conserves energy and falls off monotonically', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('bloomEnergy', false);
    expect(r.error).toBeNull();
    expect(r.finite).toBe(true);
    expect(r.levels).toBe(5);
    expect(r.meanRatio).toBeGreaterThan(0.95);
    expect(r.meanRatio).toBeLessThan(1.05);
    expect(r.rises).toBe(0);
    // Karis weighting tames the single-pixel firefly: much less energy, still finite.
    const k = await call('bloomEnergy', true);
    expect(k.finite).toBe(true);
    expect(k.meanRatio).toBeLessThan(0.5);
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

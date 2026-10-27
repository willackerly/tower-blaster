// The real look's wood (Kapla's pine, materials.ts WOOD): woodRings on the
// GPU against its CPU twin, and a plank drawn in headless Chromium
// (SwiftShader without a GPU). Correctness only: timings from here are never
// performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('wood', () => {
  it('woodRings on the GPU agrees with its CPU twin', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('woodTwins', 61);
    expect(r.error).toBeNull();
    // Measured on SwiftShader: albedo within 1.5e-4, latewood within 4.8e-4, 15 of 4096 points at a ring's end.
    expect(r.albedoErr, JSON.stringify(r.worst)).toBeLessThan(1e-3);
    expect(r.lateErr).toBeLessThan(2e-3);
    expect(r.boundary).toBeLessThan(0.01 * r.n);
  });

  it('a pine plank: grain along its long axis whichever way it lies, the same colour on average, compiled out with the stone', async (ctx) => {
    if (!gpu) return ctx.skip();
    // stoneScale 4: rings 2 cm apart, about 9 pixels at this distance, so they show at full contrast.
    const pine = { stone: 'pine', stoneScale: 4 } as const;
    const r = await call('woodFace', [pine, { ...pine, turned: true }, { ...pine, stoneDetail: 0 }, { stoneScale: 4 }, { stoneScale: 4, turned: true }, { ...pine, realDiag: 'stone-off' }]);
    expect(r.error).toBeNull();
    const [alongX, alongZ, flat, lime, limeTurned, off] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader (mean |luma step| across / along the plank): pine 8.0 lying along x,
    // 8.0 turned; limestone 0.89 and 1.0.
    expect(alongX!.alongZ / alongX!.alongX).toBeGreaterThan(4);
    expect(alongZ!.alongX / alongZ!.alongZ).toBeGreaterThan(4);
    for (const l of [lime!, limeTurned!]) {
      expect(l.alongZ / l.alongX).toBeGreaterThan(0.7);
      expect(l.alongZ / l.alongX).toBeLessThan(1.4);
    }
    // The rings and fibres average to the palette colour over whole rings; the patch holds about
    // six, so a part ring shows (measured 2.5% darker).
    expect(Math.abs(alongX!.meanLuma / flat!.meanLuma - 1)).toBeLessThan(0.05);
    // The stone compiled out (the far boxes' shader) draws what texture 0 draws, wood included.
    expect(off!.hash).toBe(flat!.hash);
    expect(alongX!.hash).not.toBe(flat!.hash);
  }, 120_000);

  it('pine level of detail: past the fade-out the near and far shaders draw the same', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('stoneLodSeam', { stone: 'pine', stoneFade: 3 });
    expect(r.error).toBeNull();
    expect(r.lod.boxes).toBeGreaterThan(0);
    expect(r.lod.farBoxes).toBeGreaterThan(0);
    expect(r.maxDiff).toBeLessThanOrEqual(2);
  }, 120_000);
});

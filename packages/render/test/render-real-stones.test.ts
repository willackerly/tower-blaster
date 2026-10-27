// The real look's stones, their level of detail and the soft shadows, drawn in
// headless Chromium (SwiftShader without a GPU). Split from render.test.ts so
// CI shards can run the slow drawing tests side by side. Correctness only:
// timings from here are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('real look stones: textured blocks carry fine detail, each stone differs, and texture 0 is flat', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Close up on a tumbled block's face (the golden "low" view).
    const r = await call('realChecks', [{}, { stoneDetail: 0 }, { stone: 'granite' }, { stone: 'sandstone' }, { stone: 'concrete' }, { stoneScale: 3 }], [320, 180], [[2.2, 0.45, 2.4], [-1, 1.2, -3]]);
    expect(r.error).toBeNull();
    const [lime, flat, granite, , concrete, scaled] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader (mean |luma - neighbour mean|): limestone 1.11, flat 0.65, granite 2.38,
    // sandstone 1.01, concrete 0.74, limestone at 3x scale 0.95.
    expect(lime!.detail).toBeGreaterThan(1.4 * flat!.detail);
    expect(granite!.detail).toBeGreaterThan(1.5 * lime!.detail);
    expect(concrete!.detail).toBeGreaterThan(flat!.detail);
    expect(scaled!.detail).toBeLessThan(lime!.detail);
    // The texture's mean multiplier is about 1: the same block colours on average.
    expect(Math.abs(lime!.meanLuma / flat!.meanLuma - 1)).toBeLessThan(0.05);
    expect(new Set(r.frames.map((f) => f.hash)).size).toBe(6);
  }, 120_000);

  it('real look bench diagnostics: stone code compiled out draws what texture 0 draws; step-1 blocks differ', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('realChecks', [{ stoneDetail: 0 }, { stoneDetail: 0, realDiag: 'stone-off' }, { realDiag: 'stone-off' }, { stoneDetail: 0, realDiag: 'step1' }], [320, 180], [[2.2, 0.45, 2.4], [-1, 1.2, -3]]);
    expect(r.error).toBeNull();
    const [flat, off, offDetail, step1] = r.frames as NonNullable<typeof r.frames>;
    // Compiled out, the stone knob does nothing, and the frame is texture 0's to the bit.
    expect(off!.hash).toBe(flat!.hash);
    expect(offDetail!.hash).toBe(flat!.hash);
    // Step 1's blocks: the stylized body (no palette per block, wear or dirt).
    expect(step1!.hash).not.toBe(flat!.hash);
  }, 120_000);

  it('stone level of detail: far boxes drop the stone code with no visible seam, and texture 0 sends every box far', async (ctx) => {
    if (!gpu) return ctx.skip();
    // At 180 px a fade-out of 3 cm per pixel puts the split about 6 m past the near plane: the
    // tumbled boxes (5 to 8 m away) fall on both sides, the towers (12 m) are far.
    const r = await call('stoneLodSeam', { stoneFade: 3 });
    expect(r.error).toBeNull();
    expect(r.lod.boxes).toBeGreaterThan(0);
    expect(r.lod.farBoxes).toBeGreaterThan(0);
    expect(r.noLod.farBoxes).toBe(0);
    expect(r.lod.boxes + r.lod.farBoxes).toBe(r.noLod.boxes);
    // Past the fade-out both shaders compute the same thing; two compilations may round differently.
    expect(r.maxDiff).toBeLessThanOrEqual(2);
    const flat = await call('stoneLodSeam', { stoneDetail: 0 });
    expect(flat.lod.boxes).toBe(0);
    expect(flat.maxDiff).toBeLessThanOrEqual(2);
  }, 120_000);

  it('real look soft shadows: the same analytic shadows, without acne or leaks', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const kind of ['float', 'contact', 'grazing'] as const) {
      const r = await call('shadowCheck', kind, { real: {} });
      expect(r.error).toBeNull();
      expect(r.used).toBeGreaterThan(3000);
      expect(r.wrong).toBe(0);
      expect(r.maxStep).toBeLessThanOrEqual(3);
      if (kind === 'grazing') continue;
      expect(r.iou).toBeGreaterThan(0.95);
      expect(r.centroidErr).toBeLessThan(0.02);
      expect(r.leak).toBe(0);
    }
  }, 120_000);

  it('real look soft shadows: penumbrae as wide as the sun disc says', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('penumbraChecks', [{ h: 2 }, { h: 6 }, { h: 2, real: { shadowSoftness: 2 } }, { h: 3, elevation: 25 }, { h: 2, real: { shadowSoftness: 0 } }]);
    expect(r.error).toBeNull();
    for (const [i, c] of r.cases.entries()) {
      expect(c.band).toBeGreaterThan(1000);
      expect(c.dark).toBeLessThan(0.03); // inside the shadow
      expect(c.lit).toBeGreaterThan(0.97); // past the penumbra
      expect(Math.abs(c.x50)).toBeLessThan(c.texel); // the half-lit line on the geometric edge
      if (i === 4) { expect(c.x90 - c.x10).toBeLessThan(3 * c.texel); continue; } // softness 0: the 3x3 taps (measured 2.7 texels)
      // The 10% and 90% lines where the disc profile puts them, within a texel
      // (SwiftShader: within 0.05 to 1.2 mm of the 3.9 mm texel, 4.5% narrow at h = 6).
      expect(Math.abs(c.x10 - c.want10)).toBeLessThan(c.texel);
      expect(Math.abs(c.x90 - c.want90)).toBeLessThan(c.texel);
    }
    // Twice the softness, twice the width; three times the height, three times.
    const w = r.cases.map((c) => c.x90 - c.x10);
    expect(w[2]! / w[0]!).toBeGreaterThan(1.8);
    expect(w[2]! / w[0]!).toBeLessThan(2.2);
    expect(w[1]! / w[0]!).toBeGreaterThan(2.6);
  }, 120_000);

  it('real look shadow softness 0 is the frame with the soft shadow code compiled out', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('penumbraFrames', [{ h: 2, realDiag: null, real: { shadowSoftness: 0 } }, { h: 2, realDiag: 'pcss-off' }, { h: 2, realDiag: null }]);
    expect(r.error).toBeNull();
    expect(r.frames[0]).toEqual(r.frames[1]);
    expect(r.frames[2]).not.toEqual(r.frames[1]);
  }, 120_000);
});

// The real look's stones and their level of detail, drawn in headless Chromium
// (SwiftShader without a GPU). Split from render.test.ts so CI shards can run
// the slow drawing tests side by side; the soft shadows are render-real-shadows.test.ts. Correctness only:
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
});

// The real look's sky, ground, floor and hills, drawn in headless Chromium
// (SwiftShader without a GPU). Split from render.test.ts so CI shards can run
// the slow drawing tests side by side. Correctness only: timings from here
// are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('real look ground: textured floor keeps its brightness, gravel and dirt differ, variation, relief and patches show, texture 0 is the flat floor', async (ctx) => {
    if (!gpu) return ctx.skip();
    const bare = { groundRelief: 0, groundPatches: 0 };
    const r = await call('groundChecks', [{ groundDetail: 0, hills: 0 }, { realDiag: 'ground-off' }, {}, { groundMaterial: 'dirt' }, { groundVariation: 0, ...bare }, { groundVariation: 1, ...bare }, { groundScale: 4 }, bare, { ...bare, groundRelief: 2 }, { ...bare, groundPatches: 0.3 }]);
    expect(r.error).toBeNull();
    const [flat, off, gravel, dirt, still, varied, coarse, plain, relief, patches] = r.frames;
    // Compiled out, the ground knobs do nothing, and the frame is texture 0's to the bit.
    expect(off!.hash).toBe(flat!.hash);
    // Measured on SwiftShader (mean luma; fine detail, mean |luma - neighbours|; coarse, std of 16 px block means):
    // flat 123.1, 0.42, 2.4 (dither and the light's gradient); gravel 121.1, 1.48, 3.0; dirt 121.1, 0.68, 3.1;
    // without relief and patches: 121.7, 1.50, 2.6; and variation 0: 122.8, 1.51, 2.2; variation 1: 120.5, 1.51, 3.5;
    // relief 2 m: 120.2, 1.54, 4.6; patches 0.3: 121.7, 1.24, 2.6; scale 4: 123.8, 1.72, 2.5.
    // Without macro variation the floor keeps its brightness within 5%; with it, this 20 m patch is one sample of a 64 m field.
    expect(Math.abs(still!.mean - flat!.mean) / flat!.mean).toBeLessThan(0.05);
    for (const f of [gravel, dirt, varied, coarse, relief, patches]) expect(Math.abs(f!.mean - flat!.mean) / flat!.mean).toBeLessThan(0.08);
    expect(gravel!.detail).toBeGreaterThan(2.5 * flat!.detail);
    expect(dirt!.detail).toBeGreaterThan(1.3 * flat!.detail);
    expect(gravel!.detail).toBeGreaterThan(1.5 * dirt!.detail);
    expect(coarse!.detail).toBeGreaterThan(1.1 * plain!.detail); // pebbles 4x larger: more of them span pixels
    // Variation 1 vs 0: 1.6x (2.1x before the macro layer's brightness was split over three scales, 2026-10-27).
    expect(varied!.coarse).toBeGreaterThan(1.4 * still!.coarse);
    // The relief shows as metre-scale shading, growing with its depth (1.16x at the default 1 m, 1.8x at 2 m) ...
    expect(relief!.coarse).toBeGreaterThan(1.5 * plain!.coarse);
    expect(gravel!.coarse).toBeGreaterThan(plain!.coarse);
    expect(gravel!.coarse).toBeLessThan(relief!.coarse);
    // ... and patches of dirt calm the gravel's fine detail where they lie (0.83x at a 0.3 share).
    expect(patches!.detail).toBeLessThan(0.9 * plain!.detail);
  }, 240_000); // ten renderers, each baking its materials: 40 s alone on SwiftShader, about 90 s in the full suite

  it('world scale: a world of quarter- or half-metre units draws its ground, air and sky as the unit world seen from as far in metres', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('metricGround', [1, 0.25, 0.5, 2]);
    expect(r.error).toBeNull();
    // Powers of two scale every length exactly in f32, so the frames match but for rounding: measured, no channel
    // off by more than 1 (of 255), and 1.2 to 4.6% of channels off by 1. A missed conversion (the haze, a tile) moves the whole frame.
    for (const c of r.cases) { expect(c.max).toBeLessThanOrEqual(1); expect(c.mean).toBeLessThan(0.1); }
  }, 120_000);

  it('real look ground: no seam where the floor polygon ends and the sky pass shades the ground on', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('groundSeam', [{ groundDetail: 0 }, {}, { groundMaterial: 'dirt', groundVariation: 1 }]);
    expect(r.error).toBeNull();
    expect(r.cut).toBeGreaterThan(10);
    expect(r.cut).toBeLessThan(80);
    // Across the cut (rows cut-1 to cut+2), the change beyond what the rows on either side change over 3 rows.
    const excess = r.rows.map((m) => Math.abs(m[r.cut - 1]! - m[r.cut + 2]!) - (Math.abs(m[r.cut - 4]! - m[r.cut - 1]!) + Math.abs(m[r.cut + 2]! - m[r.cut + 5]!)) / 2);
    // Measured on SwiftShader (8-bit luma): flat 0.04, gravel 0.37, dirt at full variation 0.25. Before the far
    // ground took the material's mean roughness and cavity, gravel's cut showed as a 1.8 step.
    for (const e of excess) expect(e).toBeLessThan(1);
  });

  it('real look horizon hills: cover the sky just above the horizon, not above the ridge, and fade into the haze with distance', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('hillChecks', [{ hills: 0 }, { hills: 8 }, { hills: 8, hillDistance: 2 }, { hills: 8, hillDistance: 40 }, { hills: 8, realDiag: 'ground-off' }, { hills: 0, groundDetail: 0 }]);
    for (const f of r.frames) expect(f.rows).toEqual([1, 3]);
    expect(r.error).toBeNull();
    const [none, hills, near, far, off, flat] = r.frames;
    const d = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    // Measured on SwiftShader (sRGB of the low band): sky 159.6, 158.4, 158.1; hills at 6 km 141.6, 136.2, 129.6;
    // at 2 km 123.0, 116.5, 108.6; at 40 km (visibility 40 km) 159.4, 157.8, 157.2.
    // Above the ridge, the sky is untouched.
    for (const f of [hills, near, far]) expect(d(f!.high, none!.high)).toBeLessThan(1);
    // Just above the horizon, hills instead of sky.
    expect(d(hills!.low, none!.low)).toBeGreaterThan(10);
    // Nearer hills stand out more from the sky; far ones fade into it.
    expect(d(near!.low, none!.low)).toBeGreaterThan(d(hills!.low, none!.low));
    expect(d(far!.low, none!.low)).toBeLessThan(d(hills!.low, none!.low));
    // Compiled out with the ground, the hills are gone, and the frame is the flat floor's under a bare horizon.
    expect(off!.hash).toBe(flat!.hash);
  }, 180_000); // six renderers, each baking its materials

  it('real look floor: open shadow lit by the whole sky; a street sees sunlit walls where the sky is hidden', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('floorChecks', [{}, { realDiag: 'no-floor-sky' }]);
    expect(r.error).toBeNull();
    const [f, vertical] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader (sRGB luma): lit 127, open shadow 53; before the floor kept its contact
    // darkening, open shadow 31. In linear light 53 against 127 is about 0.15, the share of a clear
    // sky's light at 35 degrees of sun; 31 was about 0.05.
    expect(f!.openShadow).toBeGreaterThan(0.36 * f!.lit);
    expect(f!.openShadow).toBeLessThan(0.6 * f!.lit);
    // The street (8 m walls, 4 m apart) sees about a third sky, the rest walls (floorSky,
    // realBounce): a little brighter, and warm. Measured luma 61 against 54 in the open, red / blue
    // 1.18 against 0.74; the vertical-only sky term (no-floor-sky) had the street at 54 and 0.71.
    expect(f!.street).toBeGreaterThan(0.9 * f!.openShadow);
    expect(f!.street).toBeLessThan(1.3 * f!.openShadow);
    expect(f!.streetRB).toBeGreaterThan(1.15 * f!.openShadowRB);
    // The baked sky view factor against a cosine-weighted ray cast of these three walls (200k rays):
    // street 0.32, open shadow 0.91, lit 0.91. Measured 0.40, 0.94, 0.95: the 1 m occupancy level
    // lets some light through a 1 m wall that straddles two of its voxels (S14's 4 m towers do not).
    expect(Math.abs(f!.streetSky - 0.32)).toBeLessThan(0.1);
    expect(Math.abs(f!.openShadowSky - 0.91)).toBeLessThan(0.05);
    expect(Math.abs(f!.litSky - 0.91)).toBeLessThan(0.06);
    expect(Math.abs(vertical!.streetRB / vertical!.openShadowRB - 1)).toBeLessThan(0.05);
    // In the open, the wall 9 m away hides 6% of the sky: a little more light, not less.
    expect(f!.openShadow / vertical!.openShadow - 1).toBeGreaterThanOrEqual(0);
    expect(f!.openShadow / vertical!.openShadow - 1).toBeLessThan(0.03);
  });

  it('real look: blue sky paling to the horizon, exposure adapting to a low sun, no stylized lights', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('realChecks', ['hazy', {}, { sunElevation: 4, sunAzimuth: 200 }, { sunElevation: 4, sunAzimuth: 200, autoExposure: 0 }]);
    expect(r.error).toBeNull();
    const [hazy, noon, low, lowFixed] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader: high sky b/r 1.99, just above the horizon 1.04; the low sun's horizon r/b 1.55.
    const br = (c: number[]) => c[2]! / c[0]!;
    expect(br(noon!.top)).toBeGreaterThan(1.6);
    expect(br(noon!.horizon)).toBeLessThan(0.65 * br(noon!.top));
    expect(br(low!.horizon)).toBeLessThan(0.8);
    // Mean luma 124 at noon; at 4 degrees 116 adapting (0.75), 46 fixed: partial adaptation keeps dusk a little darker.
    expect(low!.meanLuma).toBeGreaterThan(0.75 * noon!.meanLuma);
    expect(low!.meanLuma).toBeLessThan(noon!.meanLuma);
    expect(lowFixed!.meanLuma).toBeLessThan(0.5 * noon!.meanLuma);
    // The ball is a light in hazy; real has no stylized lights.
    expect(hazy!.lit).toBe(1);
    expect(noon!.lit).toBe(0);
    expect(low!.lit).toBe(0);
  });
});

// The real look's sky and horizon hills, drawn in headless Chromium
// (SwiftShader without a GPU). Split from render-real-ground.test.ts so no
// file passes CI's 300 s per file. Correctness only: timings from here
// are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('real look horizon hills: cover the sky just above the horizon, not above the ridge, and fade into the haze with distance', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Bare single-ridge hills (the hills before cover and ridges, 2026-11-02): the values below were measured on them.
    const bare = { hillCover: 0, hillRidges: 1 };
    const r = await call('hillChecks', [{ hills: 0 }, { hills: 8, ...bare }, { hills: 8, hillDistance: 2, ...bare }, { hills: 8, hillDistance: 40, ...bare }, { hills: 8, realDiag: 'ground-off' }, { hills: 0, groundDetail: 0 }]);
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

  it('real look horizon hills: scrub cover and a nearer ridge make the default hills stand out from the sky, warm, with the sky above untouched', async (ctx) => {
    if (!gpu) return ctx.skip();
    const bare = { hillCover: 0, hillRidges: 1 };
    const r = await call('hillChecks', [{ hills: 0 }, bare, {}, { hills: 8, hillRidges: 1 }, { hills: 8 }]);
    expect(r.error).toBeNull();
    const [sky, bareHills, hills, one, two] = r.frames;
    const d = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
    // Measured on SwiftShader (sRGB of the band 0.3 to 0.7 degrees up): sky 159.6, 158.4, 158.1; at the default
    // height the bare hills 141.1, 136.6, 131.5 (beside a plain of about the same colour, they vanished: Will's
    // "hills faint at default haze"), the default ones 121.0, 117.0, 111.2: twice as far from the sky (1.9x).
    expect(d(hills!.low, sky!.low)).toBeGreaterThan(1.5 * d(bareHills!.low, sky!.low));
    // Darker than the sky and warm (red over blue), not a blue band.
    for (let c = 0; c < 3; c++) expect(hills!.low[c]!).toBeLessThan(sky!.low[c]! - 30);
    expect(hills!.low[0]! - hills!.low[2]!).toBeGreaterThan(5);
    // 8 degree hills, whose cover is mostly thinned at this band near their foot: the second ridge, nearer and
    // through less haze, darkens it (one ridge 137.6, 132.6, 126.2; two 111.4, 107.3, 101.1).
    for (let c = 0; c < 3; c++) expect(two!.low[c]!).toBeLessThan(one!.low[c]! - 15);
    // Above every ridge, the sky is as without hills.
    for (const f of [bareHills, hills, one, two]) expect(d(f!.high, sky!.high)).toBeLessThan(1);
  }, 180_000); // five renderers, each baking its materials

  it('real look looking up (the viewer\'s negative pitch): sky to the zenith, no errors, the exposure as at the horizon', async (ctx) => {
    if (!gpu) return ctx.skip();
    const frames = [];
    const views: [[number, number, number], [number, number, number]][] = [[[0, 2, 9], [0, 2.6, -1]], [[0, 1.5, 14], [0, 40, 0]], [[0, 0.3, 3], [0.2, 60, -0.5]]];
    for (const [eye, target] of views) {
      const r = await call('lookFrame', {}, eye, target);
      expect(r.error).toBeNull();
      const band = (r0: number, r1: number) => {
        const m = [0, 0, 0];
        for (let y = r0; y < r1; y++) for (let x = 0; x < r.width; x++) for (let c = 0; c < 3; c++) m[c] = m[c]! + r.data[y * r.bytesPerRow + 4 * x + c]! / ((r1 - r0) * r.width);
        return m;
      };
      frames.push({ mean: r.meanLuma, top: band(0, 8), bottom: band(r.height - 8, r.height) });
    }
    // Measured on SwiftShader: mean luma 131 at the horizon, 88 and 95 looking up (the high sky is a deeper
    // blue than the horizon's; the meter does not depend on the view, so this is the sky, not the exposure);
    // blue / red 2.0 to 2.3 in the bands looking up, every channel at least 56.
    // Inside the hall, the vault overhead.
    const hall = await call('lookFrame', { env: 'hall' }, [0, 1.5, 14], [0, 40, 0]);
    expect(hall.error).toBeNull();
    // Measured 115 against the open sky's 88 from the same eye: the glazed vault, not the sky.
    expect(Math.abs(hall.meanLuma - frames[1]!.mean)).toBeGreaterThan(10);
    expect(hall.meanLuma).toBeGreaterThan(30);
    expect(hall.meanLuma).toBeLessThan(230);
    const [level, ...up] = frames;
    for (const f of up) {
      expect(f.mean).toBeGreaterThan(0.5 * level!.mean);
      expect(f.mean).toBeLessThan(level!.mean);
      for (const b of [f.top, f.bottom]) {
        expect(b[2]! / b[0]!).toBeGreaterThan(1.4);
        expect(Math.min(...b)).toBeGreaterThan(40);
      }
    }
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

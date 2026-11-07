// The real look's soft shadows, drawn in headless Chromium (SwiftShader without
// a GPU). Split from render-real-stones.test.ts so neither file passes CI's
// 300 s (stones took 169-342 s on runners). Correctness only: timings from here
// are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
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

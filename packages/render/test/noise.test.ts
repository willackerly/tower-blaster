// Tileable noise (noise.ts) on the CPU.
import { describe, expect, it } from 'vitest';
import { fbm, gnoise, pcg3d, worley } from '../src/noise.ts';

describe('noise', () => {
  it('pcg3d is deterministic, 32-bit, and one input step flips about half the output bits', () => {
    expect(pcg3d(0, 0, 0)).toEqual(pcg3d(0, 0, 0));
    const a = pcg3d(1, 2, 3), b = pcg3d(2, 2, 3);
    expect(a.every((x) => Number.isInteger(x) && x >= 0 && x < 2 ** 32)).toBe(true);
    // One input step flips about half the output bits.
    const flips = a.reduce((s, x, k) => s + (x ^ b[k]!).toString(2).split('').filter((c) => c === '1').length, 0);
    expect(flips).toBeGreaterThan(30);
    expect(flips).toBeLessThan(66);
  });

  it('gnoise, fbm and worley repeat with their period, and stay in range', () => {
    let lo = Infinity, hi = -Infinity;
    for (let k = 0; k < 500; k++) {
      const x = (k * 0.6180339) % 7, y = (k * 0.4142135) % 7;
      const g = gnoise(x, y, 7, 5);
      expect(gnoise(x + 7, y - 14, 7, 5)).toBeCloseTo(g, 12);
      expect(fbm(x + 7, y, 7, 5, 5)).toBeCloseTo(fbm(x, y, 7, 5, 5), 12);
      const w = worley(x, y, 7, 5), w2 = worley(x - 7, y + 7, 7, 5);
      expect(w2[0]).toBeCloseTo(w[0], 12);
      expect(w2[2]).toBe(w[2]);
      expect(w[0]).toBeLessThanOrEqual(w[1]);
      lo = Math.min(lo, g); hi = Math.max(hi, g);
    }
    // 2D gradient noise with unit gradients is bounded by sqrt(2)/2.
    expect(lo).toBeGreaterThan(-Math.SQRT1_2);
    expect(hi).toBeLessThan(Math.SQRT1_2);
    expect(hi - lo).toBeGreaterThan(0.6);
    // Zero at lattice points.
    expect(gnoise(3, 4, 7, 5)).toBe(0);
  });
});

// The stone functions (materials.ts) on the CPU; render.test.ts compares the GPU bake with them.
import { describe, expect, it } from 'vitest';
import { STONES, stoneSample } from '../src/materials.ts';

describe('stones', () => {
  it('every stone tiles, has a mean albedo multiplier near 1, and stays inside its encodable range', () => {
    for (let layer = 0; layer < STONES.length; layer++) {
      const n = 64, mean = [0, 0, 0];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const s = stoneSample(layer, (i + 0.5) / n, (j + 0.5) / n);
        s.albedo.forEach((x, c) => { mean[c] = mean[c]! + x / (n * n); expect(x).toBeGreaterThan(0); expect(x).toBeLessThan(2); });
        expect(s.rough).toBeGreaterThan(0.3);
        expect(s.rough).toBeLessThanOrEqual(1);
        expect(Math.abs(s.height)).toBeLessThan(0.004);
      }
      for (const m of mean) { expect(m, STONES[layer]).toBeGreaterThan(0.8); expect(m, STONES[layer]).toBeLessThan(1.15); }
      // u = 0 and u = 1 are the same texel.
      for (const v of [0.1, 0.37, 0.8]) expect(stoneSample(layer, 1, v).height).toBeCloseTo(stoneSample(layer, 0, v).height, 9);
    }
  });
});

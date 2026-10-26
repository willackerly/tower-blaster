// The stone and ground functions (materials.ts) on the CPU; render.test.ts compares the GPU bake with them.
import { describe, expect, it } from 'vitest';
import { GROUND_LAYER, GROUND_TILE, GROUNDS, groundSample, layerTile, MACRO_LAYER, MACRO_TILE, macroSample, MATERIAL_TILE, materialSample, STONES, stoneSample } from '../src/materials.ts';

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

describe('grounds and the macro layer', () => {
  it('every ground tiles, keeps the configured albedo within 5% on average, and stays inside its encodable range', () => {
    // Measured (128 x 128): gravel 1.008, 0.993, 0.976; dirt 1.014, 0.994, 0.964.
    for (let k = 0; k < GROUNDS.length; k++) {
      const n = 64, mean = [0, 0, 0];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const s = groundSample(k, (i + 0.5) / n, (j + 0.5) / n);
        s.albedo.forEach((x, c) => { mean[c] = mean[c]! + x / (n * n); expect(x).toBeGreaterThan(0.3); expect(x).toBeLessThan(2); });
        expect(s.rough).toBeGreaterThan(0.5);
        expect(s.rough).toBeLessThanOrEqual(1);
        expect(Math.abs(s.height)).toBeLessThan(0.012);
        expect(s.cavity).toBeGreaterThan(0.3);
      }
      for (const m of mean) { expect(m, GROUNDS[k]).toBeGreaterThan(0.95); expect(m, GROUNDS[k]).toBeLessThan(1.05); }
      for (const v of [0.1, 0.37, 0.8]) {
        expect(groundSample(k, 1, v).height).toBeCloseTo(groundSample(k, 0, v).height, 9);
        expect(groundSample(k, v, 1).height).toBeCloseTo(groundSample(k, v, 0).height, 9);
      }
      expect(materialSample(GROUND_LAYER + k, 0.3, 0.6)).toEqual(groundSample(k, 0.3, 0.6));
    }
    expect(layerTile(0)).toBe(MATERIAL_TILE);
    expect(layerTile(GROUND_LAYER)).toBe(GROUND_TILE);
    expect(layerTile(MACRO_LAYER)).toBe(MACRO_TILE);
  });

  it('the macro layer is 0.5 on average in each channel, varies, and tiles', () => {
    const n = 64, mean = [0, 0, 0], sq = [0, 0, 0];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const m = macroSample((i + 0.5) / n, (j + 0.5) / n);
      for (let c = 0; c < 3; c++) { expect(m[c]).toBeGreaterThanOrEqual(0); expect(m[c]).toBeLessThanOrEqual(1); mean[c] = mean[c]! + m[c]! / (n * n); sq[c] = sq[c]! + m[c]! ** 2 / (n * n); }
      expect(m[3]).toBe(1);
    }
    for (let c = 0; c < 3; c++) {
      expect(mean[c]).toBeCloseTo(0.5, 1);
      expect(Math.sqrt(sq[c]! - mean[c]! ** 2)).toBeGreaterThan(0.08); // brightness, tint and blend all vary
    }
    for (const v of [0.1, 0.37, 0.8]) expect(macroSample(1, v)[0]).toBeCloseTo(macroSample(0, v)[0], 9);
  });
});

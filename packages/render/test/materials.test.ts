// The stone and ground functions (materials.ts) on the CPU; render.test.ts compares the GPU bake with them.
import { describe, expect, it } from 'vitest';
import { pcg3d } from '../src/noise.ts';
import { GROUND_LAYER, GROUND_TILE, GROUNDS, groundSample, layerTile, MACRO_LAYER, MACRO_TILE, macroSample, MATERIAL_SIZE, MATERIAL_TILE, materialSample, patchThreshold, probit, STONES, stoneSample, WOOD, WOOD_RING_M, woodRings } from '../src/materials.ts';

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

describe('wood', () => {
  const hash = (slot: number) => pcg3d(slot, 0x3779, 0x9e3d);
  // A Kapla plank, metres: across (a), thickness (b), along the grain (g).
  const half = [0.0117, 0.0039, 0.0585] as const;
  function rng(seed: number) {
    let s = seed >>> 0;
    return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  }
  const at = (r: () => number) => half.map((h) => (2 * r() - 1) * h) as [number, number, number];
  const cyc = (x: number) => Math.min(x - Math.floor(x), Math.ceil(x) - x); // distance to the nearest whole number

  it('pine is a stone like the others, and its fibre layer tiles in both directions', () => {
    expect(STONES[WOOD]).toBe('pine');
    for (const t of [0.1, 0.37, 0.8]) {
      expect(stoneSample(WOOD, 1, t).height).toBeCloseTo(stoneSample(WOOD, 0, t).height, 9);
      expect(stoneSample(WOOD, t, 1).height).toBeCloseTo(stoneSample(WOOD, t, 0).height, 9);
    }
  });

  it('the rings keep the block colour on average, darker in the latewood', () => {
    const r = rng(9);
    let sum = 0, late = 0, n = 0;
    for (let slot = 0; slot < 200; slot++) for (let i = 0; i < 200; i++) {
      const [a, b, g] = at(r), w = woodRings(a, b, g, hash(slot), WOOD_RING_M, 1e-5);
      sum += w.albedo; late += w.late; n++;
      expect(w.albedo < 1).toBe(w.late > 0.33);
    }
    expect(sum / n).toBeCloseTo(1, 1);
    expect(Math.abs(sum / n - 1)).toBeLessThan(0.02);
    expect(late / n).toBeCloseTo(0.33, 1);
  });

  it('fade to exactly the mean once a pixel covers half a ring (the widest, 1.3x), and never step faster than the fade assumes', () => {
    const r = rng(10);
    for (let k = 0; k < 2000; k++) {
      const [a, b, g] = at(r), w = woodRings(a, b, g, hash(k), WOOD_RING_M, 0.5 * 1.3 * WOOD_RING_M);
      expect(w.albedo).toBeCloseTo(1, 12);
      expect(w.late).toBeCloseTo(0.33, 12);
    }
    // The fade takes the ring phase to change at most 1 per ring spacing of distance:
    // here at most 1.05 (the pith line's 3% tilt and the wobble add a little; measured 1.0004).
    let worst = 0;
    for (let k = 0; k < 4000; k++) {
      const p = at(r), d = [r() - 0.5, r() - 0.5, r() - 0.5], l = Math.hypot(...d), step = 1e-5;
      const q = p.map((x, j) => x + (step * d[j]!) / l) as [number, number, number];
      const h = hash(k), s = 0.7 + 0.6 * h[0] / 2 ** 32;
      const dp = cyc(woodRings(...q, h, WOOD_RING_M, 0).phase - woodRings(...p, h, WOOD_RING_M, 0).phase);
      worst = Math.max(worst, dp / (step / (WOOD_RING_M * s)));
    }
    expect(worst).toBeGreaterThan(0.9);
    expect(worst).toBeLessThan(1.05);
  });

  it('end faces show arcs, faces along the grain long stripes: the phase changes far faster across the grain than along it', () => {
    const r = rng(11);
    let across = 0, along = 0;
    for (let k = 0; k < 2000; k++) {
      const [a, b, g] = at(r), h = hash(k), step = 1e-4;
      const p0 = woodRings(a, b, g, h, WOOD_RING_M, 0).phase;
      across += cyc(woodRings(a + step, b, g, h, WOOD_RING_M, 0).phase - p0) + cyc(woodRings(a, b + step, g, h, WOOD_RING_M, 0).phase - p0);
      along += 2 * cyc(woodRings(a, b, g + step, h, WOOD_RING_M, 0).phase - p0);
    }
    expect(across / along).toBeGreaterThan(10); // measured 42
  });
});

describe('grounds and the macro layer', () => {
  it('every ground tiles, keeps the configured albedo within 5% on average, and stays inside its encodable range', () => {
    // Measured (128 x 128): gravel 1.027, 1.007, 0.984; dirt 1.014, 0.994, 0.964.
    for (let k = 0; k < GROUNDS.length; k++) {
      const n = 64, mean = [0, 0, 0];
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
        const s = groundSample(k, (i + 0.5) / n, (j + 0.5) / n);
        s.albedo.forEach((x, c) => { mean[c] = mean[c]! + x / (n * n); expect(x).toBeGreaterThan(0.3); expect(x).toBeLessThan(2); });
        expect(s.rough).toBeGreaterThan(0.5);
        expect(s.rough).toBeLessThanOrEqual(1);
        expect(Math.abs(s.height)).toBeLessThan(0.012);
        expect(s.cavity).toBeGreaterThan(0.1);
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

  it('probit is the standard normal quantile', () => {
    // Reference values to 7 digits (any table of the normal distribution).
    for (const [p, z] of [[0.5, 0], [0.975, 1.959964], [0.9, 1.281552], [0.99, 2.326348], [0.999, 3.090232], [0.01, -2.326348], [0.2, -0.8416212]] as const) expect(probit(p)).toBeCloseTo(z, 6);
    for (const p of [0.003, 0.1, 0.37]) expect(probit(p)).toBeCloseTo(-probit(1 - p), 9);
    for (const p of [0, 1, -0.1, Number.NaN]) expect(() => probit(p)).toThrow(/probit/);
  });

  it('patchThreshold leaves the asked share of the ground above it in the patch field the shader builds', () => {
    // The shader's patch field up close: 0.55 x the macro b at level 3.5 (trilinear: the mean of levels 3 and 4
    // at one spot) plus 0.45 x level 4 at an unrelated spot (another scale, turned). Levels are box mips of the bake.
    const n = MATERIAL_SIZE, b = new Float64Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) b[j * n + i] = macroSample((i + 0.5) / n, (j + 0.5) / n)[2];
    const level = (f: number) => {
      const m = n / f, o = new Float64Array(m * m);
      for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) o[Math.floor(j / f) * m + Math.floor(i / f)]! += b[j * n + i]! / (f * f);
      return o;
    };
    const l3 = level(8), l4 = level(16);
    const m1 = Array.from(l3, (v, k) => 0.5 * (v + l4[Math.floor(Math.floor(k / 64) / 2) * 32 + Math.floor((k % 64) / 2)]!));
    const share = (t: number) => { let c = 0; for (const a of m1) for (const c2 of l4) if (0.55 * a + 0.45 * c2 > t) c++; return c / (m1.length * l4.length); };
    // Measured: 0.01 -> 0.0093, 0.025 -> 0.023, 0.1 -> 0.096, 0.3 -> 0.29 (the field is close to normal).
    for (const s of [0.01, 0.025, 0.1, 0.3]) expect(Math.abs(share(patchThreshold(s)) - s) / s).toBeLessThan(0.25);
    expect(patchThreshold(0)).toBeGreaterThan(1);
    expect(patchThreshold(1)).toBeLessThan(0);
    expect(patchThreshold(0.01)).toBeGreaterThan(patchThreshold(0.1));
  });
});

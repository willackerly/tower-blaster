import { describe, expect, it } from 'vitest';
import { combineFriction, combineRestitution, DEFAULT_RESTITUTION_COMBINE, freeFlight } from '../src/index.ts';

describe('combineFriction', () => {
  it('follows Rapier\'s four rules', () => {
    expect(combineFriction('average', 0.3, 0.9)).toBeCloseTo(0.6, 15);
    expect(combineFriction('min', 0.3, 0.9)).toBe(0.3);
    expect(combineFriction('max', 0.3, 0.9)).toBe(0.9);
    expect(combineFriction('multiply', 0.3, 0.9)).toBeCloseTo(0.27, 15);
  });
});

describe('combineRestitution', () => {
  it('follows the same four rules, and defaults to Rapier\'s average', () => {
    for (const rule of ['average', 'min', 'max', 'multiply'] as const) expect(combineRestitution(rule, 0.05, 0.6)).toBe(combineFriction(rule, 0.05, 0.6));
    expect(combineRestitution(DEFAULT_RESTITUTION_COMBINE, 0.05, 0.6)).toBeCloseTo(0.325, 15);
  });
});

describe('freeFlight', () => {
  it('with one substep is semi-implicit Euler: v_n = v0 + n h g, x_n = x0 + n h v0 + h^2 g n(n+1)/2', () => {
    const h = 1 / 60, g = -9.81, n = 60;
    const r = freeFlight([1, 10, 0], [2, 8, 0], [0, g, 0], h, 1, n);
    expect(r.vel[1]).toBeCloseTo(8 + n * h * g, 12);
    expect(r.pos[1]).toBeCloseTo(10 + n * h * 8 + h * h * g * n * (n + 1) / 2, 12);
    expect(r.pos[0]).toBeCloseTo(1 + n * h * 2, 12);
  });

  it('converges to the exact parabola as substeps grow, lying g h t / (2 substeps) off it (below, as g < 0)', () => {
    const h = 1 / 60, g = -9.81, t = 1;
    const exact = 10 + 8 * t + (g * t * t) / 2;
    for (const s of [1, 4, 16]) {
      const y = freeFlight([0, 10, 0], [0, 8, 0], [0, g, 0], h, s, 60).pos[1]!;
      expect(y - exact).toBeCloseTo((g * h * t) / (2 * s), 9);
    }
  });
});

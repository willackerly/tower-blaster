// boxBoxSeparation: the broadphase's box test (Kapla step K2.1) must never
// drop a pair the narrowphase would give a contact.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Quat, Vec3 } from '@tb/engine-api';
import { boxBoxDepth, boxBoxManifold, boxBoxSeparation, NO_AXIS, obb, quatFromAxisAngle, quatNormalize } from '../src/index.ts';

const I: Quat = [0, 0, 0, 1];
const deg = Math.PI / 180;

const vec = (lo: number, hi: number) => fc.tuple(fc.double({ min: lo, max: hi, noNaN: true }), fc.double({ min: lo, max: hi, noNaN: true }), fc.double({ min: lo, max: hi, noNaN: true }));
const quat = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: 0.05, max: 1, noNaN: true }))
  .map((q) => quatNormalize(q as Quat));
// Cubes and Kapla planks (5 x 1 x 1/3), in any order of axes.
const half = fc.oneof(vec(0.1, 1), fc.constantFrom<Vec3>([2.5, 0.5, 1 / 6], [0.5, 1 / 6, 2.5], [1 / 6, 2.5, 0.5]));

describe('boxBoxSeparation', () => {
  it('is the gap between face-aligned boxes, and minus the overlap when they overlap', () => {
    expect(boxBoxSeparation(obb([0, 0, 0], I, [0.5, 0.5, 0.5]), obb([0, 1.1, 0], I, [0.5, 0.5, 0.5]))).toBeCloseTo(0.1, 12);
    expect(boxBoxSeparation(obb([0, 0, 0], I, [2.5, 1 / 6, 0.5]), obb([0, 0.3, 0], I, [0.5, 1 / 6, 2.5]))).toBeCloseTo(0.3 - 1 / 3, 12);
    // Crossed edges: two cubes turned 45 deg about z and x, edge to edge, 0.01 apart.
    const a = obb([0, 0, 0], quatFromAxisAngle([0, 0, 1], 45 * deg), [0.5, 0.5, 0.5]);
    const b = obb([0, Math.SQRT2 + 0.01, 0], quatFromAxisAngle([1, 0, 0], 45 * deg), [0.5, 0.5, 0.5]);
    expect(boxBoxSeparation(a, b)).toBeCloseTo(0.01, 9);
  });

  it('a manifold within margin m means a separation of at most m (so the box broadphase drops no contact)', () => {
    fc.assert(fc.property(vec(-3, 3), quat, half, quat, half, fc.double({ min: 0, max: 0.5, noNaN: true }), fc.integer({ min: 0, max: 15 }), (d, qa, ha, qb, hb, margin, hint) => {
      const a = obb([0, 0, 0], qa, ha), b = obb(d as Vec3, qb, hb);
      const m = boxBoxManifold(a, b, margin, true, hint === 15 ? NO_AXIS : hint);
      if (m) expect(boxBoxSeparation(a, b)).toBeLessThanOrEqual(margin);
    }), { numRuns: 20000, seed: 55 });
  });

  it('is negative exactly when the boxes overlap (boxBoxDepth > 0), and symmetric', () => {
    fc.assert(fc.property(vec(-3, 3), quat, half, quat, half, (d, qa, ha, qb, hb) => {
      const a = obb([0, 0, 0], qa, ha), b = obb(d as Vec3, qb, hb);
      const s = boxBoxSeparation(a, b);
      expect(boxBoxSeparation(b, a)).toBeCloseTo(s, 9);
      if (Math.abs(s) > 1e-9) expect(boxBoxDepth(a, b) > 0).toBe(s < 0);
      if (s < 0) expect(boxBoxDepth(a, b)).toBeCloseTo(-s, 9);
    }), { numRuns: 5000, seed: 56 });
  });
});

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@tb/engine-api';
import {
  add, boxBoxDepth, length, obb, quatAngle, quatFromAxisAngle, quatMul, quatNormalize, rotate,
  shapeDepth, signedDepth, signedGroundDepth, sphereBoxDepth, spherePairs, sub, QUAT_IDENTITY,
} from '../src/index.ts';

const vec = (lo = -5, hi = 5) => fc.tuple(fc.double({ min: lo, max: hi, noNaN: true }), fc.double({ min: lo, max: hi, noNaN: true }), fc.double({ min: lo, max: hi, noNaN: true })) as fc.Arbitrary<Vec3>;
const quat = fc
  .tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }))
  .filter((q) => Math.hypot(...q) > 0.1)
  .map((q) => quatNormalize(q as Quat));
const half = fc.tuple(fc.double({ min: 0.05, max: 2, noNaN: true }), fc.double({ min: 0.05, max: 2, noNaN: true }), fc.double({ min: 0.05, max: 2, noNaN: true })) as fc.Arbitrary<Vec3>;
const close = (a: number, b: number, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe('quaternions', () => {
  it('rotates x to y by 90 degrees about z', () => {
    const r = rotate(quatFromAxisAngle([0, 0, 1], Math.PI / 2), [1, 0, 0]);
    close(r[0], 0); close(r[1], 1); close(r[2], 0);
  });
  it('composes like sequential rotation and preserves length', () => {
    fc.assert(fc.property(quat, quat, vec(), (a, b, v) => {
      const seq = rotate(a, rotate(b, v));
      const comp = rotate(quatMul(a, b), v);
      expect(length(sub(seq, comp))).toBeLessThan(1e-9 * (1 + length(v)));
      close(length(rotate(a, v)), length(v), 1e-9 * (1 + length(v)));
    }));
  });
  it('reports the rotation angle', () => {
    close(quatAngle(quatFromAxisAngle([1, 2, 3], 0.7)), 0.7, 1e-12);
    close(quatAngle(QUAT_IDENTITY), 0);
  });
});

describe('boxBoxDepth (SAT)', () => {
  const u: Vec3 = [0.5, 0.5, 0.5];
  it('gives the overlap of aligned cubes', () => {
    close(boxBoxDepth(obb([0, 0, 0], QUAT_IDENTITY, u), obb([0.9, 0, 0], QUAT_IDENTITY, u)), 0.1, 1e-12);
    close(boxBoxDepth(obb([0, 0, 0], QUAT_IDENTITY, u), obb([0.3, 0.95, 0.1], QUAT_IDENTITY, u)), 0.05, 1e-12);
  });
  it('is zero for separated and touching cubes', () => {
    expect(boxBoxDepth(obb([0, 0, 0], QUAT_IDENTITY, u), obb([1.01, 0, 0], QUAT_IDENTITY, u))).toBe(0);
    expect(boxBoxDepth(obb([0, 0, 0], QUAT_IDENTITY, u), obb([1, 0, 0], QUAT_IDENTITY, u))).toBe(0);
  });
  it('handles a cube balanced on its edge', () => {
    // Rotated 45 degrees about z, the cube reaches sqrt(2)/2 below its centre.
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 4);
    const y = 0.5 + Math.SQRT1_2 - 0.02;
    close(boxBoxDepth(obb([0, 0, 0], QUAT_IDENTITY, u), obb([0, y, 0], q, u)), 0.02, 1e-9);
  });
  it('detects edge-edge separation that face axes miss', () => {
    // Two cubes rotated 45 degrees about different axes, edge to edge: only a
    // cross-product axis separates them.
    const a = obb([0, 0, 0], quatFromAxisAngle([0, 0, 1], Math.PI / 4), u);
    const b = obb([0, 2 * Math.SQRT1_2 + 0.01, 0], quatFromAxisAngle([1, 0, 0], Math.PI / 4), u);
    expect(boxBoxDepth(a, b)).toBe(0);
  });
  it('is symmetric and invariant under rigid motion', () => {
    fc.assert(fc.property(vec(-1.5, 1.5), quat, half, quat, half, quat, vec(), (d, qa, ha, qb, hb, qr, t) => {
      const A = obb([0, 0, 0], qa, ha), B = obb(d, qb, hb);
      const ab = boxBoxDepth(A, B);
      close(ab, boxBoxDepth(B, A), 1e-9);
      const A2 = obb(t, quatMul(qr, qa), ha), B2 = obb(add(rotate(qr, d), t), quatMul(qr, qb), hb);
      close(ab, boxBoxDepth(A2, B2), 1e-7);
    }));
  });
});

describe('sphereBoxDepth', () => {
  const b = obb([0, 0, 0], QUAT_IDENTITY, [0.5, 0.5, 0.5]);
  it('measures face, edge and inside cases', () => {
    close(sphereBoxDepth([0, 1.2, 0], 0.8, b), 0.1, 1e-12);
    close(sphereBoxDepth([1, 1, 0], Math.SQRT1_2 + 0.05, b), 0.05, 1e-12);
    close(sphereBoxDepth([0, 0.4, 0], 0.3, b), 0.4, 1e-12);
    expect(sphereBoxDepth([0, 2, 0], 1, b)).toBe(0);
  });
});

describe('spherePairs', () => {
  it('matches brute force', () => {
    fc.assert(fc.property(fc.array(fc.tuple(vec(-6, 6), fc.double({ min: 0.1, max: 1.5, noNaN: true })), { maxLength: 60 }), (items) => {
      const c = items.flatMap(([p]) => p), r = items.map(([, rad]) => rad);
      const brute: Array<[number, number]> = [];
      for (let i = 0; i < r.length; i++) for (let j = i + 1; j < r.length; j++) {
        const d = Math.hypot(c[3 * j]! - c[3 * i]!, c[3 * j + 1]! - c[3 * i + 1]!, c[3 * j + 2]! - c[3 * i + 2]!);
        if (d <= r[i]! + r[j]!) brute.push([i, j]);
      }
      expect(spherePairs(c, r)).toEqual(brute);
    }));
  });
});

describe('signedDepth', () => {
  const box = { kind: 'box' as const, half: [0.5, 0.5, 0.5] as Vec3 }, ball = { kind: 'sphere' as const, radius: 0.5 };
  it('is the gap (negative) for separated shapes and the penetration for overlapping ones', () => {
    close(signedDepth(box, [0, 0, 0], QUAT_IDENTITY, box, [1.2, 0, 0], QUAT_IDENTITY), -0.2, 1e-12);
    close(signedDepth(box, [0, 0, 0], QUAT_IDENTITY, box, [0.9, 0, 0], QUAT_IDENTITY), 0.1, 1e-12);
    close(signedDepth(ball, [0, 0, 0], QUAT_IDENTITY, ball, [0, 1.5, 0], QUAT_IDENTITY), -0.5, 1e-12);
    close(signedDepth(ball, [1.25, 0, 0], QUAT_IDENTITY, box, [0, 0, 0], QUAT_IDENTITY), -0.25, 1e-12);
    close(signedDepth(box, [0, 0, 0], QUAT_IDENTITY, ball, [0.8, 0, 0], QUAT_IDENTITY), 0.2, 1e-12);
    close(signedGroundDepth(box, [0, 2, 0], QUAT_IDENTITY, 0), -1.5, 1e-12);
    close(signedGroundDepth(ball, [0, 0.4, 0], QUAT_IDENTITY, 0), 0.1, 1e-12);
  });

  it('agrees with shapeDepth when they overlap and never claims a gap larger than the true one', () => {
    fc.assert(fc.property(vec(-2, 2), quat, quat, (d, qa, qb) => {
      const a = quatNormalize(qa), b = quatNormalize(qb);
      const s = signedDepth(box, [0, 0, 0], a, box, d, b), p = shapeDepth(box, [0, 0, 0], a, box, d, b);
      if (p > 0) close(s, p, 1e-9);
      else expect(s).toBeLessThanOrEqual(1e-12);
      // The gap is at most the centre distance minus the inscribed radii.
      expect(-s).toBeLessThanOrEqual(length(d) - 1 + 1e-9);
    }));
  });
});

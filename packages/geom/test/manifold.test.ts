import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Quat, Vec3 } from '@tb/engine-api';
import {
  boxBoxDepth, boxBoxManifold, boxGroundManifold, dot, length, obb, quatFromAxisAngle, quatMul, quatNormalize, reduceContacts, rotate,
  sphereBoxManifold, sphereSphereManifold, sub, type Obb,
} from '../src/index.ts';

const I: Quat = [0, 0, 0, 1];
const H: Vec3 = [0.5, 0.5, 0.5];
const deg = Math.PI / 180;

/** Is p inside b inflated by tol? */
function inside(b: Obb, p: Vec3, tol: number): boolean {
  const d = sub(p, b.c);
  return [0, 1, 2].every((k) => Math.abs(dot(d, b.axes[k]!)) <= b.half[k]! + tol);
}

describe('boxBoxManifold', () => {
  it('offset face-on stack: 4 corners of the overlap rectangle, equal depth', () => {
    const a = obb([0, 0, 0], I, H), b = obb([0.3, 0.99, 0.2], I, H);
    const m = boxBoxManifold(a, b)!;
    expect(m.feature).toBe('faceA');
    expect(m.normal).toEqual([0, 1, 0]);
    expect(m.points).toHaveLength(4);
    for (const p of m.points) expect(p.depth).toBeCloseTo(0.01, 12);
    const xs = m.points.map((p) => p.point[0]).sort(), zs = m.points.map((p) => p.point[2]).sort();
    expect([xs[0], xs[3]].map((x) => +x!.toFixed(9))).toEqual([-0.2, 0.5]);
    expect([zs[0], zs[3]].map((z) => +z!.toFixed(9))).toEqual([-0.3, 0.5]);
    for (const p of m.points) expect(p.point[1]).toBeCloseTo(0.495, 12);
  });

  it('is antisymmetric: swapping the boxes flips the normal, same depths', () => {
    const a = obb([0, 0, 0], I, H), b = obb([0.3, 0.99, 0.2], quatFromAxisAngle([0, 1, 0], 10 * deg), H);
    const ab = boxBoxManifold(a, b)!, ba = boxBoxManifold(b, a)!;
    ab.normal.forEach((x, k) => expect(ba.normal[k]).toBeCloseTo(-x, 12));
    expect(ab.points.map((p) => p.depth.toFixed(9)).sort()).toEqual(ba.points.map((p) => p.depth.toFixed(9)).sort());
  });

  it('45° twisted stack: the octagonal overlap is reduced to 4 points', () => {
    const a = obb([0, 0, 0], I, H), b = obb([0, 0.98, 0], quatFromAxisAngle([0, 1, 0], 45 * deg), H);
    const m = boxBoxManifold(a, b)!;
    expect(m.points).toHaveLength(4);
    for (const p of m.points) {
      expect(p.depth).toBeCloseTo(0.02, 9);
      expect(inside(a, p.point, 0.02)).toBe(true);
      expect(inside(b, p.point, 0.02)).toBe(true);
    }
  });

  it('crossed edges: one edge-edge contact', () => {
    const a = obb([0, 0, 0], quatFromAxisAngle([0, 0, 1], 45 * deg), H);
    const b = obb([0, Math.SQRT2 - 0.01, 0], quatFromAxisAngle([1, 0, 0], 45 * deg), H);
    const m = boxBoxManifold(a, b)!;
    expect(m.feature).toBe('edge');
    expect(m.points).toHaveLength(1);
    expect(m.points[0]!.depth).toBeCloseTo(0.01, 9);
    m.points[0]!.point.forEach((x, k) => expect(x).toBeCloseTo([0, Math.SQRT1_2 - 0.005, 0][k]!, 9));
    expect(m.normal[1]).toBeCloseTo(1, 9);
  });

  it('speculative margin: a 3 mm gap gives negative depth inside the margin, nothing outside', () => {
    const a = obb([0, 0, 0], I, H), b = obb([0, 1.003, 0], I, H);
    expect(boxBoxManifold(a, b, 0)).toBeNull();
    const m = boxBoxManifold(a, b, 0.01)!;
    expect(m.points).toHaveLength(4);
    for (const p of m.points) expect(p.depth).toBeCloseTo(-0.003, 12);
  });

  const quat = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: 0.05, max: 1, noNaN: true }))
    .map((q) => quatNormalize(q as Quat));
  const vec = (r: number) => fc.tuple(fc.double({ min: -r, max: r, noNaN: true }), fc.double({ min: -r, max: r, noNaN: true }), fc.double({ min: -r, max: r, noNaN: true })) as fc.Arbitrary<Vec3>;
  const halfs = fc.tuple(fc.double({ min: 0.1, max: 1, noNaN: true }), fc.double({ min: 0.1, max: 1, noNaN: true }), fc.double({ min: 0.1, max: 1, noNaN: true })) as fc.Arbitrary<Vec3>;

  it('random boxes: unit normal from A to B, points inside both, depth bounded by SAT, null when apart', () => {
    fc.assert(fc.property(vec(1.6), quat, quat, halfs, halfs, (d, qa, qb, ha, hb) => {
      const a = obb([0, 0, 0], qa, ha), b = obb(d, qb, hb);
      const sat = boxBoxDepth(a, b);
      const m = boxBoxManifold(a, b, 0);
      if (sat === 0) return m === null || m.points.every((p) => p.depth <= 1e-9);
      if (!m) return false; // overlapping boxes must produce contacts
      if (Math.abs(length(m.normal) - 1) > 1e-9) return false;
      if (dot(m.normal, d) < -1e-9) return false;
      const maxDepth = Math.max(...m.points.map((p) => p.depth));
      if (m.points.length < 1 || m.points.length > 4) return false;
      // The face bias may pick a face axis up to 5% + 1 cm worse than the SAT minimum.
      if (maxDepth > sat / 0.95 + 0.0101) return false;
      return m.points.every((p) => inside(a, p.point, maxDepth + 1e-9) && inside(b, p.point, maxDepth + 1e-9));
    }), { numRuns: 3000 });
  });
});

describe('reduceContacts', () => {
  it('keeps the deepest point and at most 4', () => {
    const pts = Array.from({ length: 8 }, (_, i) => ({ point: [Math.cos(i), 0, Math.sin(i)] as Vec3, depth: i === 5 ? 0.3 : 0.1 }));
    const r = reduceContacts(pts, [0, 1, 0]);
    expect(r).toHaveLength(4);
    expect(r[0]!.depth).toBe(0.3);
  });
});

describe('sphere and ground manifolds', () => {
  it('sphere resting on a box face', () => {
    const m = sphereBoxManifold([0.2, 0.5 + 0.3 - 0.01, 0], 0.3, obb([0, 0, 0], I, H))!;
    m.normal.forEach((x, k) => expect(x).toBeCloseTo([0, 1, 0][k]!, 12));
    expect(m.points[0]!.depth).toBeCloseTo(0.01, 12);
  });
  it('sphere centre inside a box is pushed out through the nearest face', () => {
    const m = sphereBoxManifold([0.45, 0, 0], 0.2, obb([0, 0, 0], I, H))!;
    expect(m.normal).toEqual([1, 0, 0]);
    expect(m.points[0]!.depth).toBeCloseTo(0.25, 12);
  });
  it('sphere-sphere', () => {
    const m = sphereSphereManifold([0, 0, 0], 1, [0, 1.5, 0], 1)!;
    expect(m.normal).toEqual([0, 1, 0]);
    expect(m.points[0]!.depth).toBeCloseTo(0.5, 12);
    expect(sphereSphereManifold([0, 0, 0], 1, [0, 2.1, 0], 1, 0.05)).toBeNull();
  });
  it('box on the ground: 4 corners flat, 1 corner when balanced on a vertex', () => {
    const flat = boxGroundManifold(obb([0, 0.49, 0], I, H), 0)!;
    expect(flat.points).toHaveLength(4);
    for (const p of flat.points) expect(p.depth).toBeCloseTo(0.01, 12);
    // Rotate so a body diagonal points down: one corner touches.
    const q = quatMul(quatFromAxisAngle([1, 0, 0], Math.atan(Math.SQRT1_2)), quatFromAxisAngle([0, 0, 1], 45 * deg));
    const low = Math.min(...[-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => rotate(q, [0.5 * x, 0.5 * y, 0.5 * z])[1]))));
    const tip = boxGroundManifold(obb([0, -low - 0.01, 0], q, H), 0)!;
    expect(tip.points).toHaveLength(1);
    expect(tip.points[0]!.depth).toBeCloseTo(0.01, 9);
  });
});

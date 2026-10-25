import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { Quat, Vec3 } from '@tb/engine-api';
import {
  beats, boxBoxDepth, boxBoxManifold, boxGroundManifold, dot, FACE_ABS, FACE_INSET, FACE_REL, length, NO_AXIS, obb, quatFromAxisAngle, quatMul, quatNormalize, reduceContacts, rotate, supportArea, shapeManifold, groundManifold,
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
  it('offset face-on stack: 4 corners of the overlap rectangle (reference sides inset), equal depth', () => {
    const a = obb([0, 0, 0], I, H), b = obb([0.3, 0.99, 0.2], I, H);
    const m = boxBoxManifold(a, b)!;
    expect(m.feature).toBe('faceA');
    expect(m.axis).toBe(1);
    expect(m.normal).toEqual([0, 1, 0]);
    expect(m.points).toHaveLength(4);
    for (const p of m.points) expect(p.depth).toBeCloseTo(0.01, 12);
    const xs = m.points.map((p) => p.point[0]).sort(), zs = m.points.map((p) => p.point[2]).sort();
    // The far edges are b's (as they are); the near ones a's, moved in by the inset.
    expect([xs[0], xs[3]].map((x) => +x!.toFixed(9))).toEqual([-0.2, 0.5 - FACE_INSET]);
    expect([zs[0], zs[3]].map((z) => +z!.toFixed(9))).toEqual([-0.3, 0.5 - FACE_INSET]);
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
    expect(m.axis).toBeGreaterThanOrEqual(6);
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

  // Aligned unit cubes on a grid, the layout of every block tower, under
  // position noise well below the inset and the face tolerance (f32
  // rounding is ~1e-7 here).
  const noise = fc.tuple(fc.double({ min: -4e-5, max: 4e-5, noNaN: true }), fc.double({ min: -4e-5, max: 4e-5, noNaN: true }), fc.double({ min: -4e-5, max: 4e-5, noNaN: true }));
  const near = (d: Vec3, e: number[]): Vec3 => [d[0] + e[0]!, d[1] + e[1]!, d[2] + e[2]!];

  it('aligned neighbours touching only along an edge or at a corner get no contact, whatever the noise', () => {
    const a = obb([0, 0, 0], I, H);
    for (const d of [[1, 1, 0], [0, 1, 1], [1, 0, 1], [1, 1, 1], [-1, 1, 1], [1, -1, 0]] as Vec3[]) {
      fc.assert(fc.property(noise, (e) => boxBoxManifold(a, obb(near(d, e), I, H), 0.02) === null), { numRuns: 200 });
    }
  });

  it('aligned face neighbours: always the same face axis and 4 points at the inset corners, whatever the noise', () => {
    const a = obb([0, 0, 0], I, H);
    for (const [d, axis] of [[[0, 1, 0], 1], [[1, 0, 0], 0], [[0, 0, -1], 2]] as Array<[Vec3, number]>) {
      const k = d.findIndex((x) => x !== 0);
      fc.assert(fc.property(noise, (e) => {
        const m = boxBoxManifold(a, obb(near(d, e), I, H), 0.02)!;
        if (m.axis !== axis || m.points.length !== 4) return false;
        // Off the normal, each point sits at +-(0.5 - inset) (b's corners lie outside a's inset face).
        return m.points.every((p) => [0, 1, 2].every((j) => j === k || Math.abs(Math.abs(p.point[j]!) - (0.5 - FACE_INSET)) < 1e-4));
      }), { numRuns: 200 });
    }
  });

  it('keeps last step\'s face axis until another separates by more than the tolerance', () => {
    const a = obb([0, 0, 0], I, H);
    // x separates by -0.0100, y by -0.0102: x is the larger, but only by 2e-4
    // (the tolerance here is 1e-4 + 2% of 0.0102). Both overlaps are wider than the inset.
    const b = obb([0.99, 0.9898, 0], I, H);
    expect(boxBoxManifold(a, b, 0.02)!.axis).toBe(0);
    expect(boxBoxManifold(a, b, 0.02, true, 0)!.axis).toBe(0);
    const kept = boxBoxManifold(a, b, 0.02, true, 1)!;
    expect(kept.axis).toBe(1);
    expect(kept.normal).toEqual([0, 1, 0]);
    // Once x is clearly better (by 5e-4) it takes over.
    expect(boxBoxManifold(a, obb([0.99, 0.9895, 0], I, H), 0.02, true, 1)!.axis).toBe(0);
    // Edge hints and NO_AXIS change nothing.
    expect(boxBoxManifold(a, b, 0.02, true, 7)!.axis).toBe(0);
    expect(boxBoxManifold(a, b, 0.02, true, NO_AXIS)!.axis).toBe(0);
  });

  it('across a speculative gap too, another axis must separate by more to take over', () => {
    // Scaling best (Box2D's 0.98 * best + abs) asks for less than best once
    // best > abs / 0.02 = 5 mm: this pair 2 cm apart alternated 4, 1, 4, 1.
    const a = obb([0, 0, 0], I, H), b = obb([0, 1.02, 0], I, H);
    for (const start of [NO_AXIS, 4]) {
      let axis = start;
      const seen: number[] = [];
      for (let i = 0; i < 4; i++) { axis = boxBoxManifold(a, b, 0.05, true, axis)!.axis; seen.push(axis); }
      expect(seen).toEqual(Array(4).fill(start === NO_AXIS ? 1 : 4));
    }
    fc.assert(fc.property(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), (s, best) =>
      !beats(s, best, FACE_REL, FACE_ABS) || s > best + FACE_ABS), { numRuns: 2000 });
    for (const best of [-0.3, -1e-3, 0, 1e-3, 0.02, 0.3]) {
      expect(beats(best + FACE_ABS, best, FACE_REL, FACE_ABS)).toBe(false);
      expect(beats(best + FACE_ABS + FACE_REL * Math.abs(best) + 1e-9, best, FACE_REL, FACE_ABS)).toBe(true);
    }
  });

  it('far from the origin: diagonal neighbours still get no contact, face neighbours their 4 points', () => {
    // A double's ulp at 3e12 is 4.9e-4, a float's at 5000: clipping against
    // dot(c, axis) + h there would round the 1e-4 inset away (the corners
    // then survive on the plane), so clipping is done relative to the reference box.
    const o = 3e12, a = obb([o, 0.5, o], I, H);
    for (const d of [[1, 0, 1], [-1, 0, 1], [1, 1, 1], [1, 1, 0]] as Vec3[]) {
      expect(boxBoxManifold(a, obb([o + d[0], 0.5 + d[1], o + d[2]], I, H), 0.02)).toBeNull();
    }
    for (const [d, axis] of [[[0, 1, 0], 1], [[1, 0, 0], 0], [[0, 0, -1], 2]] as Array<[Vec3, number]>) {
      const m = boxBoxManifold(a, obb([o + d[0], 0.5 + d[1], o + d[2]], I, H), 0.02)!;
      expect(m.axis).toBe(axis);
      expect(m.points.length).toBe(4);
      for (const p of m.points) expect(Math.abs(p.depth)).toBeLessThan(1e-12);
    }
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
  it('spreads the support when the first two picks lie on a hull edge', () => {
    // Deepest (0,0) and farthest (4,0) span the bottom edge, so every other
    // point is on one side. The best 4 keep the top edge's ends: area 3.
    const at = (x: number, z: number, depth = 0.1) => ({ point: [x, 0, z] as Vec3, depth });
    const pts = [at(0, 0, 0.3), at(1, 1), at(1.2, 1), at(4, 0), at(2.8, 1), at(3, 1)];
    const r = reduceContacts(pts, [0, 1, 0]);
    expect(supportArea(r.map((p) => p.point), [0, 1, 0])).toBeCloseTo(3, 12);
  });
  it('random convex polygons: the best support that keeps the deepest point', () => {
    // Independent brute force using the monotone-chain hull.
    let seed = 7;
    const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const N: Vec3 = [0, 1, 0];
    for (let t = 0; t < 300; t++) {
      const n = 5 + Math.floor(rnd() * 4), sx = 0.2 + rnd() * 2, sz = 0.2 + rnd();
      const pts = Array.from({ length: n }, () => rnd() * 2 * Math.PI).sort((x, y) => x - y)
        .map((g) => ({ point: [sx * Math.cos(g), 0, sz * Math.sin(g)] as Vec3, depth: rnd() }));
      // Interior points too: the hull of 4 can be a triangle.
      if (t % 3 === 0) pts.push({ point: [0, 0, 0], depth: rnd() }, { point: [0.1 * sx, 0, -0.1 * sz], depth: rnd() });
      const d = pts.reduce((bi, p, i) => (p.depth > pts[bi]!.depth ? i : bi), 0);
      let best = 0;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) for (let k = j + 1; k < pts.length; k++)
        if (i !== d && j !== d && k !== d) best = Math.max(best, supportArea([pts[d]!, pts[i]!, pts[j]!, pts[k]!].map((p) => p.point), N));
      const r = reduceContacts(pts, N);
      expect(r[0]).toBe(pts[d]);
      expect(new Set(r).size).toBe(4);
      expect(supportArea(r.map((p) => p.point), N)).toBeCloseTo(best, 12);
    }
  });
});

describe('shapeManifold and groundManifold', () => {
  const box = { kind: 'box' as const, half: H }, ball = { kind: 'sphere' as const, radius: 0.5 };
  it.for([['box', 'box'], ['box', 'sphere'], ['sphere', 'box'], ['sphere', 'sphere']] as const)('%s under %s: normal points from a (below) to b', ([ka, kb]) => {
    const sa = ka === 'box' ? box : ball, sb = kb === 'box' ? box : ball;
    const m = shapeManifold(sa, [0, 0, 0], I, sb, [0.01, 0.99, 0], I, 0.02)!;
    expect(m.normal[1]).toBeGreaterThan(0.99);
    for (const p of m.points) expect(p.depth).toBeCloseTo(0.01, 3);
  });
  it('ground contacts for both shapes', () => {
    expect(groundManifold(box, [0, 0.49, 0], I, 0)!.points).toHaveLength(4);
    const s = groundManifold(ball, [0, 0.49, 0], I, 0)!;
    expect(s.points).toHaveLength(1);
    expect(s.points[0]!.depth).toBeCloseTo(0.01, 12);
    expect(groundManifold(ball, [0, 0.6, 0], I, 0, 0.05)).toBeNull();
  });
});

describe('supportArea', () => {
  it('is the projected convex hull area, ignoring interior and duplicate points', () => {
    const sq: Vec3[] = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [0.5, 0, 0.5], [1, 0, 1]];
    expect(supportArea(sq, [0, 1, 0])).toBeCloseTo(1, 12);
    // Tilted plane: the square rotated about x, measured about its own normal.
    const c = Math.cos(0.7), s = Math.sin(0.7);
    expect(supportArea(sq.map(([x, , z]) => [x, z * s, z * c] as Vec3), [0, c, -s])).toBeCloseTo(1, 12);
    expect(supportArea([[0, 0, 0], [1, 0, 0], [2, 0, 0]], [0, 1, 0])).toBeCloseTo(0, 12);
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

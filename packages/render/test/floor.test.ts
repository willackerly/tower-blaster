import { describe, expect, it } from 'vitest';
import { FLOOR_MAX, FLOOR_PAD, FLOOR_REACH, FLOOR_VERTS, floorFan, floorPolygon, invert, lookAt, multiply, perspective, transform, type V3 } from '../src/index.ts';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

/** Camera-relative inverse view-projection, as the renderer builds it (eye at the origin). */
function relInverse(eye: V3, target: V3, far = 400, fov = 0.9, aspect = 1.6) {
  const rel: V3 = [target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]];
  return invert(multiply(perspective(fov, aspect, 0.1, far), lookAt([0, 0, 0], rel)));
}

/** Inside the convex polygon (xz), with a tolerance in metres. */
function inside(poly: V3[], p: V3, tol: number) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]!, b = poly[(i + 1) % poly.length]!;
    const len = Math.hypot(b[0] - a[0], b[2] - a[2]) || 1;
    const c = ((b[0] - a[0]) * (p[2] - a[2]) - (b[2] - a[2]) * (p[0] - a[0])) / len;
    if (Math.abs(c) <= tol) continue;
    if (sign === 0) sign = Math.sign(c);
    else if (Math.sign(c) !== sign) return false;
  }
  return true;
}

describe('floorPolygon', () => {
  it('looking straight down: four vertices on the plane, just outside the screen corners', () => {
    const inv = relInverse([0, 10, 0], [0, 0, 0.001]);
    const poly = floorPolygon(inv, -10);
    expect(poly.length).toBe(4);
    for (const p of poly) expect(p[1]).toBe(-10);
    // Each vertex projects to |ndc| = FLOOR_PAD in x and y.
    const vp = invert(inv);
    for (const p of poly) {
      const c = transform(vp, p);
      expect(Math.abs(c[0] / c[3])).toBeCloseTo(FLOOR_PAD, 4);
      expect(Math.abs(c[1] / c[3])).toBeCloseTo(FLOOR_PAD, 4);
    }
  });

  it('is empty when the plane is out of view (looking up, or the floor far above a camera looking down)', () => {
    expect(floorPolygon(relInverse([0, 2, 0], [0, 10, 0.001]), -2)).toEqual([]);
    expect(floorPolygon(relInverse([0, 2, 0], [0, -10, 0.001]), 5)).toEqual([]);
  });

  it('covers every visible floor point within reach, for random cameras, and stays convex', () => {
    const r = rng(7);
    let cameras = 0, hits = 0;
    for (let k = 0; k < 300; k++) {
      const eye: V3 = [(r() - 0.5) * 40, 0.3 + r() * 30, (r() - 0.5) * 40];
      const target: V3 = [eye[0] + (r() - 0.5) * 20, eye[1] - 10 + r() * 14, eye[2] + (r() - 0.5) * 20];
      const far = r() < 0.5 ? 400 : 3000;
      const inv = relInverse(eye, target, far);
      const planeY = -eye[1];
      const poly = floorPolygon(inv, planeY);
      expect(poly.length === 0 || (poly.length >= 3 && poly.length <= FLOOR_MAX)).toBe(true);
      for (const p of poly) expect(p[1]).toBe(planeY);
      // Convex and consistently ordered: every vertex on the same side of every edge.
      for (const p of poly) expect(inside(poly, p, 1e-6 * FLOOR_REACH)).toBe(true);
      // Rays through the screen that hit the plane within reach land inside it.
      for (let s = 0; s < 60; s++) {
        const x = r() * 2 - 1, y = r() * 2 - 1;
        const a = transform(inv, [x, y, 0]), b = transform(inv, [x, y, 1]);
        const pa: V3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], pb: V3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
        const d: V3 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]];
        if (d[1] >= 0) continue;
        const t = (planeY - pa[1]) / d[1];
        if (t > 1) continue; // past the far plane
        const hit: V3 = [pa[0] + d[0] * t, planeY, pa[2] + d[2] * t];
        if (Math.hypot(hit[0], hit[1], hit[2]) > 0.9 * FLOOR_REACH) continue; // near the reach cut (by depth, not distance)
        expect(poly.length, `camera ${k}`).toBeGreaterThan(0);
        expect(inside(poly, hit, 1e-4 * (1 + Math.hypot(hit[0], hit[2]))), `camera ${k} ndc ${x},${y}`).toBe(true);
        hits++;
      }
      if (poly.length) cameras++;
    }
    expect(cameras).toBeGreaterThan(150);
    expect(hits).toBeGreaterThan(3000);
  });

  it('floorFan: a triangle fan of the polygon', () => {
    const poly: V3[] = [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1], [-1, 0, 0.5]];
    const { data, count } = floorFan(poly);
    expect(count).toBe(9);
    expect(data.length).toBe(FLOOR_VERTS * 3);
    expect(Array.from(data.slice(0, 9))).toEqual([0, 0, 0, 1, 0, 0, 1, 0, 1]);
    expect(Array.from(data.slice(18, 27))).toEqual([0, 0, 0, 0, 0, 1, -1, 0, 0.5]);
    expect(floorFan([]).count).toBe(0);
  });
});

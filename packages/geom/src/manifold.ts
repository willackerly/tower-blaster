// Contact manifolds in double precision: the oracle for the GPU narrowphase.
//
// Box-box follows the standard SAT + clipping scheme (Gregorius, "The
// Separating Axis Test between Convex Polyhedra", GDC 2013; Box2D/Bullet):
// find the axis of least overlap among the 3 + 3 face normals and 9 edge
// cross products; prefer a face axis unless an edge axis is clearly better
// (face contacts give stable 4-point manifolds); for a face axis clip the
// incident face against the reference face's side planes; for an edge axis
// take the closest points of the two supporting edges. At most 4 points are
// kept (the deepest, then the widest support) so a resting face gets its corners.
//
// Conventions: the normal points from shape A to shape B, depth > 0 means
// overlap, and a speculative margin keeps contacts slightly apart (depth down
// to -margin) so a solver can stop bodies before they touch.
import { add, cross, dot, length, sub, scale, type Obb } from './index.ts';
import type { Vec3 } from '@tb/engine-api';

export interface ContactPoint { point: Vec3; depth: number }
export interface Manifold { normal: Vec3; points: ContactPoint[]; feature: 'faceA' | 'faceB' | 'edge' }

/** Edge axes must beat the best face axis by this much to be chosen. */
const EDGE_REL = 0.95;
const EDGE_ABS = 0.01;

function projRadius(b: Obb, n: Vec3): number {
  return b.half[0] * Math.abs(dot(b.axes[0], n)) + b.half[1] * Math.abs(dot(b.axes[1], n)) + b.half[2] * Math.abs(dot(b.axes[2], n));
}

/** Corners of face (axis k, sign s) of b, in counter-clockwise order seen from outside. */
function faceCorners(b: Obb, k: number, s: number): Vec3[] {
  const u = (k + 1) % 3, v = (k + 2) % 3;
  const c = add(b.c, scale(b.axes[k]!, s * b.half[k]!));
  const eu = scale(b.axes[u]!, b.half[u]!), ev = scale(b.axes[v]!, b.half[v]!);
  const corners = [add(add(c, eu), ev), add(sub(c, eu), ev), sub(sub(c, eu), ev), sub(add(c, eu), ev)];
  return s > 0 ? corners : corners.reverse();
}

/** Face of b whose outward normal is most anti-parallel to n. */
function incidentFace(b: Obb, n: Vec3): [number, number] {
  let best = 0, bestDot = Infinity, sign = 1;
  for (let k = 0; k < 3; k++) {
    const d = dot(b.axes[k]!, n);
    if (d < bestDot) { bestDot = d; best = k; sign = 1; }
    if (-d < bestDot) { bestDot = -d; best = k; sign = -1; }
  }
  return [best, sign];
}

/** Sutherland-Hodgman: keep the part of poly with dot(p, n) <= d. */
function clip(poly: Vec3[], n: Vec3, d: number): Vec3[] {
  const out: Vec3[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!, q = poly[(i + 1) % poly.length]!;
    const dp = dot(p, n) - d, dq = dot(q, n) - d;
    if (dp <= 0) out.push(p);
    if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) out.push(add(p, scale(sub(q, p), dp / (dp - dq))));
  }
  return out;
}

/**
 * Twice the area of the convex hull of 4 points about the normal: the largest
 * of the 3 quadrilateral orderings (shoelace = diagonal cross product) and
 * the 4 triangles (the hull is a triangle when one point is inside).
 */
function hull4x2(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3, n: Vec3): number {
  const x = (u: Vec3, v: Vec3) => Math.abs(dot(cross(u, v), n));
  return Math.max(
    x(sub(p2, p0), sub(p3, p1)), x(sub(p3, p0), sub(p2, p1)), x(sub(p1, p0), sub(p3, p2)),
    x(sub(p1, p0), sub(p2, p0)), x(sub(p1, p0), sub(p3, p0)), x(sub(p2, p0), sub(p3, p0)), x(sub(p2, p1), sub(p3, p1)),
  );
}

/**
 * Keep at most 4 points: the deepest, plus the 3 others that maximize the
 * support area (exhaustive: at most 7 choose 3 = 35 triples, first index
 * wins ties). The usual greedy rule (farthest from the deepest, largest
 * triangle, largest growth) is about 1% worse on average and up to 30% on
 * some polygons, and its intermediate ties change the final quality, so f32
 * and f64 could legitimately disagree on how well a face is supported.
 */
export function reduceContacts(points: ContactPoint[], normal: Vec3): ContactPoint[] {
  if (points.length <= 4) return points;
  let d = 0;
  for (let i = 1; i < points.length; i++) if (points[i]!.depth > points[d]!.depth) d = i;
  const a = points[d]!.point, rest = points.filter((_, i) => i !== d);
  let best = -1, pick: [number, number, number] = [0, 1, 2];
  for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) for (let k = j + 1; k < rest.length; k++) {
    const s = hull4x2(a, rest[i]!.point, rest[j]!.point, rest[k]!.point, normal);
    if (s > best) { best = s; pick = [i, j, k]; }
  }
  return [points[d]!, ...pick.map((i) => rest[i]!)];
}

/** Area of the convex hull of points projected on the plane with normal n (monotone chain). */
export function supportArea(points: Vec3[], n: Vec3): number {
  if (points.length < 3) return 0;
  const t: Vec3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const w = cross(n, t), u = scale(w, 1 / length(w)), v0 = cross(n, u), v = scale(v0, 1 / length(v0));
  const xy = points.map((p) => [dot(p, u), dot(p, v)] as [number, number]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o: number[], p: number[], q: number[]) => (p[0]! - o[0]!) * (q[1]! - o[1]!) - (p[1]! - o[1]!) * (q[0]! - o[0]!);
  const half = (pts: Array<[number, number]>) => {
    const h: Array<[number, number]> = [];
    for (const p of pts) {
      while (h.length >= 2 && turn(h[h.length - 2]!, h[h.length - 1]!, p) <= 0) h.pop();
      h.push(p);
    }
    h.pop();
    return h;
  };
  const hull = [...half(xy), ...half([...xy].reverse())];
  let area = 0;
  for (let i = 0; i < hull.length; i++) { const p = hull[i]!, q = hull[(i + 1) % hull.length]!; area += p[0] * q[1] - p[1] * q[0]; }
  return Math.abs(area) / 2;
}

/** Closest points between segments p1q1 and p2q2 (Ericson, Real-Time Collision Detection 5.1.9). */
function segmentClosest(p1: Vec3, q1: Vec3, p2: Vec3, q2: Vec3): [Vec3, Vec3] {
  const d1 = sub(q1, p1), d2 = sub(q2, p2), r = sub(p1, p2);
  const a = dot(d1, d1), e = dot(d2, d2), f = dot(d2, r);
  const c = dot(d1, r), b = dot(d1, d2), den = a * e - b * b;
  let s = den > 1e-12 ? Math.min(1, Math.max(0, (b * f - c * e) / den)) : 0;
  let t = (b * s + f) / e;
  if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
  else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
  return [add(p1, scale(d1, s)), add(p2, scale(d2, t))];
}

/** Supporting edge of b along axis k (the edge parallel to axes[k] furthest along n). */
function supportEdge(b: Obb, k: number, n: Vec3): [Vec3, Vec3] {
  let c = b.c;
  for (let i = 0; i < 3; i++) if (i !== k) c = add(c, scale(b.axes[i]!, (dot(b.axes[i]!, n) >= 0 ? 1 : -1) * b.half[i]!));
  const e = scale(b.axes[k]!, b.half[k]!);
  return [sub(c, e), add(c, e)];
}

/** reduce = false returns every clipped point (tests use it to tell reduction ties from errors). */
export function boxBoxManifold(a: Obb, b: Obb, margin = 0, reduce = true): Manifold | null {
  const d = sub(b.c, a.c);
  let faceBest = -Infinity, faceAxis: Vec3 = [0, 1, 0], faceOwner: 'faceA' | 'faceB' = 'faceA', faceK = 0;
  // Separation along each axis (negative = overlap); maximize it.
  const sep = (n: Vec3) => Math.abs(dot(d, n)) - projRadius(a, n) - projRadius(b, n);
  for (const [owner, box] of [['faceA', a], ['faceB', b]] as const) {
    for (let k = 0; k < 3; k++) {
      const s = sep(box.axes[k]!);
      if (s > margin) return null;
      if (s > faceBest) { faceBest = s; faceAxis = box.axes[k]!; faceOwner = owner; faceK = k; }
    }
  }
  let edgeBest = -Infinity, edgeAxis: Vec3 = [0, 1, 0], edgeI = 0, edgeJ = 0;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
    const c = cross(a.axes[i]!, b.axes[j]!);
    const len = length(c);
    if (len < 1e-6) continue; // parallel edges: covered by the face axes
    const n = scale(c, 1 / len);
    const s = sep(n);
    if (s > margin) return null;
    if (s > edgeBest) { edgeBest = s; edgeAxis = n; edgeI = i; edgeJ = j; }
  }
  // Separations are <= 0 when overlapping: "better" means larger (closer to 0).
  const useEdge = edgeBest > EDGE_REL * faceBest + EDGE_ABS;
  if (useEdge) {
    const n = dot(edgeAxis, d) < 0 ? scale(edgeAxis, -1) : edgeAxis;
    const [ea0, ea1] = supportEdge(a, edgeI, n);
    const [eb0, eb1] = supportEdge(b, edgeJ, scale(n, -1));
    const [pa, pb] = segmentClosest(ea0, ea1, eb0, eb1);
    return { normal: n, feature: 'edge', points: [{ point: scale(add(pa, pb), 0.5), depth: -edgeBest }] };
  }
  const ref = faceOwner === 'faceA' ? a : b, inc = faceOwner === 'faceA' ? b : a;
  // Reference normal points from the reference box towards the other.
  const toOther = faceOwner === 'faceA' ? d : scale(d, -1);
  const refSign = dot(faceAxis, toOther) >= 0 ? 1 : -1;
  const nRef = scale(faceAxis, refSign);
  const [ik, is] = incidentFace(inc, nRef);
  let poly = faceCorners(inc, ik, is);
  for (const k of [(faceK + 1) % 3, (faceK + 2) % 3]) {
    const ax = ref.axes[k]!, h = ref.half[k]!, c = dot(ref.c, ax);
    poly = clip(poly, ax, c + h);
    poly = clip(poly, scale(ax, -1), -(c - h));
  }
  const planeD = dot(ref.c, nRef) + ref.half[faceK]!;
  const pts: ContactPoint[] = [];
  for (const p of poly) {
    const s = dot(p, nRef) - planeD; // < 0: below the reference face
    if (s <= margin) pts.push({ point: sub(p, scale(nRef, s / 2)), depth: -s });
  }
  if (!pts.length) return null;
  const normal = faceOwner === 'faceA' ? nRef : scale(nRef, -1);
  return { normal, feature: faceOwner, points: reduce ? reduceContacts(pts, normal) : pts };
}

/** Sphere (centre c, radius r) against box: normal from box to sphere. */
export function sphereBoxManifold(c: Vec3, r: number, b: Obb, margin = 0): Manifold | null {
  const d = sub(c, b.c);
  const local = [0, 1, 2].map((k) => dot(d, b.axes[k]!));
  const inside = local.every((t, k) => Math.abs(t) <= b.half[k]!);
  if (inside) {
    // Push out through the nearest face.
    let k = 0, best = Infinity;
    for (let i = 0; i < 3; i++) { const g = b.half[i]! - Math.abs(local[i]!); if (g < best) { best = g; k = i; } }
    const n = scale(b.axes[k]!, local[k]! >= 0 ? 1 : -1);
    return { normal: n, feature: 'faceA', points: [{ point: sub(c, scale(n, r)), depth: r + best }] };
  }
  let q = b.c;
  for (let k = 0; k < 3; k++) q = add(q, scale(b.axes[k]!, Math.max(-b.half[k]!, Math.min(b.half[k]!, local[k]!))));
  const v = sub(c, q), dist = length(v);
  if (dist - r > margin) return null;
  const n = scale(v, 1 / dist);
  return { normal: n, feature: 'faceA', points: [{ point: scale(add(q, sub(c, scale(n, r))), 0.5), depth: r - dist }] };
}

export function sphereSphereManifold(c1: Vec3, r1: number, c2: Vec3, r2: number, margin = 0): Manifold | null {
  const v = sub(c2, c1), dist = length(v);
  if (dist - r1 - r2 > margin) return null;
  const n: Vec3 = dist > 1e-12 ? scale(v, 1 / dist) : [0, 1, 0];
  const pa = add(c1, scale(n, r1)), pb = sub(c2, scale(n, r2));
  return { normal: n, feature: 'faceA', points: [{ point: scale(add(pa, pb), 0.5), depth: r1 + r2 - dist }] };
}

/** Box against the ground plane y = groundY: normal +y (from ground to box), up to 4 corners. */
export function boxGroundManifold(b: Obb, groundY: number, margin = 0, reduce = true): Manifold | null {
  const pts: ContactPoint[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = add(add(add(b.c, scale(b.axes[0], sx * b.half[0])), scale(b.axes[1], sy * b.half[1])), scale(b.axes[2], sz * b.half[2]));
    const s = p[1] - groundY;
    if (s <= margin) pts.push({ point: [p[0], p[1] - s / 2, p[2]], depth: -s });
  }
  if (!pts.length) return null;
  return { normal: [0, 1, 0], feature: 'faceA', points: reduce ? reduceContacts(pts, [0, 1, 0]) : pts };
}

/** Sphere against the ground plane: normal +y, one point midway between the sphere's bottom and the plane. */
export function sphereGroundManifold(c: Vec3, r: number, groundY: number, margin = 0): Manifold | null {
  const s = c[1] - r - groundY;
  if (s > margin) return null;
  return { normal: [0, 1, 0], feature: 'faceA', points: [{ point: [c[0], c[1] - r - s / 2, c[2]], depth: -s }] };
}

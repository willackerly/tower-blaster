// Contact manifolds in double precision: the oracle for the GPU narrowphase.
//
// Box-box follows the standard SAT + clipping scheme (Gregorius, "The
// Separating Axis Test between Convex Polyhedra", GDC 2013; Box2D/Bullet):
// find the axis of least overlap among the 3 + 3 face normals and 9 edge
// cross products; prefer a face axis unless an edge axis is clearly better
// (face contacts give stable 4-point manifolds); for a face axis clip the
// incident face against the reference face's side planes; for an edge axis
// take the closest points of the two supporting edges. At most 4 points are
// kept (deepest first, then spread out) so a resting face gets its corners.
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

/** Keep at most 4 points: the deepest, the farthest from it, then the two that most enlarge the area. */
export function reduceContacts(points: ContactPoint[], normal: Vec3): ContactPoint[] {
  if (points.length <= 4) return points;
  const pick: ContactPoint[] = [];
  const rest = [...points];
  const take = (score: (p: ContactPoint) => number) => {
    let bi = 0;
    for (let i = 1; i < rest.length; i++) if (score(rest[i]!) > score(rest[bi]!)) bi = i;
    pick.push(rest.splice(bi, 1)[0]!);
  };
  take((p) => p.depth);
  const a = pick[0]!.point;
  take((p) => dot(sub(p.point, a), sub(p.point, a)));
  const b = pick[1]!.point;
  // Signed area of triangle (a, b, p) about the normal: one point each side.
  const area = (p: ContactPoint) => dot(cross(sub(b, a), sub(p.point, a)), normal);
  take(area);
  take((p) => -area(p));
  return pick;
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

export function boxBoxManifold(a: Obb, b: Obb, margin = 0): Manifold | null {
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
  return { normal, feature: faceOwner, points: reduceContacts(pts, normal) };
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
export function boxGroundManifold(b: Obb, groundY: number, margin = 0): Manifold | null {
  const pts: ContactPoint[] = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) {
    const p = add(add(add(b.c, scale(b.axes[0], sx * b.half[0])), scale(b.axes[1], sy * b.half[1])), scale(b.axes[2], sz * b.half[2]));
    const s = p[1] - groundY;
    if (s <= margin) pts.push({ point: [p[0], p[1] - s / 2, p[2]], depth: -s });
  }
  if (!pts.length) return null;
  return { normal: [0, 1, 0], feature: 'faceA', points: reduceContacts(pts, [0, 1, 0]) };
}

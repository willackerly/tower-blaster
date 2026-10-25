// Scalar double-precision geometry used by scenario builders, metrics and
// the TypeScript reference engine. Clarity over speed: this is the oracle.
import type { Quat, ShapeDesc, Vec3 } from '@tb/engine-api';

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

export const QUAT_IDENTITY: Quat = [0, 0, 0, 1];

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const n = length(axis);
  const s = Math.sin(angle / 2) / n;
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(angle / 2)];
}

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function rotate(q: Quat, v: Vec3): Vec3 {
  // v + 2w(u x v) + 2 u x (u x v), u = q.xyz
  const u: Vec3 = [q[0], q[1], q[2]];
  const t = scale(cross(u, v), 2);
  return add(add(v, scale(t, q[3])), cross(u, t));
}

/** World-space unit axes of a body frame. */
export function axesOf(q: Quat): [Vec3, Vec3, Vec3] {
  return [rotate(q, [1, 0, 0]), rotate(q, [0, 1, 0]), rotate(q, [0, 0, 1])];
}

/** Rotation angle of q in radians, in [0, pi]. */
export function quatAngle(q: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(q[3]) / Math.hypot(q[0], q[1], q[2], q[3])));
}

export interface Obb { c: Vec3; axes: [Vec3, Vec3, Vec3]; half: Vec3 }

export function obb(pos: Vec3, rot: Quat, half: Vec3): Obb {
  return { c: pos, axes: axesOf(rot), half };
}

/** Half-width of the box's projection onto unit axis n. */
function radius(b: Obb, n: Vec3): number {
  return b.half[0] * Math.abs(dot(b.axes[0], n)) + b.half[1] * Math.abs(dot(b.axes[1], n)) + b.half[2] * Math.abs(dot(b.axes[2], n));
}

/**
 * Penetration depth of two oriented boxes by the separating axis theorem:
 * the smallest overlap over the 15 candidate axes, or 0 if any axis
 * separates them. Touching boxes return 0 (up to rounding).
 */
export function boxBoxDepth(a: Obb, b: Obb): number {
  const d = sub(b.c, a.c);
  const candidates: Vec3[] = [...a.axes, ...b.axes];
  for (const u of a.axes) {
    for (const v of b.axes) {
      const n = cross(u, v);
      const len = length(n);
      if (len > 1e-6) candidates.push(scale(n, 1 / len));
    }
  }
  let best = Infinity;
  for (const n of candidates) {
    const overlap = radius(a, n) + radius(b, n) - Math.abs(dot(d, n));
    if (overlap <= 0) return 0;
    if (overlap < best) best = overlap;
  }
  return best;
}

/** Closest point on the box to p. */
export function closestPointOnBox(b: Obb, p: Vec3): Vec3 {
  const d = sub(p, b.c);
  let q = b.c;
  for (let i = 0; i < 3; i++) {
    const h = b.half[i]!;
    const t = Math.max(-h, Math.min(h, dot(d, b.axes[i]!)));
    q = add(q, scale(b.axes[i]!, t));
  }
  return q;
}

export function sphereBoxDepth(center: Vec3, r: number, b: Obb): number {
  const d = sub(center, b.c);
  let inside = true;
  let minFace = Infinity;
  for (let i = 0; i < 3; i++) {
    const t = dot(d, b.axes[i]!);
    const h = b.half[i]!;
    if (Math.abs(t) > h) inside = false;
    minFace = Math.min(minFace, h - Math.abs(t));
  }
  if (inside) return r + minFace; // centre inside: push out through nearest face
  return Math.max(0, r - length(sub(center, closestPointOnBox(b, center))));
}

export function sphereSphereDepth(c1: Vec3, r1: number, c2: Vec3, r2: number): number {
  return Math.max(0, r1 + r2 - length(sub(c1, c2)));
}

/** Depth below the plane y = groundY of a shape at pose. */
export function groundDepth(shape: ShapeDesc, pos: Vec3, rot: Quat, groundY: number): number {
  if (shape.kind === 'sphere') return Math.max(0, groundY - (pos[1] - shape.radius));
  const b = obb(pos, rot, shape.half);
  return Math.max(0, groundY - (pos[1] - radius(b, [0, 1, 0])));
}

/** Generic depth between two shapes at poses. */
export function shapeDepth(sa: ShapeDesc, pa: Vec3, qa: Quat, sb: ShapeDesc, pb: Vec3, qb: Quat): number {
  if (sa.kind === 'box' && sb.kind === 'box') return boxBoxDepth(obb(pa, qa, sa.half), obb(pb, qb, sb.half));
  if (sa.kind === 'sphere' && sb.kind === 'sphere') return sphereSphereDepth(pa, sa.radius, pb, sb.radius);
  if (sa.kind === 'sphere' && sb.kind === 'box') return sphereBoxDepth(pa, sa.radius, obb(pb, qb, sb.half));
  if (sa.kind === 'box' && sb.kind === 'sphere') return sphereBoxDepth(pb, sb.radius, obb(pa, qa, sa.half));
  throw new Error('unreachable');
}

/**
 * Signed depth: penetration when the shapes overlap (as shapeDepth), minus
 * a lower bound on their gap when they do not (exact for spheres, sphere and
 * box, and boxes separated along a face normal; the largest separation over
 * the SAT axes otherwise). Use it for "within tol of touching" tests, which
 * shapeDepth (0 for any separated pair) cannot answer.
 */
export function signedDepth(sa: ShapeDesc, pa: Vec3, qa: Quat, sb: ShapeDesc, pb: Vec3, qb: Quat): number {
  if (sa.kind === 'sphere' && sb.kind === 'sphere') return sa.radius + sb.radius - length(sub(pa, pb));
  if (sa.kind === 'box' && sb.kind === 'box') {
    const a = obb(pa, qa, sa.half), b = obb(pb, qb, sb.half), d = sub(b.c, a.c);
    const candidates: Vec3[] = [...a.axes, ...b.axes];
    for (const u of a.axes) for (const v of b.axes) {
      const n = cross(u, v), len = length(n);
      if (len > 1e-6) candidates.push(scale(n, 1 / len));
    }
    let best = Infinity;
    for (const n of candidates) best = Math.min(best, radius(a, n) + radius(b, n) - Math.abs(dot(d, n)));
    return best;
  }
  let c: Vec3, r: number, box: Obb;
  if (sa.kind === 'sphere' && sb.kind === 'box') { c = pa; r = sa.radius; box = obb(pb, qb, sb.half); }
  else if (sa.kind === 'box' && sb.kind === 'sphere') { c = pb; r = sb.radius; box = obb(pa, qa, sa.half); }
  else throw new Error('unreachable');
  const depth = sphereBoxDepth(c, r, box);
  return depth > 0 ? depth : r - length(sub(c, closestPointOnBox(box, c)));
}

/** Signed depth below the plane y = groundY (negative: height of the lowest point above it). */
export function signedGroundDepth(shape: ShapeDesc, pos: Vec3, rot: Quat, groundY: number): number {
  if (shape.kind === 'sphere') return groundY - (pos[1] - shape.radius);
  return groundY - (pos[1] - radius(obb(pos, rot, shape.half), [0, 1, 0]));
}

/** Radius of the bounding sphere. */
export function boundingRadius(s: ShapeDesc): number {
  return s.kind === 'sphere' ? s.radius : length(s.half);
}

/**
 * Reference broadphase: all index pairs (i < j) whose bounding spheres
 * overlap, via a uniform hash grid. O(N) for bounded density. Pairs are
 * returned sorted, so results compare exactly across implementations.
 */
export function spherePairs(centers: ArrayLike<number>, radii: ArrayLike<number>, margin = 0): Array<[number, number]> {
  const n = radii.length;
  let rmax = 0;
  for (let i = 0; i < n; i++) rmax = Math.max(rmax, radii[i]!);
  const cell = Math.max(1e-9, 2 * rmax + margin);
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const grid = new Map<string, number[]>();
  const cellOf = (i: number) => [
    Math.floor(centers[3 * i]! / cell), Math.floor(centers[3 * i + 1]! / cell), Math.floor(centers[3 * i + 2]! / cell),
  ] as const;
  for (let i = 0; i < n; i++) {
    const [x, y, z] = cellOf(i);
    const k = key(x, y, z);
    const list = grid.get(k);
    if (list) list.push(i); else grid.set(k, [i]);
  }
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const [x, y, z] = cellOf(i);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const j of grid.get(key(x + dx, y + dy, z + dz)) ?? []) {
        if (j <= i) continue;
        const ex = centers[3 * j]! - centers[3 * i]!, ey = centers[3 * j + 1]! - centers[3 * i + 1]!, ez = centers[3 * j + 2]! - centers[3 * i + 2]!;
        const reach = radii[i]! + radii[j]! + margin;
        if (ex * ex + ey * ey + ez * ez <= reach * reach) out.push([i, j]);
      }
    }
  }
  out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return out;
}

// Placement geometry for the build tool (C9, docs/game/placement.md): oriented
// boxes, the overlap test, ray picks against the stopped world, and face snap.
// Pure and in metres, on the world as a level compiles it (time stopped: every
// body at its authored pose, before any presettle), so what the editor shows
// is exactly what Play starts from.
//
// The overlap test is the separating-axis test on two oriented boxes (15
// axes: 3 + 3 face normals, 9 edge cross products). It returns the smallest
// overlap over the axes, so two boxes whose faces are flush give about 0 and
// pass under a tolerance (TOUCH), while a box pushed 1 mm into another fails.
// Alternatives considered: AABB overlap (wrong for any yawed piece: a domino on
// a curve, a Kapla plank at 90 deg is fine but 30 deg is not), GJK (general
// convex shapes, which we do not have; SAT on boxes is exact and short), and
// asking the physics engine for contacts after one step (async, engine
// dependent and slow per pointer move).
import type { BodyDesc, Quat, Vec3 } from '@tb/engine-api';

/** An oriented box: centre, rotation (x, y, z, w) and half-extents, metres. */
export interface Obb { c: Vec3; q: Quat; half: Vec3 }

export const QUAT_ID: Quat = [0, 0, 0, 1];

/** The rotation of `deg` degrees about +y (a yaw): local +z turns to (sin a, 0, cos a). 0 is exactly the identity. */
export function yawQuat(deg: number): Quat {
  if (deg === 0) return [0, 0, 0, 1];
  const a = (deg * Math.PI) / 360;
  return [0, Math.sin(a), 0, Math.cos(a)];
}

/** The yaw in degrees of a rotation that only turns about +y, or null when it tilts (beyond 1e-9). */
export function yawOf(q: Quat): number | null {
  if (Math.abs(q[0]) > 1e-9 || Math.abs(q[2]) > 1e-9) return null;
  return (2 * Math.atan2(q[1], q[3]) * 180) / Math.PI;
}

/** Column k of the rotation matrix of q: where local axis k points in the world. */
export function axisOf(q: Quat, k: 0 | 1 | 2): Vec3 {
  const [x, y, z, w] = q;
  if (k === 0) return [1 - 2 * (y * y + z * z), 2 * (x * y + w * z), 2 * (x * z - w * y)];
  if (k === 1) return [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
  return [2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y)];
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const axes = (q: Quat): [Vec3, Vec3, Vec3] => [axisOf(q, 0), axisOf(q, 1), axisOf(q, 2)];

/** Half the width of box b's shadow on unit axis n. */
export function extentAlong(b: Obb, n: Vec3): number {
  const A = axes(b.q);
  return Math.abs(dot(A[0], n)) * b.half[0] + Math.abs(dot(A[1], n)) * b.half[1] + Math.abs(dot(A[2], n)) * b.half[2];
}

/** World AABB of an oriented box. */
export function obbAabb(b: Obb): { lo: Vec3; hi: Vec3 } {
  const e: Vec3 = [extentAlong(b, [1, 0, 0]), extentAlong(b, [0, 1, 0]), extentAlong(b, [0, 0, 1])];
  return { lo: [b.c[0] - e[0], b.c[1] - e[1], b.c[2] - e[2]], hi: [b.c[0] + e[0], b.c[1] + e[1], b.c[2] + e[2]] };
}

/**
 * How deep two oriented boxes overlap: the smallest overlap of their shadows over the 15 separating
 * axes (positive: they interpenetrate by at least that much on every axis; 0: faces flush; negative:
 * apart by at least that much on some axis). Exact for boxes.
 */
export function obbOverlap(a: Obb, b: Obb): number {
  const A = axes(a.q), B = axes(b.q), d = sub(b.c, a.c);
  let least = Infinity;
  const test = (n: Vec3) => {
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 1e-9) return; // parallel edges: their cross product is no axis
    const u: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
    least = Math.min(least, extentAlong(a, u) + extentAlong(b, u) - Math.abs(dot(d, u)));
  };
  for (const n of A) test(n);
  for (const n of B) test(n);
  for (const x of A) for (const y of B) test(cross(x, y));
  return least;
}

/** A level body as an oriented box (its shape must be a box). */
export function obbOfBody(b: BodyDesc): Obb {
  if (b.shape.kind !== 'box') throw new Error('placement handles boxes only');
  return { c: b.pos, q: b.rot, half: b.shape.half };
}

export interface Ray { origin: Vec3; dir: Vec3 }

/** Where a ray enters an oriented box: distance along dir (dir need not be unit) and the world normal of the face it enters, or null. */
export function rayObb(r: Ray, b: Obb): { t: number; normal: Vec3 } | null {
  const A = axes(b.q), p = sub(r.origin, b.c);
  let t0 = -Infinity, t1 = Infinity, enter = -1, sign = 1;
  for (let k = 0; k < 3; k++) {
    const o = dot(A[k]!, p), v = dot(A[k]!, r.dir), h = b.half[k]!;
    if (Math.abs(v) < 1e-12) { if (o < -h || o > h) return null; continue; }
    let a = (-h - o) / v, c = (h - o) / v, s = -1;
    if (a > c) { [a, c] = [c, a]; s = 1; }
    if (a > t0) { t0 = a; enter = k; sign = s; }
    t1 = Math.min(t1, c);
    if (t0 > t1) return null;
  }
  if (t0 < 0 || enter < 0) return null; // starts inside, or behind
  const n = A[enter]!;
  return { t: t0, normal: [sign * n[0] + 0, sign * n[1] + 0, sign * n[2] + 0] }; // + 0: no -0
}

/** Where a ray meets the ground plane y = groundY from above, or null. */
export function rayGround(r: Ray, groundY = 0): { t: number; normal: Vec3 } | null {
  if (r.dir[1] >= -1e-12 || r.origin[1] <= groundY) return null;
  return { t: (groundY - r.origin[1]) / r.dir[1], normal: [0, 1, 0] };
}

/** What a pick hit: a body (its index) or the ground (-1), the point and the outward normal of the face hit. */
export interface Hit { body: number; point: Vec3; normal: Vec3; t: number }

/**
 * A uniform grid over a set of oriented boxes (the stopped world plus anything placed), for overlap
 * queries near-linear in what is near: each box is listed in every cell its AABB covers.
 */
export class PlacementIndex {
  readonly boxes: Obb[] = [];
  private readonly grid = new Map<string, number[]>();
  /** Bodies taken out (a removed piece): kept in place so indices stay stable, skipped by every query. */
  private readonly gone = new Set<number>();

  constructor(readonly cell: number) {
    if (!(cell > 0)) throw new Error('PlacementIndex: cell must be above 0');
  }

  static of(boxes: readonly Obb[], cell: number): PlacementIndex {
    const ix = new PlacementIndex(cell);
    for (const b of boxes) ix.add(b);
    return ix;
  }

  private keys(lo: Vec3, hi: Vec3): string[] {
    const f = (x: number) => Math.floor(x / this.cell), out: string[] = [];
    for (let x = f(lo[0]); x <= f(hi[0]); x++) for (let y = f(lo[1]); y <= f(hi[1]); y++) for (let z = f(lo[2]); z <= f(hi[2]); z++) out.push(`${x},${y},${z}`);
    return out;
  }

  /** Adds a box; returns its index. */
  add(b: Obb): number {
    const i = this.boxes.length, { lo, hi } = obbAabb(b);
    this.boxes.push(b);
    for (const k of this.keys(lo, hi)) {
      const list = this.grid.get(k);
      if (list) list.push(i); else this.grid.set(k, [i]);
    }
    return i;
  }

  remove(i: number): void { this.gone.add(i); }
  has(i: number): boolean { return i >= 0 && i < this.boxes.length && !this.gone.has(i); }

  /** Indices of boxes whose AABB comes within `margin` of b's, each once, ascending. */
  near(b: Obb, margin = 0): number[] {
    const { lo, hi } = obbAabb(b), out = new Set<number>();
    const glo: Vec3 = [lo[0] - margin, lo[1] - margin, lo[2] - margin], ghi: Vec3 = [hi[0] + margin, hi[1] + margin, hi[2] + margin];
    for (const k of this.keys(glo, ghi)) for (const i of this.grid.get(k) ?? []) if (!this.gone.has(i)) out.add(i);
    return [...out].sort((x, y) => x - y);
  }

  /**
   * The boxes b interpenetrates by more than `tol` (obbOverlap), and whether it pokes through the ground
   * (its lowest point more than `tol` under groundY; null: no ground).
   */
  clashes(b: Obb, tol: number, groundY: number | null = 0): { bodies: number[]; ground: boolean } {
    const bodies = this.near(b).filter((i) => obbOverlap(b, this.boxes[i]!) > tol);
    const ground = groundY !== null && b.c[1] - extentAlong(b, [0, 1, 0]) < groundY - tol;
    return { bodies, ground };
  }

  /** The nearest face a ray meets: a box's (a linear scan, cheap beside a frame for 10k boxes) or the ground's; null for none. */
  pick(r: Ray, groundY: number | null = 0): Hit | null {
    let best: Hit | null = null;
    const at = (t: number): Vec3 => [r.origin[0] + t * r.dir[0], r.origin[1] + t * r.dir[1], r.origin[2] + t * r.dir[2]];
    this.boxes.forEach((b, i) => {
      if (this.gone.has(i)) return;
      const h = rayObb(r, b);
      if (h && (!best || h.t < best.t)) best = { body: i, point: at(h.t), normal: h.normal, t: h.t };
    });
    if (groundY !== null) {
      const g = rayGround(r, groundY);
      if (g && (!best || g.t < (best as Hit).t)) best = { body: -1, point: at(g.t), normal: g.normal, t: g.t };
    }
    return best;
  }
}

/**
 * The lattice a level's pieces snap to: h its unit (m per cube edge), pitch its horizontal cell
 * pitch (1 + gap), both as compileLevel uses them.
 */
export interface SnapGrid { h: number; pitch: number }

export interface SnapOptions {
  /** Snap tangential positions (true, the default) or follow the pointer exactly. */
  snap?: boolean;
  /** Turn the ghost with the face's body when that body only yaws (default true). */
  align?: boolean;
}

const roundTo = (x: number, step: number) => Math.round(x / step) * step;

/**
 * Where a piece of half-extents `half` and yaw `yawDeg` goes when the pointer hits `hit` (face snap):
 * its face flush on the face hit, gap-spaced like the lattice on a side face (h (pitch - 1)), on top of
 * a top face; and, snapping, its centre on a half-cell grid of the face's own frame (the hit body's
 * centre, steps of h pitch / 2 across horizontal axes and h up vertical ones) or, on the ground, on the
 * level's half-cell grid. Returns the piece's box in metres and the world yaw it took (the body's own
 * yaw added when `align` and the body only yaws).
 */
export function snapPlace(hit: Hit, half: Vec3, yawDeg: number, grid: SnapGrid, world: readonly Obb[], opts: SnapOptions = {}): { box: Obb; yaw: number } {
  const snap = opts.snap ?? true, align = opts.align ?? true, { h, pitch } = grid;
  const body = hit.body >= 0 ? world[hit.body]! : null;
  const bodyYaw = body ? yawOf(body.q) : 0;
  const yaw = align && body && bodyYaw !== null ? normDeg(yawDeg + bodyYaw) : normDeg(yawDeg);
  const q = yawQuat(yaw), n = hit.normal;
  const e = extentAlong({ c: [0, 0, 0], q, half }, n);
  const side = Math.abs(n[1]) < 0.5;
  const gap = side ? h * (pitch - 1) : 0;
  let c: Vec3 = [hit.point[0] + n[0] * (e + gap), hit.point[1] + n[1] * (e + gap), hit.point[2] + n[2] * (e + gap)];
  if (snap) {
    if (!body) {
      const s = (h * pitch) / 2;
      c = [roundTo(c[0], s), c[1], roundTo(c[2], s)];
    } else {
      // The face's two tangent axes are the body's local axes other than the one along n.
      const A = axes(body.q);
      const k = [0, 1, 2].reduce((best, i) => (Math.abs(dot(A[i]!, n)) > Math.abs(dot(A[best]!, n)) ? i : best), 0);
      const d = sub(c, body.c);
      let out: Vec3 = [body.c[0], body.c[1], body.c[2]];
      const addAlong = (u: Vec3, x: number) => { out = [out[0] + u[0] * x, out[1] + u[1] * x, out[2] + u[2] * x]; };
      addAlong(A[k]!, dot(d, A[k]!));
      let course: number | null = null;
      for (const i of [0, 1, 2]) {
        if (i === k) continue;
        const u = A[i]!, along = dot(d, u);
        // Up a side face of an upright body: whole courses from its bottom, so a block lands on a course, not between two.
        if (Math.abs(u[1]) > 1 - 1e-9) {
          const bottom = body.c[1] - body.half[i]!, hy = extentAlong({ c: [0, 0, 0], q, half }, [0, 1, 0]);
          course = bottom + roundTo(c[1] - hy - bottom, h) + hy;
        } else addAlong(u, roundTo(along, Math.abs(u[1]) > 0.5 ? h : (h * pitch) / 2));
      }
      if (course !== null) out[1] = course;
      c = out;
    }
  }
  return { box: { c, q, half: [...half] as Vec3 }, yaw };
}

/** Degrees into (-180, 180]. */
export function normDeg(d: number): number {
  let x = d % 360;
  if (x <= -180) x += 360;
  if (x > 180) x -= 360;
  return x === 0 ? 0 : x; // no -0
}

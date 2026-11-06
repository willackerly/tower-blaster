// The stroke brush (C9, docs/game/placement.md): a path drawn on the ground
// becomes a run of dominoes, each standing across the path and spaced so that
// neighbouring centres are exactly `pitch` apart.
//
// Spacing is by chord, not arc length: the next centre is the first point
// further along the path at straight-line distance `pitch` from the last. What
// makes a wave carry is the distance between neighbours (X1 measured 0.6 of
// the domino's height), and on a curve the chord is that distance while the
// arc is a little longer. Each domino faces along the chord from its previous
// neighbour to its next, which on a circle is exactly the tangent at the
// middle domino (the chord between two points symmetric about it is
// parallel to it); the first and last face their one neighbour.
//
// The brush stores the path, not the dominoes (RunPart in level.ts): a run of
// 1,000 is a few hundred numbers in a level file, and compiling it is this
// pure function, so the level hash covers the run exactly.
import type { Vec3 } from '@tb/engine-api';

/** A point on the ground plane, (x, z). */
export type P2 = [number, number];

/** A domino's centre on the ground plane and the direction it faces (radians; local +z turns to (sin, cos)). */
export interface RunPose { x: number; z: number; heading: number }

/** Where the segment a -> b first meets the circle of radius r about c, as a fraction of the segment in [from, 1], or null. */
function segmentCircle(a: P2, b: P2, c: P2, r: number, from: number): number | null {
  const dx = b[0] - a[0], dz = b[1] - a[1], fx = a[0] - c[0], fz = a[1] - c[1];
  const A = dx * dx + dz * dz;
  if (A === 0) return null;
  const B = 2 * (fx * dx + fz * dz), C = fx * fx + fz * fz - r * r, disc = B * B - 4 * A * C;
  if (disc < 0) return null;
  const s = Math.sqrt(disc);
  for (const t of [(-B - s) / (2 * A), (-B + s) / (2 * A)]) if (t >= from - 1e-12 && t <= 1 + 1e-12) return Math.min(1, Math.max(from, t));
  return null;
}

/**
 * The dominoes' centres along a polyline: the first at path[0], each next one the first point further
 * along at distance `pitch` (straight line) from the one before, until the path ends.
 */
export function runCentres(path: readonly P2[], pitch: number): P2[] {
  if (!(pitch > 0)) throw new Error('runCentres: pitch must be above 0');
  if (!path.length) return [];
  const out: P2[] = [[path[0]![0], path[0]![1]]];
  let seg = 0, from = 0;
  for (;;) {
    const c = out.at(-1)!;
    let found: P2 | null = null;
    while (seg < path.length - 1) {
      const a = path[seg]!, b = path[seg + 1]!, t = segmentCircle(a, b, c, pitch, from);
      // Only points further along than the last centre count: on the segment the last centre lies on, past it.
      if (t !== null) {
        const p: P2 = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
        found = p;
        from = t;
        break;
      }
      seg++;
      from = 0;
    }
    if (!found) return out;
    out.push(found);
  }
}

/** The dominoes along a path: centres by runCentres, each facing along the chord between its neighbours. */
export function runPoses(path: readonly P2[], pitch: number): RunPose[] {
  const c = runCentres(path, pitch);
  return c.map((p, i) => {
    const a = c[Math.max(0, i - 1)]!, b = c[Math.min(c.length - 1, i + 1)]!;
    const dx = b[0] - a[0], dz = b[1] - a[1];
    return { x: p[0], z: p[1], heading: dx === 0 && dz === 0 ? 0 : Math.atan2(dx, dz) };
  });
}

/** Rotation about +y by `heading` radians (local +z to (sin, 0, cos)). */
export const headingQuat = (heading: number): [number, number, number, number] => (heading === 0 ? [0, 0, 0, 1] : [0, Math.sin(heading / 2), 0, Math.cos(heading / 2)]);

/**
 * A pointer path made a brush path: points closer than `minStep` to the last kept one dropped (the
 * last point always kept), then `smooth` rounds of Chaikin corner cutting (each keeps the ends and
 * replaces every inner corner by two points at 1/4 and 3/4 of its segments, so a hook becomes a
 * curve), then every coordinate rounded to `round` (so the level file stays short and re-reads
 * exactly).
 */
export function smoothStroke(points: readonly P2[], opts: { minStep?: number; smooth?: number; round?: number } = {}): P2[] {
  const minStep = opts.minStep ?? 0.1, rounds = opts.smooth ?? 2, q = opts.round ?? 1e-3;
  let p: P2[] = [];
  for (const x of points) {
    const last = p.at(-1);
    if (!last || Math.hypot(x[0] - last[0], x[1] - last[1]) >= minStep) p.push([x[0], x[1]]);
  }
  const end = points.at(-1);
  if (end && p.length && (p.at(-1)![0] !== end[0] || p.at(-1)![1] !== end[1])) p.push([end[0], end[1]]);
  for (let r = 0; r < rounds && p.length > 2; r++) {
    const out: P2[] = [p[0]!];
    for (let i = 0; i < p.length - 1; i++) {
      const a = p[i]!, b = p[i + 1]!;
      if (i > 0) out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      if (i < p.length - 2) out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    out.push(p.at(-1)!);
    p = out;
  }
  const rd = (x: number) => { const y = Math.round(x / q) * q; return Number(y.toFixed(Math.max(0, -Math.floor(Math.log10(q))))) + 0; };
  return p.map(([x, z]) => [rd(x), rd(z)]);
}

/** Length of a polyline. */
export function pathLength(path: readonly P2[]): number {
  let s = 0;
  for (let i = 1; i < path.length; i++) s += Math.hypot(path[i]![0] - path[i - 1]![0], path[i]![1] - path[i - 1]![1]);
  return s;
}

/**
 * The domino the brush lays by default, in h: X1's tested domino (1 m x 0.5 m x 0.15 m at h = 1 m)
 * at the game's 0.5 m h, so 2 h tall, 1 h across and 0.3 h thick; spaced 0.6 of its height.
 */
export const DOMINO_HALF: Vec3 = [0.5, 1, 0.15];
export const DOMINO_PITCH = 1.2;

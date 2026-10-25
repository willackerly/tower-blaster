// Shared Rapier setup for the engine and the host.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import type { BodyDesc } from '@tb/engine-api';

let ready: Promise<void> | null = null;
export const initRapier = () => (ready ??= RAPIER.init());

/**
 * A body and its one collider, built from a BodyDesc. With `sphereHull`,
 * spheres are convex hulls of an icosphere subdivided that many times, at
 * the sphere's mass: Rapier 0.21 panics (wasm "unreachable") when a ball
 * collider presses on an edge of a voxel collider, e.g. a ball rolling down
 * a dormant tower to its foot (test/voxel-panic.test.ts).
 */
export function createBody(w: RAPIER.World, b: BodyDesc, canSleep: boolean, desc: RAPIER.RigidBodyDesc, sphereHull = 0) {
  desc
    .setTranslation(b.pos[0], b.pos[1], b.pos[2])
    .setRotation({ x: b.rot[0], y: b.rot[1], z: b.rot[2], w: b.rot[3] })
    .setLinvel(b.linVel[0], b.linVel[1], b.linVel[2])
    .setAngvel({ x: b.angVel[0], y: b.angVel[1], z: b.angVel[2] })
    .setCanSleep(canSleep)
    // Fast balls tunnel without continuous collision detection.
    .setCcdEnabled(b.shape.kind === 'sphere');
  const body = w.createRigidBody(desc);
  let col: RAPIER.ColliderDesc, density = b.density;
  if (b.shape.kind === 'box') col = RAPIER.ColliderDesc.cuboid(b.shape.half[0], b.shape.half[1], b.shape.half[2]);
  else if (sphereHull > 0) {
    const { points, volume } = icosphere(sphereHull);
    col = RAPIER.ColliderDesc.convexHull(points.map((x) => x * (b.shape as { radius: number }).radius))!;
    density *= (4 / 3) * Math.PI / volume; // the hull's mass is the sphere's
  } else col = RAPIER.ColliderDesc.ball(b.shape.radius);
  const collider = w.createCollider(col.setDensity(density).setFriction(b.friction).setRestitution(b.restitution), body);
  return { body, collider };
}

const icospheres = new Map<number, { points: Float32Array; volume: number }>();

/** Unit icosphere: vertices, and the volume of the polyhedron they span. */
export function icosphere(sub: number): { points: Float32Array; volume: number } {
  let out = icospheres.get(sub);
  if (out) return out;
  const t = (1 + Math.sqrt(5)) / 2;
  const v = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]]
    .map((p) => { const n = Math.hypot(...p); return p.map((x) => x / n); });
  let f = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < sub; s++) {
    const mid = new Map<number, number>(), next: number[][] = [];
    const m = (a: number, b: number) => {
      const key = Math.min(a, b) * 1e6 + Math.max(a, b);
      let i = mid.get(key);
      if (i === undefined) {
        const p = v[a]!.map((x, k) => x + v[b]![k]!), n = Math.hypot(...p);
        i = v.push(p.map((x) => x / n)) - 1;
        mid.set(key, i);
      }
      return i;
    };
    for (const [a, b, c] of f) { const ab = m(a!, b!), bc = m(b!, c!), ca = m(c!, a!); next.push([a!, ab, ca], [b!, bc, ab], [c!, ca, bc], [ab, bc, ca]); }
    f = next;
  }
  let volume = 0; // sum of the tetrahedra (origin, face)
  for (const [a, b, c] of f) {
    const [p, q, r] = [v[a!]!, v[b!]!, v[c!]!];
    volume += Math.abs(p[0]! * (q[1]! * r[2]! - q[2]! * r[1]!) - p[1]! * (q[0]! * r[2]! - q[2]! * r[0]!) + p[2]! * (q[0]! * r[1]! - q[1]! * r[0]!)) / 6;
  }
  out = { points: Float32Array.from(v.flat()), volume };
  icospheres.set(sub, out);
  return out;
}

export function createGround(w: RAPIER.World, ground: { y: number; friction: number }) {
  return w.createCollider(RAPIER.ColliderDesc.cuboid(1e4, 0.5, 1e4).setTranslation(0, ground.y - 0.5, 0).setFriction(ground.friction));
}

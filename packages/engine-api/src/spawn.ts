// Relative spawns (docs/design/weapons.md, plan step 5): a SpawnEvent whose
// `from` names a parent body places the new body in the parent's frame, from
// the parent's state in the engine, not from a prediction of it. A shell that
// splits, a carrier that drops a bomblet, a fragment that flies off: every
// child starts where the parent really is, moving as it really moves, whatever
// reader saw the parent last and however late.
//
// When: the parent's state is its state at the start of the step the spawn is
// due, before any event of that step applies (the state a snapshot after that
// many steps reports). So a blast or a removal of the parent at the same step,
// whichever order they were pushed in, does not change what the child inherits,
// and a split is "spawn the children from P, then remove P" at one step. The
// child itself is added in event order, as any spawn: a blast pushed after it at
// that step pushes it, one pushed before does not.
//
// The parent must exist at the start of that step (it was in the scene, or
// spawned at an earlier step) and must not have been removed at an earlier
// step; engines refuse the event otherwise (remove.ts checkInputQueue).
//
// What: `body` is the child as seen from the parent. Its pos, linVel and
// angVel are vectors in the frame's axes (`axes`), its rot is relative to the
// frame's rotation for 'body' and a world rotation otherwise; shape and
// material are the child's own. With F the axes (a rotation: columns are where
// the local x, y and z go), parent pose P, q and motion V, w:
//
//   r      = F body.pos
//   pos    = P + r
//   linVel = V + w x r + F body.linVel     (the velocity of the parent's material point at r, plus the child's own)
//   angVel = w + F body.angVel
//   rot    = q body.rot for 'body'; body.rot otherwise
//
// Axes:
//   world    F = identity: offsets and velocities as in the world, moved to the parent;
//   body     F = the parent's rotation: a pattern fixed to the shell, turning with it;
//   heading  F's local +y along the parent's velocity (straight up below
//            HEADING_MIN_SPEED), local x = normalize(heading x t) with t = +y, or
//            +x when the heading is within 26 degrees of vertical (level and
//            across the heading in flight), local z = local x x heading (so F is
//            a rotation).
//
// So a child inherits the parent's whole rigid motion: a spinning shell's
// fragments fly off along the rim as well as on its heading, and a burst whose
// offsets and own velocities sum to zero over children of one mass carries the
// parent's momentum on unchanged (weapons' `conserve`).
//
// Everything is +, -, *, / and square roots, so the f64 reference places a
// child the same on every machine; the GPU engine evaluates the same
// expressions in f32.
import type { BodyDesc, Quat, Vec3 } from './index.ts';

export const SPAWN_AXES = ['world', 'body', 'heading'] as const;
export type SpawnAxes = (typeof SPAWN_AXES)[number];

/** A spawn relative to body `body` (header); `axes` default 'world'. */
export interface SpawnFrom { body: number; axes?: SpawnAxes }

/** A body's pose and motion: what a relative spawn reads of its parent. */
export interface BodyMotion { pos: Vec3; rot: Quat; linVel: Vec3; angVel: Vec3 }

/** Below this speed, units/s, a parent has no heading: 'heading' axes take +y as its heading. */
export const HEADING_MIN_SPEED = 1e-6;

/** Throws on a `from` no engine should apply; returns it with axes filled in. */
export function checkSpawnFrom(f: SpawnFrom): Required<SpawnFrom> {
  const x = f as unknown;
  if (typeof x !== 'object' || x === null || Array.isArray(x)) throw new Error(`spawn.from must be { body, axes? }, got ${JSON.stringify(x)}`);
  const { body, axes = 'world', ...rest } = x as SpawnFrom;
  if (Object.keys(rest).length) throw new Error(`spawn.from has unknown keys ${Object.keys(rest).join(', ')} (allowed: body, axes)`);
  if (!Number.isInteger(body) || body < 0 || body >= 2 ** 32) throw new Error(`spawn.from.body must be a body id, got ${JSON.stringify(body)}`);
  if (!SPAWN_AXES.includes(axes)) throw new Error(`spawn.from.axes must be one of ${SPAWN_AXES.join(', ')}, got ${JSON.stringify(axes)}`);
  return { body, axes };
}

const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** v rotated by unit quaternion q (x, y, z, w): v + 2 w (u x v) + 2 u x (u x v), u = q's vector part. */
export function rotateByQuat(q: Quat, v: Vec3): Vec3 {
  const u: Vec3 = [q[0], q[1], q[2]], t = cross(u, v);
  const t2: Vec3 = [2 * t[0], 2 * t[1], 2 * t[2]], c = cross(u, t2);
  return [v[0] + q[3] * t2[0] + c[0], v[1] + q[3] * t2[1] + c[1], v[2] + q[3] * t2[2] + c[2]];
}

/** a b (apply b, then a). */
export function quatProduct(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

/**
 * The orthonormal basis of 'heading' axes around unit `axis` (header): [x, y, z] with y = axis. Also the basis
 * a cone or fan pattern is laid out in (@tb/weapons splitDirections).
 */
export function headingBasis(axis: Vec3): [Vec3, Vec3, Vec3] {
  const [ax, ay, az] = axis;
  const t: Vec3 = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: Vec3 = [ay * t[2] - az * t[1], az * t[0] - ax * t[2], ax * t[1] - ay * t[0]];
  const ul = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  // z = x cross y, so the frame is a rotation (right-handed).
  const w: Vec3 = [u[1] * az - u[2] * ay, u[2] * ax - u[0] * az, u[0] * ay - u[1] * ax];
  return [u, [ax, ay, az], w];
}

/** The unit heading of velocity v: v / |v|, or +y below HEADING_MIN_SPEED. */
export function headingOf(v: Vec3): Vec3 {
  const s = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  return s > HEADING_MIN_SPEED ? [v[0] / s, v[1] / s, v[2] / s] : [0, 1, 0];
}

/** The images of the local x, y and z axes under `axes` for a parent in state `p` (header). */
export function spawnAxes(p: BodyMotion, axes: SpawnAxes): [Vec3, Vec3, Vec3] {
  if (axes === 'world') return [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  if (axes === 'body') return [rotateByQuat(p.rot, [1, 0, 0]), rotateByQuat(p.rot, [0, 1, 0]), rotateByQuat(p.rot, [0, 0, 1])];
  return headingBasis(headingOf(p.linVel));
}

/** Local vector v in axes f: f[0] v.x + f[1] v.y + f[2] v.z. */
const inAxes = (f: [Vec3, Vec3, Vec3], v: Vec3): Vec3 => [
  f[0][0] * v[0] + f[1][0] * v[1] + f[2][0] * v[2],
  f[0][1] * v[0] + f[1][1] * v[1] + f[2][1] * v[2],
  f[0][2] * v[0] + f[1][2] * v[1] + f[2][2] * v[2],
];

/**
 * The child of a relative spawn in world terms (header): `body` placed from parent state `p` in `axes`. Shape
 * and material are the child's. The definition every engine is tested against (@tb/testkit spawn.ts).
 */
export function relativeBody(p: BodyMotion, body: BodyDesc, axes: SpawnAxes = 'world'): BodyDesc {
  const f = spawnAxes(p, axes), r = inAxes(f, body.pos), w = p.angVel, wr = cross(w, r), v = inAxes(f, body.linVel), a = inAxes(f, body.angVel);
  return {
    ...body,
    pos: [p.pos[0] + r[0], p.pos[1] + r[1], p.pos[2] + r[2]],
    rot: axes === 'body' ? quatProduct(p.rot, body.rot) : [...body.rot],
    linVel: [p.linVel[0] + wr[0] + v[0], p.linVel[1] + wr[1] + v[1], p.linVel[2] + wr[2] + v[2]],
    angVel: [w[0] + a[0], w[1] + a[1], w[2] + a[2]],
  };
}

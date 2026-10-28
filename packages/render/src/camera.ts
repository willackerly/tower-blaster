// Orbit camera: yaw/pitch/distance around a target. Pure state + math, so the
// picking ray is unit-testable without a GPU.
import { invert, lookAt, multiply, normalize, perspective, transform, type Mat4, type V3 } from './math.ts';

/**
 * pitch: the eye's elevation seen from the target, radians; below 0 the eye
 * is under the target, looking up. floor: the lowest the eye goes (the
 * ground plus a margin). An eye that would go lower slides in along its line
 * toward the target instead, so dragging on past the floor looks further up
 * from the ground (eyeDistance); distance stays as set, so dragging back
 * restores it. No floor: no limit.
 */
export interface Orbit { target: V3; yaw: number; pitch: number; distance: number; fovY: number; floor?: number }

/** How far above the ground the viewer keeps the eye (Orbit.floor), world units. */
export const EYE_ABOVE_GROUND = 0.25;
/** Closest the eye comes to the target when the floor pushes it in. */
export const MIN_EYE_DISTANCE = 0.5;

/** How far the eye is from the target: the distance, or less where the floor stops it. */
export function eyeDistance(o: Orbit): number {
  if (o.floor === undefined || o.pitch >= 0) return o.distance;
  return Math.min(o.distance, Math.max(MIN_EYE_DISTANCE, (o.target[1] - o.floor) / -Math.sin(o.pitch)));
}

export function eyeOf(o: Orbit): V3 {
  const cp = Math.cos(o.pitch), d = eyeDistance(o);
  return [o.target[0] + d * cp * Math.sin(o.yaw), o.target[1] + d * Math.sin(o.pitch), o.target[2] + d * cp * Math.cos(o.yaw)];
}

export function viewProj(o: Orbit, aspect: number): Mat4 {
  const d = eyeDistance(o);
  const near = Math.max(0.05, d * 0.01);
  return multiply(perspective(o.fovY, aspect, near, d * 20 + 500), lookAt(eyeOf(o), o.target));
}

/** World-space ray through normalized device coords (x, y in -1..1, y up). */
export function rayThrough(o: Orbit, aspect: number, ndcX: number, ndcY: number): { origin: V3; dir: V3 } {
  const inv = invert(viewProj(o, aspect));
  const a = transform(inv, [ndcX, ndcY, 0]);
  const b = transform(inv, [ndcX, ndcY, 1]);
  const pa: V3 = [a[0] / a[3], a[1] / a[3], a[2] / a[3]];
  const pb: V3 = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  return { origin: eyeOf(o), dir: normalize([pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]]) };
}

/**
 * How a scene without a start camera is framed (URL keys view.*): the
 * camera's pitch (degrees; above 0 it looks down at the target, below 0 up) and vertical field of view, degrees, and
 * its distance as a multiple of the closest at which the whole box fits the
 * view (on a square screen; a wider one has room to spare at the sides).
 */
export interface Framing { pitch: number; fit: number; fov: number }

/**
 * Lower and closer than before (Will, 2026-10-27: "generally be lower to the
 * ground"). Chosen from renders of S4 and S14 at 22 (the old framing), 17, 12
 * and 8 degrees: 12 degrees puts the eye about half as high as before and
 * still shows the back rows; 8 hides them. The old framing was 21.8 degrees,
 * 50 degrees of view, 1.35 times the distance at which the box's bounding
 * sphere filled it.
 */
export const DEFAULT_FRAMING: Framing = { pitch: 12, fit: 1.05, fov: 45 };
// Pitch below 0 frames from under the target, looking up (the floor then brings the eye in).
export const FRAMING_LIMITS: { [K in keyof Framing]: readonly [number, number] } = { pitch: [-45, 83], fit: [0.3, 5], fov: [10, 120] };

const rad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Frame an axis-aligned box: look at a point a little below its centre from
 * a 3/4 view, at f's pitch and field of view, f.fit times as far as the
 * closest distance at which all eight corners are inside the view.
 */
export function frame(min: V3, max: V3, f: Framing = DEFAULT_FRAMING): Orbit {
  const fovY = rad(f.fov), yaw = Math.PI / 5, pitch = clampPitch(rad(f.pitch));
  const target: V3 = [(min[0] + max[0]) / 2, (max[1] - min[1]) * 0.45 + min[1], (min[2] + max[2]) / 2];
  // Camera axes (they do not depend on the distance): forward, right, up.
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const fw: V3 = [-cp * Math.sin(yaw), -sp, -cp * Math.cos(yaw)];
  const right: V3 = [Math.cos(yaw), 0, -Math.sin(yaw)];
  const up: V3 = [right[1] * fw[2] - right[2] * fw[1], right[2] * fw[0] - right[0] * fw[2], right[0] * fw[1] - right[1] * fw[0]];
  // A corner c (from the target) is inside when |c.up| and |c.right| are within tan(fov/2) of its depth c.fw + d.
  const t = Math.tan(fovY / 2);
  let d = 0;
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const c = [x - target[0], y - target[1], z - target[2]];
    const dot = (v: V3) => c[0]! * v[0] + c[1]! * v[1] + c[2]! * v[2];
    d = Math.max(d, Math.max(Math.abs(dot(up)), Math.abs(dot(right))) / t - dot(fw));
  }
  return { target, yaw, pitch, distance: Math.max(8, d * f.fit), fovY };
}

/** Pitch limit either way, radians (83 degrees): short of straight down or up, where yaw loses its meaning. */
export const MAX_PITCH = 1.45;

/** The lowest pitch before looking up was allowed: just above level. The game, which sets no floor, still drags only down to it. */
export const HORIZON_PITCH = 0.02;

/** Pitch as dragging keeps it: from looking up at MAX_PITCH (eye below the target), or from min, to looking down at MAX_PITCH. */
export function clampPitch(p: number, min = -MAX_PITCH): number {
  return Math.min(MAX_PITCH, Math.max(min, p));
}

/** Where the camera starts (URL key cam, scene files): an Orbit without its field of view. */
export interface CameraPose { target: V3; yaw: number; pitch: number; distance: number }

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/** The pose of an orbit, to millimetres and milliradians, so URLs and files stay short. */
export function poseOf(o: Orbit): CameraPose {
  return { target: o.target.map(round3) as V3, yaw: round3(o.yaw), pitch: round3(o.pitch), distance: round3(o.distance) };
}

/** An orbit at a pose, with a field of view in degrees; the pitch is clamped as dragging clamps it (the caller sets the floor). */
export function orbitAt(p: CameraPose, fov = DEFAULT_FRAMING.fov): Orbit {
  return { target: [...p.target], yaw: p.yaw, pitch: clampPitch(p.pitch), distance: p.distance, fovY: rad(fov) };
}

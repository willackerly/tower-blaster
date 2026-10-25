// Orbit camera: yaw/pitch/distance around a target. Pure state + math, so the
// picking ray is unit-testable without a GPU.
import { invert, lookAt, multiply, normalize, perspective, transform, type Mat4, type V3 } from './math.ts';

export interface Orbit { target: V3; yaw: number; pitch: number; distance: number; fovY: number }

export function eyeOf(o: Orbit): V3 {
  const cp = Math.cos(o.pitch);
  return [o.target[0] + o.distance * cp * Math.sin(o.yaw), o.target[1] + o.distance * Math.sin(o.pitch), o.target[2] + o.distance * cp * Math.cos(o.yaw)];
}

export function viewProj(o: Orbit, aspect: number): Mat4 {
  const near = Math.max(0.05, o.distance * 0.01);
  return multiply(perspective(o.fovY, aspect, near, o.distance * 20 + 500), lookAt(eyeOf(o), o.target));
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

/** Frame an axis-aligned box: look at its centre from a 3/4 view. */
export function frame(min: V3, max: V3, fovY = (50 * Math.PI) / 180): Orbit {
  const target: V3 = [(min[0] + max[0]) / 2, (max[1] - min[1]) * 0.45 + min[1], (min[2] + max[2]) / 2];
  const radius = Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]) / 2;
  return { target, yaw: Math.PI / 5, pitch: 0.38, distance: Math.max(8, (radius / Math.sin(fovY / 2)) * 1.35), fovY };
}

export function clampPitch(p: number): number {
  return Math.min(1.45, Math.max(0.02, p));
}

// The 24 rotations that map a cube onto itself. A lattice cell stores which
// one its cube had, so a cube that leaves the lattice and comes back keeps
// its visual orientation, and so any of them counts as "on the lattice".
import type { Quat } from '@tb/engine-api';

const S = Math.SQRT1_2;

/** Index 0 is the identity. Each entry is a unit quaternion (x, y, z, w) with w >= 0. */
export const CUBE_ROTATIONS: readonly Quat[] = (() => {
  const out: Quat[] = [[0, 0, 0, 1]];
  // 180 degrees about a face axis.
  out.push([1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]);
  // +-90 degrees about a face axis.
  for (const sgn of [1, -1]) out.push([sgn * S, 0, 0, S], [0, sgn * S, 0, S], [0, 0, sgn * S, S]);
  // 180 degrees about an edge diagonal.
  for (const sgn of [1, -1]) out.push([S, sgn * S, 0, 0], [S, 0, sgn * S, 0], [0, S, sgn * S, 0]);
  // +-120 degrees about a body diagonal.
  for (const x of [1, -1]) for (const y of [1, -1]) for (const z of [1, -1]) out.push([x / 2, y / 2, z / 2, 0.5]);
  return out;
})();

/** Nearest cube symmetry to q and the angle (radians) between them. */
export function nearestCubeRotation(q: Quat): { index: number; angle: number } {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  let best = 0, bestDot = -1;
  for (let i = 0; i < CUBE_ROTATIONS.length; i++) {
    const r = CUBE_ROTATIONS[i]!;
    const d = Math.abs(q[0] * r[0] + q[1] * r[1] + q[2] * r[2] + q[3] * r[3]) / n;
    if (d > bestDot) { bestDot = d; best = i; }
  }
  return { index: best, angle: 2 * Math.acos(Math.min(1, bestDot)) };
}

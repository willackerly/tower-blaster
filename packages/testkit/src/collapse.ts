// Answers and readers for the S12 and S13 tests. S13 is a column of H unit
// cubes leaning on its base edge; its answer is the same column as one rigid
// W x H box, rocking on its corners.
// With joints that never open, a column of loose cubes moves like this box,
// so an engine that has converged should follow it until the joints open.
//
// The box pivots on a base corner. Its centre of mass is R = sqrt(W^2 + H^2) / 2
// from that corner, at the angle alpha = atan(W / H) from the box's axis, so
// with lean theta (> 0 towards the pivot side):
//   I0 theta'' = m g R sin(theta - alpha),  I0 = m (W^2 + H^2) / 3,
// and it topples iff theta > alpha. Below alpha it rocks back, lands on the
// other corner and pivots there (mirror image). The landing is Housner's
// (1963) inelastic impact: angular momentum about the new corner is kept and
// the angular velocity drops by r = 1 - 2 m R^2 sin^2(alpha) / I0
// = 1 - 1.5 sin^2(alpha).

import type { SceneDesc } from '@tb/engine-api';

const G = 9.81;
const DEG = Math.PI / 180;

/** The lean, in degrees, past which the rigid column topples: atan(W / H). */
export const tippingAngle = (H: number, W = 1) => Math.atan(W / H) / DEG;

function rod(H: number, W: number) {
  const R = Math.hypot(W, H) / 2, alpha = Math.atan(W / H), I0 = (W * W + H * H) / 3; // per unit mass
  return { R, alpha, p2: (G * R) / I0, r: 1 - 1.5 * Math.sin(alpha) ** 2 };
}

/**
 * Seconds for the rigid column, released at rest at `fromDeg` (> its tipping
 * angle), to reach `toDeg`. RK4 with step h; the default is converged to 1e-6 s.
 */
export function rodToppleTime(H: number, fromDeg: number, toDeg: number, W = 1, h = 1e-4): number {
  const { alpha, p2 } = rod(H, W);
  if (fromDeg * DEG <= alpha) throw new Error(`rodToppleTime: ${fromDeg} deg is below the tipping angle ${tippingAngle(H, W)} deg`);
  let th = fromDeg * DEG, om = 0, t = 0;
  const f = (x: number) => p2 * Math.sin(x - alpha);
  while (th < toDeg * DEG) {
    const k1x = om, k1v = f(th);
    const k2x = om + (h / 2) * k1v, k2v = f(th + (h / 2) * k1x);
    const k3x = om + (h / 2) * k2v, k3v = f(th + (h / 2) * k2x);
    const k4x = om + h * k3v, k4v = f(th + h * k3x);
    const next = th + (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x);
    // Linear interpolation to the crossing inside the last step.
    if (next >= toDeg * DEG) return t + (h * (toDeg * DEG - th)) / (next - th);
    th = next; om += (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v); t += h;
    if (t > 1e3) throw new Error('rodToppleTime: no topple within 1000 s');
  }
  return t;
}

/**
 * The rigid column released at rest at `fromDeg` (0 < fromDeg < its tipping
 * angle): when it first stands upright (and lands on its other corner), and
 * how far it leans on that side after Housner's impact (degrees, positive).
 * phi = theta - alpha obeys phi'' = p^2 sin(phi), so phi'^2 = 2 p^2 (cos phi0 - cos phi)
 * and the time to upright is the integral of 1 / |phi'| (done numerically).
 * The far-side lean theta1 has r^2 of the energy at landing:
 * cos(alpha - theta1) - cos(alpha) = r^2 (cos(alpha - theta0) - cos(alpha)).
 */
export function rodRock(H: number, fromDeg: number, W = 1): { upright: number; farSide: number } {
  const { alpha, p2, r } = rod(H, W);
  const th0 = fromDeg * DEG;
  if (th0 <= 0 || th0 >= alpha) throw new Error(`rodRock: ${fromDeg} deg must be inside (0, ${tippingAngle(H, W)})`);
  // 1 / |phi'| is singular at the release, theta0; theta = theta0 (1 - s^2)
  // cancels it, so the midpoint rule in s converges.
  const n = 20000;
  let upright = 0;
  for (let i = 0; i < n; i++) {
    const s = (i + 0.5) / n, th = th0 * (1 - s * s), dth = (2 * th0 * s) / n;
    upright += dth / Math.sqrt(2 * p2 * (Math.cos(alpha - th0) - Math.cos(alpha - th)));
  }
  const c = Math.cos(alpha) + r * r * (Math.cos(alpha - th0) - Math.cos(alpha));
  return { upright, farSide: (alpha - Math.acos(c)) / DEG };
}

/**
 * Lean in degrees of a column of cubes 0..H-1 (bottom to top): the angle
 * from vertical of the line from the bottom cube's centre to the top one's,
 * positive towards +x.
 */
export function leanDeg(pos: ArrayLike<number>, H: number): number {
  const t = 3 * (H - 1);
  return Math.atan2(pos[t]! - pos[0]!, pos[t + 1]! - pos[1]!) / DEG;
}

/** How far the column bends: the largest distance of a cube centre from that bottom-to-top line (x-y plane). */
export function bendOf(pos: ArrayLike<number>, H: number): number {
  const bx = pos[0]!, by = pos[1]!, dx = pos[3 * (H - 1)]! - bx, dy = pos[3 * (H - 1) + 1]! - by;
  const L = Math.hypot(dx, dy);
  let worst = 0;
  for (let k = 1; k < H - 1; k++) worst = Math.max(worst, Math.abs((pos[3 * k]! - bx) * dy - (pos[3 * k + 1]! - by) * dx) / L);
  return worst;
}

export interface ColumnSample { t: number; pos: ArrayLike<number> }

/**
 * What the S13 tests read from a run of a column of H cubes, sampled in time
 * order. Crossing times are interpolated linearly between samples.
 * - topple: when the lean first reaches toppleDeg (null if never);
 *   bend: the largest bendOf before that.
 * - upright: when the lean first drops below 0 (null if never); before: the
 *   largest lean until then; farSide: the deepest lean on the other side
 *   (positive) until it comes back past 0 or the samples end; turned: it was
 *   past that extreme before the samples ended.
 */
export function readColumn(samples: ColumnSample[], H: number, toppleDeg = 30) {
  let topple: number | null = null, bend = 0, upright: number | null = null, before = -Infinity, farSide = 0, turned = false;
  let prev: { t: number; a: number } | null = null;
  for (const s of samples) {
    const a = leanDeg(s.pos, H);
    const at = (x: number) => (prev ? prev.t + ((s.t - prev.t) * (x - prev.a)) / (a - prev.a) : s.t);
    if (topple === null) {
      if (a >= toppleDeg) topple = at(toppleDeg);
      else bend = Math.max(bend, bendOf(s.pos, H));
    }
    if (upright === null) {
      if (a < 0) { upright = at(0); farSide = -a; } else before = Math.max(before, a);
    } else if (!turned) {
      if (-a < farSide) turned = true;
      else farSide = -a;
    }
    prev = { t: s.t, a };
  }
  return { topple, bend, upright, before, farSide, turned };
}

/** Indices of S12's cubes above its hole (stack bond), from its parameters. */
export function aboveHole(scene: SceneDesc): number[] {
  const { W, holeW, holeH, holeY } = scene.params as Record<string, number>;
  const x0 = Math.floor((W! - holeW!) / 2) - (W! - 1) / 2;
  return scene.bodies.flatMap((b, i) => (b.pos[0] > x0 - 0.1 && b.pos[0] < x0 + holeW! - 0.9 && b.pos[1] > holeY! + holeH! ? [i] : []));
}

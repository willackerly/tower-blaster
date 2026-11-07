// The ground's motion during a quake (PT25, docs/game/aftershock.md "Seeing the quake"), for the picture only.
//
// The engine shakes nothing: a quake is a side gravity on a still ground (engine-api quakeEvents), which is the
// ground's own frame. A watcher standing off the site sees the ground move instead, by the side load integrated
// twice: the ground's acceleration is minus the side gravity (a ground accelerating at +a pushes what stands on it
// toward -a in its frame). The game draws the site (the ground, its grid and every body on it) displaced by that
// motion, so the towers rock on a ground that visibly shakes, while the eye, which is not on the site, stays where
// the player put it: the camera's own state never changes (Will's camera rule, 2026-11-02).
//
// The double integral of a quake's side load does not quite end where it began (the velocity left over at the end
// carries the ground away), which no watcher of a real quake sees; so the motion has the straight line from its first
// to its last point taken off, and starts and ends at rest at home. It is drawn at true scale: 0.3 g at 1 Hz moves the
// ground about 7 cm (a seventh of a cube), at 3 Hz under 1 cm.
import { type CompiledLevel, quakeInputs, type QuakeShot } from '@tb/keystone';

/**
 * The ground's displacement at each engine step of a quake, from its first step; metres along x and z. `load` is the
 * side load the towers feel at each step, as a fraction of g (what raises the dust at their feet).
 */
export interface GroundMotion { x: Float64Array; z: Float64Array; load: Float64Array; steps: number }

/** The ground's motion under `shot` on level `c` (the very field events the engine gets), one sample per step from the fire step. */
export function groundMotion(c: CompiledLevel, shot: QuakeShot): GroundMotion {
  const ev = quakeInputs(c, shot, 0), g = c.scene.gravity, dt = c.scene.dt;
  const steps = ev.at(-1)?.step ?? 0, x = new Float64Array(steps + 1), z = new Float64Array(steps + 1), load = new Float64Array(steps + 1), gn = Math.hypot(...g);
  let k = 0, ax = 0, az = 0, vx = 0, vz = 0;
  for (let s = 0; s < steps; s++) {
    while (k < ev.length && ev[k]!.step <= s) { const v = ev[k]!.gravity!; ax = -(v[0] - g[0]); az = -(v[2] - g[2]); k++; }
    load[s] = Math.hypot(ax, az) / gn;
    // Semi-implicit Euler at the engine's step, as a body on the ground would move with it.
    vx += ax * dt; vz += az * dt;
    x[s + 1] = x[s]! + vx * dt; z[s + 1] = z[s]! + vz * dt;
  }
  // Take off the drift: the straight line from the first sample to the last.
  for (let s = 0; s <= steps; s++) { const t = steps ? s / steps : 0; x[s] = x[s]! - t * x[steps]!; z[s] = z[s]! - t * z[steps]!; }
  return { x, z, load, steps };
}

/**
 * The steps in (from, to] where the side load peaks (each swing's strongest push, twice a cycle), above `floor` g:
 * the beats at which the towers' feet kick up dust (PT25). Fractional bounds are the drawn frame's (quakeAt).
 */
export function dustBeats(m: GroundMotion, from: number, to: number, floor = 0.05): number[] {
  const out: number[] = [], l = m.load;
  for (let s = Math.max(1, Math.floor(from) + 1); s <= Math.min(m.steps - 1, Math.floor(to)); s++) {
    if (l[s]! >= floor && l[s]! >= l[s - 1]! && l[s]! > l[s + 1]!) out.push(s);
  }
  return out;
}

/** The ground's displacement at fractional step `at` from the fire step (between samples, linear), zero outside the quake. */
export function groundAt(m: GroundMotion, at: number): [number, number] {
  if (!(at > 0) || at >= m.steps) return [0, 0];
  const i = Math.floor(at), f = at - i;
  return [m.x[i]! + (m.x[i + 1]! - m.x[i]!) * f, m.z[i]! + (m.z[i + 1]! - m.z[i]!) * f];
}

/** The peak distance the ground moves from home, metres. */
export function groundPeak(m: GroundMotion): number {
  let p = 0;
  for (let s = 0; s <= m.steps; s++) p = Math.max(p, Math.hypot(m.x[s]!, m.z[s]!));
  return p;
}

// Undercut's pull, drawn (playtest PT17: "the chosen block simply vanishes
// between frames, so cause and effect is hard to read"). Two parts:
//
//   slide   for PULL_SLIDE_STEPS physics steps after the pull (0.25 s at
//           60 Hz) the renderer is fed the pulled block where it would be had
//           it slid out of the structure toward the camera (eased out, a
//           block's depth and a little more), shrinking away over the second
//           half. Step-driven, not wall-time, so a capture N steps after a
//           pull is the same every run, the slide holds while Bullet Time
//           freezes the world and runs faster under fast-forward, as the
//           world does.
//   ghost   for PULL_GHOST_MS of wall time a dotted outline of the block where
//           it stood (overlay beads along its twelve edges), fading, so the
//           hole reads as "a block was here".
//
// Only what is drawn changes: the engine removed the body at the pull's step
// (a tombstone, engine-api remove.ts) and nothing the physics, the rules or a
// replay sees is touched. The game patches a copy of the slot's pose into the
// snapshot it uploads (withPulled), and puts it back at once.
//
// Alternatives weighed: wall-time slide (smoother on a 120 Hz display, but a
// capture "10 steps after" would depend on frame timing, and it would keep
// sliding through a freeze); a transparent ghost box (no transparent pass for
// bodies, and it would cost one in every look); delaying the engine's removal
// (changes the physics and every recorded line). The overlay beads and the
// patched slot reuse what every look already draws. Off with keystone.pullanim=0.
import type { Snapshot } from '@tb/engine-api';
import { rgbe } from './scene.ts';

type V3 = [number, number, number];
type Quat = [number, number, number, number];

/** Physics steps the slide-out takes (0.25 s at 60 Hz). */
export const PULL_SLIDE_STEPS = 15;
/** How long the ghost outline stays, ms (fading out). */
export const PULL_GHOST_MS = 1000;
/** The ghost's beads: at most this far apart along an edge, in units of the block's smallest half-extent. */
const GHOST_SPACING = 0.5;
/** The ghost's bead colour: sRGB rgb8 + emissive8 (Renderer.setOverlay), warm white as the hover light (PULL_HOVER). */
export const GHOST_COLOUR = rgbe(255, 237, 205, 0.45);

export interface PullAnim {
  body: number;
  /** The block's pose when it was pulled. */
  pos: V3;
  rot: Quat;
  half: V3;
  /** Horizontal unit vector toward the camera at the pull, and how far the slide goes along it. */
  dir: V3;
  slide: number;
  /** Physics steps since the pull (0 at the pull itself). */
  step: number;
  /** Wall time of the pull, ms (performance.now). */
  at: number;
}

/** Rotate v by the unit quaternion q (x, y, z, w). */
export function rotate(q: Quat, v: V3): V3 {
  const [x, y, z, w] = q;
  const tx = 2 * (y * v[2] - z * v[1]), ty = 2 * (z * v[0] - x * v[2]), tz = 2 * (x * v[1] - y * v[0]);
  return [v[0] + w * tx + (y * tz - z * ty), v[1] + w * ty + (z * tx - x * tz), v[2] + w * tz + (x * ty - y * tx)];
}

/** The pull of a box with pose (pos, rot) and half-extents `half`, seen from `eye`, at wall time `at`. */
export function pullAnimFor(body: number, pos: V3, rot: Quat, half: V3, eye: V3, at: number): PullAnim {
  let dx = eye[0] - pos[0], dz = eye[2] - pos[2];
  const l = Math.hypot(dx, dz);
  if (l < 1e-6) { dx = 0; dz = 1; } else { dx /= l; dz /= l; }
  const dir: V3 = [dx, 0, dz];
  // The box's extent along dir: the sum over its axes of |axis . dir| x half.
  const axes = [rotate(rot, [1, 0, 0]), rotate(rot, [0, 1, 0]), rotate(rot, [0, 0, 1])];
  const extent = axes.reduce((s, a, k) => s + Math.abs(a[0] * dir[0] + a[2] * dir[2]) * half[k]!, 0);
  return { body, pos: [...pos], rot: [...rot], half: [...half], dir, slide: 2.2 * extent, step: 0, at };
}

/** Ease out (cubic): quick start, gentle stop. */
const easeOut = (t: number) => 1 - (1 - t) ** 3;
const smoothstep = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

/** Where the slide has the block `k` steps after the pull, and its visual scale; null once the slide is over. */
export function pullPose(a: PullAnim, k: number): { pos: V3; scale: number } | null {
  if (k < 1 || k > PULL_SLIDE_STEPS) return null;
  const t = k / PULL_SLIDE_STEPS, s = a.slide * easeOut(t);
  return { pos: [a.pos[0] + a.dir[0] * s, a.pos[1], a.pos[2] + a.dir[2] * s], scale: 1 - 0.85 * smoothstep(0.35, 1, t) };
}

/**
 * Run `draw` (the snapshot upload) with slot a.body drawn at its slide pose `k` steps after the pull: the
 * slot's pose, tier and awake flag patched in place and put back before returning, so the snapshot is
 * unchanged for every other reader. Returns the pose drawn (null: none, the slot stays a tombstone).
 */
export function withPulled(s: Snapshot, a: PullAnim, k: number, draw: () => void): { pos: V3; scale: number } | null {
  const p = pullPose(a, k), b = a.body;
  if (!p || b >= s.count) { draw(); return null; }
  const pos = s.pos.slice(3 * b, 3 * b + 3), rot = s.rot.slice(4 * b, 4 * b + 4), tier = s.tier?.[b], awake = s.awake[b]!;
  s.pos.set(p.pos, 3 * b);
  s.rot.set(a.rot, 4 * b);
  if (s.tier) s.tier[b] = 0;
  s.awake[b] = 1;
  try { draw(); } finally {
    s.pos.set(pos, 3 * b);
    s.rot.set(rot, 4 * b);
    if (s.tier && tier !== undefined) s.tier[b] = tier;
    s.awake[b] = awake;
  }
  return p;
}

/** The ghost outline `ms` after the pull: beads along the block's twelve edges, shrinking to nothing; null once gone. */
export function ghostOutline(a: PullAnim, ms: number): { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> } | null {
  if (ms < 0 || ms >= PULL_GHOST_MS) return null;
  const fade = 1 - smoothstep(0.5 * PULL_GHOST_MS, PULL_GHOST_MS, ms);
  const hmin = Math.min(...a.half), r = Math.min(0.045, 0.16 * hmin) * fade;
  const corner = (sx: number, sy: number, sz: number): V3 => {
    const o = rotate(a.rot, [sx * a.half[0], sy * a.half[1], sz * a.half[2]]);
    return [a.pos[0] + o[0], a.pos[1] + o[1], a.pos[2] + o[2]];
  };
  const pts: number[] = [];
  // The twelve edges: for each axis, the four edges along it.
  for (let ax = 0; ax < 3; ax++) {
    const n = Math.max(1, Math.ceil((2 * a.half[ax]!) / (GHOST_SPACING * hmin)));
    for (const u of [-1, 1]) for (const v of [-1, 1]) {
      for (let i = 0; i <= n; i++) {
        // Corners belong to the x edges only, so none is drawn twice.
        if (ax > 0 && (i === 0 || i === n)) continue;
        const t = -1 + (2 * i) / n, sgn: V3 = ax === 0 ? [t, u, v] : ax === 1 ? [u, t, v] : [u, v, t];
        pts.push(...corner(...sgn));
      }
    }
  }
  const m = pts.length / 3, xyzr = new Float32Array(4 * m);
  for (let k = 0; k < m; k++) { xyzr.set([pts[3 * k]!, pts[3 * k + 1]!, pts[3 * k + 2]!, r], 4 * k); }
  return { xyzr, colours: new Uint32Array(m).fill(GHOST_COLOUR) };
}

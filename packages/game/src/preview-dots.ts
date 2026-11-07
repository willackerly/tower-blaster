// The aim preview's dots as the screen shows them (PT36, docs/game/aim-clarity.md). The dots are spheres in the
// world (scene.ts beadOverlay: 6 cm, the target 11 cm), so the ones near the eye grew without bound: from behind the
// eye the first dots of a flight sat a few metres from the camera and drew as 30 px blobs over the crowns (agent
// playtest 2: L1, L3, D2). Here, for the frame's view:
//   - a dot within DOT_NEAR_M of the eye is not drawn, and the next DOT_FADE_M shrink in;
//   - no dot is drawn wider than DOT_MAX_PX on screen (CSS px);
//   - no dot is drawn over an objective (a crown or heritage block) it stands in front of, but the last: the flight
//     shows a gap across them, and the target dot and the impact marker still say where it lands.
// Render only: the flight, the shot and the marker are unchanged.
import type { Snapshot, Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { eyeOf, type Orbit, viewProj } from '@tb/render/camera';
import { transform } from '@tb/render/math';

/** The widest a dot is drawn, CSS px (PT36's verify: none over 10). */
export const DOT_MAX_PX = 8;
/** Dots nearer the eye than this (m) are not drawn. */
export const DOT_NEAR_M = 3;
/** Beyond DOT_NEAR_M, dots grow to full size over this many metres. */
export const DOT_FADE_M = 2;

/** An overlay: spheres (x, y, z, radius) and their colours, as the renderer draws them. */
export interface Dots { xyzr: Float32Array<ArrayBuffer>; colours: Uint32Array<ArrayBuffer> }

/** A body's box on screen, CSS px from the top left, and the nearest its corners come to the eye (view depth, m). */
export interface ScreenBox { x0: number; y0: number; x1: number; y1: number; depth: number }

/** The screen as the view sees it: the view, and the canvas's CSS size. */
export interface Screen { view: Orbit; width: number; height: number }

/** Where world point p falls on the screen (CSS px from the top left) and its view depth (clip w); null behind the eye. */
export function onScreen(p: Vec3, vp: Float32Array, s: Pick<Screen, 'width' | 'height'>): { x: number; y: number; depth: number } | null {
  const q = transform(vp, p);
  if (!(q[3] > 1e-6)) return null;
  return { x: ((q[0] / q[3] + 1) / 2) * s.width, y: ((1 - q[1] / q[3]) / 2) * s.height, depth: q[3] };
}

/** The screen boxes of structure bodies `bodies` at their poses in `snap` (`half`: each body's half extents, xyz per body). Bodies with a corner behind the eye are left out. */
export function screenBoxes(bodies: ArrayLike<number>, snap: Pick<Snapshot, 'pos' | 'rot'>, half: ArrayLike<number>, s: Screen): ScreenBox[] {
  const vp = viewProj(s.view, s.width / Math.max(1, s.height)), out: ScreenBox[] = [];
  for (let j = 0; j < bodies.length; j++) {
    const i = bodies[j]!, pos: Vec3 = [snap.pos[3 * i]!, snap.pos[3 * i + 1]!, snap.pos[3 * i + 2]!];
    const q: [number, number, number, number] = [snap.rot[4 * i]!, snap.rot[4 * i + 1]!, snap.rot[4 * i + 2]!, snap.rot[4 * i + 3]!];
    const h: Vec3 = [half[3 * i]!, half[3 * i + 1]!, half[3 * i + 2]!];
    let box: ScreenBox | null = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, depth: Infinity };
    for (let k = 0; k < 8 && box; k++) {
      const w = rotate(q, [k & 1 ? h[0] : -h[0], k & 2 ? h[1] : -h[1], k & 4 ? h[2] : -h[2]]);
      const p = onScreen([pos[0] + w[0], pos[1] + w[1], pos[2] + w[2]], vp, s);
      if (!p) { box = null; break; }
      box.x0 = Math.min(box.x0, p.x); box.x1 = Math.max(box.x1, p.x); box.y0 = Math.min(box.y0, p.y); box.y1 = Math.max(box.y1, p.y);
      box.depth = Math.min(box.depth, p.depth);
    }
    if (box) out.push(box);
  }
  return out;
}

/** A disc (centre, radius, CSS px) meets a box. */
const discMeets = (x: number, y: number, r: number, b: ScreenBox) => Math.hypot(x - Math.max(b.x0, Math.min(b.x1, x)), y - Math.max(b.y0, Math.min(b.y1, y))) < r;

/**
 * The aim preview's dots as drawn for screen `s` (see the top of this file): near ones dropped or shrunk, each at
 * most DOT_MAX_PX across, none but the last over a box of `objectives` it stands in front of. The colours stay
 * with their dots.
 */
export function fitDots(dots: Dots, s: Screen, objectives: readonly ScreenBox[] = []): Dots {
  const n = dots.colours.length, vp = viewProj(s.view, s.width / Math.max(1, s.height)), eye = eyeOf(s.view);
  // CSS px per metre at view depth 1: the projection's vertical scale over half the height.
  const pxAt1 = s.height / 2 / Math.tan(s.view.fovY / 2);
  const xyzr: number[] = [], colours: number[] = [];
  for (let k = 0; k < n; k++) {
    const p: Vec3 = [dots.xyzr[4 * k]!, dots.xyzr[4 * k + 1]!, dots.xyzr[4 * k + 2]!];
    const d = Math.hypot(p[0] - eye[0], p[1] - eye[1], p[2] - eye[2]);
    if (d < DOT_NEAR_M) continue;
    const at = onScreen(p, vp, s);
    if (!at) continue;
    let r = dots.xyzr[4 * k + 3]! * Math.min(1, (d - DOT_NEAR_M) / DOT_FADE_M);
    const px = (r * pxAt1) / at.depth;
    if (2 * px > DOT_MAX_PX) r *= DOT_MAX_PX / (2 * px);
    const rPx = Math.min(px, DOT_MAX_PX / 2);
    if (k < n - 1 && objectives.some((b) => at.depth < b.depth + 1e-6 && discMeets(at.x, at.y, rPx, b))) continue;
    if (!(r > 0)) continue;
    xyzr.push(p[0], p[1], p[2], r);
    colours.push(dots.colours[k]!);
  }
  return { xyzr: Float32Array.from(xyzr), colours: Uint32Array.from(colours) };
}

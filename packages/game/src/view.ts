// The game's opening camera for a level (no WebGPU or WebAudio here, so node CLIs can use it).
import type { Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { EYE_ABOVE_GROUND, frame, type Orbit, viewProj } from '@tb/render/camera';

/** The share of an upright phone's screen height the HUD takes at the top (the compact touch HUD with its opener and lot sheet line: about 300 of 844 px, plus a margin). */
export const PORTRAIT_HUD_SHARE = 0.4;

/**
 * Frame the structure; face the par line's launcher when it has one. The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the viewer.
 * `aspect` (width / height) matters only under 1, a phone held upright, which frames the structure's width to fit too, below the HUD.
 */
export function viewOf(c: CompiledLevel, aspect = 1): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const first = c.def.solutions?.par?.[0];
  const at = (top: number): Orbit => {
    const o = frame(min, [max[0], top, max[2]], undefined, 1, min[1], aspect);
    if (first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
    return { ...o, floor: EYE_ABOVE_GROUND };
  };
  if (aspect >= 1) return at(c.height);
  // Upright, the HUD spans the top of the screen: frame a taller box, taller until the structure's box sits
  // below the HUD's band and within the sides (the launcher's yaw is set after the fit, so it is checked here).
  let o = at(c.height / (1 - PORTRAIT_HUD_SHARE));
  for (let k = 0; k < 40 && !clearOfHud(o, aspect, min, max); k++) o = at(o.target[1] / 0.45 * 1.05);
  return o;
}

/** Every corner of the box (min, max) in front of the eye, within the sides, and under the top PORTRAIT_HUD_SHARE of the screen. */
export function clearOfHud(o: Orbit, aspect: number, min: Vec3, max: Vec3): boolean {
  const m = viewProj(o, aspect);
  for (const x of [min[0], max[0]]) for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) {
    const w = m[3]! * x + m[7]! * y + m[11]! * z + m[15]!;
    if (!(w > 0)) return false;
    const px = (m[0]! * x + m[4]! * y + m[8]! * z + m[12]!) / w, py = (m[1]! * x + m[5]! * y + m[9]! * z + m[13]!) / w;
    if (Math.abs(px) > 1 || py > 1 - 2 * PORTRAIT_HUD_SHARE || py < -1) return false;
  }
  return true;
}

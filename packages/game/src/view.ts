// The game's opening camera for a level (no WebGPU or WebAudio here, so node CLIs can use it).
import type { Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { EYE_ABOVE_GROUND, frame, type Orbit } from '@tb/render/camera';

/** The share of an upright phone's screen height the HUD takes at the top (ui.ts's compact touch HUD: about 250 of 844 px). */
export const PORTRAIT_HUD_SHARE = 0.32;

/**
 * Frame the structure; face the par line's launcher when it has one. The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the viewer.
 * `aspect` (width / height) matters only under 1, a phone held upright, which frames the structure's width to fit too, below the HUD.
 */
export function viewOf(c: CompiledLevel, aspect = 1): Orbit {
  // Upright, the HUD spans the top of the screen: frame a box that much taller, so the structure (its crowns) sits below it.
  const top = aspect < 1 ? c.height / (1 - PORTRAIT_HUD_SHARE) : c.height;
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, top, -Infinity];
  for (let i = 0; i < c.meta.n; i++) for (const k of [0, 2] as const) {
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const o = frame(min, max, undefined, 1, min[1], aspect);
  const first = c.def.solutions?.par?.[0];
  if (first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
  return { ...o, floor: EYE_ABOVE_GROUND };
}


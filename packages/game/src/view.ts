// The game's opening camera for a level (no WebGPU or WebAudio here, so node CLIs can use it).
import type { Vec3 } from '@tb/engine-api';
import type { CompiledLevel } from '@tb/keystone';
import { DEFAULT_FRAMING, EYE_ABOVE_GROUND, eyeDistance, frame, type Framing, type Orbit, viewProj } from '@tb/render/camera';

/** The share of an upright phone's screen height the HUD takes at the top (the compact touch HUD with its opener and lot sheet line: about 300 of 844 px, plus a margin). */
export const PORTRAIT_HUD_SHARE = 0.4;

/**
 * Frame the structure; face the par line's launcher when it has one. The eye stays EYE_ABOVE_GROUND over the ground (y 0), as in the viewer.
 * `aspect` (width / height) matters only under 1, a phone held upright, which frames the structure's width to fit too, below the HUD.
 * `face` (degrees, as Framing has them) looks from that side and height instead, the fit made from there (a duel's turn view, duel-view.ts duelView).
 * `focus` puts that point at the screen's centre instead of the structure's middle, as far back as the framed bodies need;
 * `only` frames those structure bodies (all of them when absent; a duel's turn view frames all but the player's own).
 */
export function viewOf(c: CompiledLevel, aspect = 1, face?: Pick<Framing, 'yaw' | 'pitch'>, focus?: Vec3, only?: ArrayLike<number>): Orbit {
  const min: Vec3 = [Infinity, 0, Infinity], max: Vec3 = [-Infinity, c.height, -Infinity];
  const all = only ?? { length: c.meta.n };
  for (let j = 0; j < all.length; j++) for (const k of [0, 2] as const) {
    const i = only ? only[j]! : j;
    min[k] = Math.min(min[k], c.meta.home[3 * i + k]! - c.meta.half[3 * i + k]! - 1);
    max[k] = Math.max(max[k], c.meta.home[3 * i + k]! + c.meta.half[3 * i + k]! + 1);
  }
  const first = c.def.solutions?.par?.[0];
  const at = (top: number): Orbit => {
    const o = frame(min, [max[0], top, max[2]], face && { ...DEFAULT_FRAMING, ...face }, 1, min[1], aspect, focus);
    if (!face && first && 'az' in first) o.yaw = ((90 - first.az / 2) * Math.PI) / 180;
    return { ...o, floor: EYE_ABOVE_GROUND };
  };
  if (aspect >= 1) return at(c.height);
  // Upright, the HUD spans the top of the screen: frame a taller box, taller until the structure's box sits
  // below the HUD's band and within the sides (the launcher's yaw is set after the fit, so it is checked here).
  // With a focus, it goes to the middle of the screen below the HUD (playCentre), and the eye backs off, 5% a try, until the box clears the HUD.
  if (focus) {
    const base = at(c.height);
    let o = base;
    for (let k = 0; k < 60; k++) {
      o = lowered({ ...base, distance: base.distance * 1.05 ** k }, focus);
      if (clearOfHud(o, aspect, min, max)) break;
    }
    return o;
  }
  let top = c.height / (1 - PORTRAIT_HUD_SHARE), o = at(top);
  for (let k = 0; k < 40 && !clearOfHud(o, aspect, min, max); k++) o = at((top *= 1.05));
  return o;
}

/** Where the middle of what an upright phone shows below the HUD is, in normalised device coordinates: [0, -PORTRAIT_HUD_SHARE]. */
export const PLAY_CENTRE_PORTRAIT: readonly [number, number] = [0, -PORTRAIT_HUD_SHARE];

/**
 * The orbit o raised (its target and so its eye) until `focus`, at o's target, shows at PLAY_CENTRE_PORTRAIT: a point
 * at depth d + D sin(pitch) and D cos(pitch) below the view's middle shows at -s when D = s t d / (cos(pitch) - s t sin(pitch)),
 * t = tan(fovY / 2), s = PORTRAIT_HUD_SHARE.
 */
function lowered(o: Orbit, focus: Vec3): Orbit {
  const s = PORTRAIT_HUD_SHARE, t = Math.tan(o.fovY / 2), d = eyeDistance({ ...o, target: [...focus] });
  const up = (s * t * d) / (Math.cos(o.pitch) - s * t * Math.sin(o.pitch));
  return { ...o, target: [focus[0], focus[1] + up, focus[2]] };
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

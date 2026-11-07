// Where the real look's sun stands in a level: turned with the level's opening view, so every level is lit
// from the same side of the player's eye (PT15, agent playtest 1). The look's sun is fixed in the world
// (realLook: azimuth 140 degrees clockwise from -z), and the levels' opening views look every which way:
// B1-B3, L4 and U1-U3 open with the eye at azimuth 144, the sun 4 degrees off straight behind the eye,
// so the towers face the camera fully lit and every shadow falls behind them (the judges: "B2 shows no
// tower shadows"). L2 and L3 open with the eye at azimuth 0, where the look's 140 degrees put the sun
// over the player's right shoulder, past the structure: long shadows toward the left foreground, a lit
// face and a shaded face on each block (`L3-real-desktop-00`, the frame the judges held up).
//
// So in mode 'view' the look's sun azimuth counts from the opening eye instead of from -z: every level is
// lit as L3 is, and L2 and L3 are drawn exactly as before. The sun is set when a level loads and stays put
// (the camera rule: only the player moves the view, and the light does not follow it either); a retry keeps
// it. Only the real look (an atmosphere) is turned: the stylized looks light from their own fixed key, and
// their shadows already read on every level (B2 hazy, `B2-hazy` in the PT15 captures).
import type { LookParams } from '@tb/render';

/** keystone.sun: 'view' (the default) turns the real look's sun with the level's opening view; 'look' keeps the look's own. */
export const SUN_MODES = ['view', 'look'] as const;
export type SunMode = (typeof SUN_MODES)[number];

/** The compass azimuth (degrees clockwise from -z toward +x, the sun's convention, @tb/render sunFrom) of the eye seen from the target, for an orbit's yaw (radians, @tb/render eyeOf). */
export function eyeAzimuth(yaw: number): number {
  const a = 180 - (yaw * 180) / Math.PI;
  return ((a % 360) + 360) % 360;
}

/**
 * The look with its sun turned clockwise by the eye's azimuth, so the look's sun azimuth counts from the
 * eye of an orbit with this yaw rather than from -z; the elevation is kept. The look itself when it has no
 * atmosphere (only the real look is turned) or no sun of its own.
 */
export function sunForView(look: LookParams, yaw: number): LookParams {
  if (!look.atmosphere || !look.sunDir) return look;
  const d = (eyeAzimuth(yaw) * Math.PI) / 180, c = Math.cos(d), s = Math.sin(d);
  const [x, y, z] = look.sunDir;
  return { ...look, sunDir: [x * c - z * s, y, z * c + x * s] };
}

/**
 * Keeps a renderer's look turned for the level's opening view (sunForView): each frame, a look set on the
 * renderer from outside (the front door's Look setting) becomes the new base, and the turned look is
 * built again only when the base, the yaw or the mode changes, so the renderer sees one object per change.
 */
export class ViewSun {
  /** The opening view's yaw (radians, Orbit.yaw), set as a level loads. */
  yaw = 0;
  private base: LookParams | null = null;
  private turned: LookParams | null = null;
  private key = '';

  /** Set the renderer's look to its base's, turned for `yaw` in mode 'view'. */
  update(r: { look: LookParams }, mode: SunMode): void {
    if (r.look !== this.turned) { this.base = r.look; this.key = ''; }
    const key = `${mode}:${this.yaw}`;
    if (key === this.key) return;
    this.key = key;
    this.turned = r.look = mode === 'view' ? sunForView(this.base!, this.yaw) : this.base!;
  }
}

// The real look's sun turned with the opening view (light.ts): the azimuth convention, what turning keeps,
// and the ViewSun cache (one look object per change, a look set from outside becomes the new base).
import { describe, expect, it } from 'vitest';
import { compileLevel, L3, levelById } from '@tb/keystone';
import { LOOKS, realLook, sunFrom, type LookParams } from '@tb/render';
import { eyeOf } from '@tb/render/camera';
import { eyeAzimuth, sunForView, ViewSun } from '../src/light.ts';
import { viewOf } from '../src/view.ts';

const deg = (r: number) => (r * 180) / Math.PI;
/** Compass azimuth of a direction (sunFrom's convention: clockwise from -z toward +x), degrees 0 to 360. */
const azOf = (d: readonly number[]) => ((deg(Math.atan2(d[0]!, -d[2]!)) % 360) + 360) % 360;

describe('the sun from the opening view', () => {
  it('eyeAzimuth is the azimuth of the eye seen from the target, in the sun\'s convention', () => {
    for (const yaw of [-Math.PI, -2, -0.5, 0, 0.63, 1.5, 3]) {
      const e = eyeOf({ target: [0, 0, 0], yaw, pitch: 0.3, distance: 10, fovY: 0.9 } as never);
      expect(eyeAzimuth(yaw)).toBeCloseTo(azOf(e), 9);
    }
    // L3 opens with the eye at azimuth 0, B2's classic view at 144 (the sun 4 degrees off straight behind it before
    // PT15; the goals view, PT1, opens B2 from another side).
    expect(eyeAzimuth(viewOf(compileLevel(L3), 1.6).yaw)).toBeCloseTo(0, 9);
    expect(eyeAzimuth(viewOf(compileLevel(levelById('B2')), 1.6, undefined, undefined, undefined, { mode: 'classic' }).yaw)).toBeCloseTo(144, 9);
  });

  it('turns the real look\'s sun so its azimuth counts from the eye, keeping the elevation; L3 bit for bit', () => {
    const real = realLook({ sunElevation: 35, sunAzimuth: 140 });
    for (const yaw of [-Math.PI, -1, 0.2, (36 * Math.PI) / 180, 2.5]) {
      const t = sunForView(real, yaw);
      expect(t.sunDir![1]).toBe(real.sunDir![1]);
      expect(Math.hypot(...t.sunDir!)).toBeCloseTo(1, 12);
      const rel = ((azOf(t.sunDir!) - eyeAzimuth(yaw)) % 360 + 360) % 360;
      expect(rel).toBeCloseTo(140, 9);
      expect({ ...t, sunDir: undefined }).toEqual({ ...real, sunDir: undefined });
    }
    // The eye at azimuth 0 (L2, L3): the very same sun.
    expect(sunForView(real, -Math.PI).sunDir).toEqual(real.sunDir);
    expect(sunForView(real, -Math.PI).sunDir).toEqual(sunFrom(35, 140));
  });

  it('leaves the stylized looks (no atmosphere) as they are', () => {
    for (const name of ['candy', 'hazy']) expect(sunForView(LOOKS[name]!, 1)).toBe(LOOKS[name]);
  });

  it('ViewSun: one look object per change; a look set from outside becomes the base; mode look keeps it', () => {
    const r: { look: LookParams } = { look: realLook() };
    const base = r.look, vs = new ViewSun();
    vs.yaw = 0.6;
    vs.update(r, 'view');
    const turned = r.look;
    expect(turned).not.toBe(base);
    expect(azOf(turned.sunDir!)).toBeCloseTo((140 + eyeAzimuth(0.6)) % 360, 9);
    vs.update(r, 'view');
    expect(r.look).toBe(turned);
    vs.update(r, 'look');
    expect(r.look).toBe(base);
    vs.update(r, 'view');
    expect(r.look.sunDir).toEqual(turned.sunDir);
    // The front door sets another look: it is turned in its place, never the old base.
    const other = realLook({ sunAzimuth: 200 });
    r.look = other;
    vs.update(r, 'view');
    expect(azOf(r.look.sunDir!)).toBeCloseTo((200 + eyeAzimuth(0.6)) % 360, 9);
    // A new level's view.
    vs.yaw = -Math.PI;
    vs.update(r, 'view');
    expect(r.look.sunDir).toEqual(other.sunDir);
  });
});

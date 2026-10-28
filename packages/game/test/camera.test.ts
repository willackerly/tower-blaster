// The game's camera (play.ts viewOf, orbitDrag): framed over each level with the viewer's floor, so dragging up past
// level looks up (the eye slides in along its line and stays EYE_ABOVE_GROUND over the ground, y 0).
import { describe, expect, it } from 'vitest';
import { compileLevel, LEVELS } from '@tb/keystone';
import { EYE_ABOVE_GROUND, eyeOf, MAX_PITCH, type Orbit } from '@tb/render/camera';
import { orbitDrag, viewOf } from '../src/play.ts';

describe('game camera', () => {
  it.each(LEVELS.map((l) => [l.id, l] as const))('%s: opens looking down with the floor set; dragging up looks up from above the ground, and back', (_, def) => {
    const o = viewOf(compileLevel(def));
    expect(o.floor).toBe(EYE_ABOVE_GROUND);
    expect(o.pitch).toBeGreaterThan(0);
    const start: Orbit = { ...o, target: [...o.target] };
    // Pointer up the screen is dy < 0: tilt up, in small steps as a drag sends them.
    let prevUp = -Infinity;
    for (let i = 0; i < 120; i++) {
      orbitDrag(o, 0, -10);
      const e = eyeOf(o);
      expect(e[1]).toBeGreaterThanOrEqual(EYE_ABOVE_GROUND - 1e-9);
      const up = (o.target[1] - e[1]) / Math.hypot(o.target[0] - e[0], o.target[2] - e[2]); // tan of the view's elevation
      expect(up).toBeGreaterThanOrEqual(prevUp - 1e-9);
      prevUp = up;
    }
    expect(o.pitch).toBe(-MAX_PITCH);
    expect(prevUp).toBeGreaterThan(0); // looking up
    // Dragging back down restores the opening view (the floor never changed the set distance).
    orbitDrag(o, 0, (start.pitch + MAX_PITCH) / 0.005);
    expect(o.pitch).toBeCloseTo(start.pitch, 12);
    expect(o.distance).toBe(start.distance);
    eyeOf(o).forEach((x, k) => expect(x).toBeCloseTo(eyeOf(start)[k]!, 9));
  });

  it('a sideways drag turns about the target', () => {
    const o = viewOf(compileLevel(LEVELS[0]!)), yaw = o.yaw;
    orbitDrag(o, 100, 0);
    expect(o.yaw).toBeCloseTo(yaw - 0.5, 12);
  });
});

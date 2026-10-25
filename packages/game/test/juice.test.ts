import { describe, expect, it } from 'vitest';
import { CameraJuice, contactJuice, PUNCH_MAX, SHAKE_PITCH, SHAKE_YAW, TRAUMA_DECAY, wobble } from '../src/juice.ts';

describe('camera juice', () => {
  it('is still with no trauma and no punch', () => {
    const j = new CameraJuice();
    for (let i = 0; i < 10; i++) expect(j.update(1 / 60)).toEqual({ yaw: 0, pitch: 0, fovScale: 1 });
  });
  it('shake is bounded by trauma squared and decays to zero linearly', () => {
    const j = new CameraJuice();
    j.shake(0.5); j.shake(0.8);
    expect(j.trauma).toBe(1);
    let maxYaw = 0;
    for (let i = 0; i < 30; i++) {
      const before = j.trauma, o = j.update(1 / 60);
      expect(Math.abs(o.yaw)).toBeLessThanOrEqual(SHAKE_YAW * before * before + 1e-12);
      expect(Math.abs(o.pitch)).toBeLessThanOrEqual(SHAKE_PITCH * before * before + 1e-12);
      maxYaw = Math.max(maxYaw, Math.abs(o.yaw));
    }
    expect(maxYaw).toBeGreaterThan(0.2 * SHAKE_YAW);
    for (let i = 0; i < Math.ceil(60 / TRAUMA_DECAY); i++) j.update(1 / 60);
    expect(j.trauma).toBe(0);
    expect(j.update(1 / 60).yaw).toBe(0);
  });
  it('the FOV punch is capped, narrows the view, then relaxes', () => {
    const j = new CameraJuice();
    j.kick(1);
    expect(j.punch).toBe(PUNCH_MAX);
    const a = j.update(1 / 60).fovScale;
    expect(a).toBeLessThan(1);
    expect(a).toBeGreaterThan(1 - PUNCH_MAX);
    for (let i = 0; i < 120; i++) j.update(1 / 60);
    expect(j.update(1 / 60).fovScale).toBe(1);
  });
  it('wobble is deterministic and stays in [-1, 1]', () => {
    for (let i = 0; i < 1000; i++) {
      const t = i * 0.0137;
      expect(Math.abs(wobble(t, 1))).toBeLessThanOrEqual(1);
      expect(wobble(t, 1)).toBe(wobble(t, 1));
    }
  });
  it('contact juice grows with impulse within bounds', () => {
    expect(contactJuice(0)).toEqual({ frames: 0, trauma: 0 });
    const xs = [5, 50, 200, 1000, 10000].map(contactJuice);
    for (let i = 1; i < xs.length; i++) {
      expect(xs[i]!.frames).toBeGreaterThanOrEqual(xs[i - 1]!.frames);
      expect(xs[i]!.trauma).toBeGreaterThanOrEqual(xs[i - 1]!.trauma);
    }
    expect(xs.every((x) => x.frames >= 2 && x.frames <= 6 && x.trauma <= 0.7)).toBe(true);
  });
});

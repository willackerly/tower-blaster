// The ground's motion under a quake (quake-ground.ts, PT25): the side load the engine gets, integrated twice and
// turned around (the ground moves against the load its towers feel), along the quake's axis only, at rest at home
// at both ends, and about A g / (2 pi f)^2 at its peak for a quake long enough to reach full strength.
import { describe, expect, it } from 'vitest';
import { type FieldEvent, joltEvent, tiltEvent } from '@tb/engine-api';
import { A1, compileLevel, quakeCandidate, quakeInputs, type QuakeShot } from '@tb/keystone';
import { dustBeats, fieldQuake, groundAt, groundMotion, groundMotionOf, groundPeak } from '../src/quake-ground.ts';
import { seismogram } from '../src/quake-panel.ts';

const q = (peak: number, hz: number, sec: number, axis = 0): QuakeShot => ({ ammo: 'quake', peak, hz, sec, axis });
const c = compileLevel(quakeCandidate('QC-4'));

describe('the ground\'s motion under a quake', () => {
  it('starts and ends at home, one sample a step, zero outside the quake', () => {
    const m = groundMotion(c, q(30, 10, 30));
    expect(m.steps).toBe(Math.round(3 / c.scene.dt));
    expect(m.x).toHaveLength(m.steps + 1);
    expect([m.x[0], m.x[m.steps], m.z[0], m.z[m.steps]]).toEqual([0, 0, 0, 0]);
    expect(groundAt(m, -1)).toEqual([0, 0]);
    expect(groundAt(m, m.steps + 5)).toEqual([0, 0]);
    const [x0, , x1] = [m.x[100]!, 0, m.x[101]!];
    expect(groundAt(m, 100.5)[0]).toBeCloseTo((x0 + x1) / 2, 12);
  });

  it('moves along the axis only, and against the side load the towers feel', () => {
    const along = groundMotion(c, q(30, 10, 30, 0)), across = groundMotion(c, q(30, 10, 30, 90));
    expect(Math.max(...along.z.map(Math.abs))).toBeLessThan(1e-12);
    expect(Math.max(...across.x.map(Math.abs))).toBeLessThan(1e-9);
    expect(groundPeak(across)).toBeCloseTo(groundPeak(along), 9);
    // Early on the load pushes the towers toward +x (the seismogram rises first), so the ground is moving toward -x.
    const trace = seismogram(c, q(30, 10, 30), 200);
    expect(trace.slice(1, 20).every((v) => v >= 0)).toBe(true);
    expect(along.x[Math.round(0.2 / c.scene.dt)]!).toBeLessThan(0);
  });

  it('peaks near A g / (2 pi f)^2: about 7 cm for 0.3 g at 1 Hz, a ninth of that at 3 Hz', () => {
    const g = Math.hypot(...c.scene.gravity), expected = (hz: number, peak: number) => (peak * g) / (2 * Math.PI * hz) ** 2;
    const one = groundPeak(groundMotion(c, q(30, 10, 60)));
    expect(one / expected(1, 0.3)).toBeGreaterThan(0.7);
    expect(one / expected(1, 0.3)).toBeLessThan(1.6);
    expect(one).toBeGreaterThan(0.05);
    const three = groundPeak(groundMotion(c, q(30, 30, 60)));
    expect(three / one).toBeGreaterThan(0.05);
    expect(three / one).toBeLessThan(0.2);
  });

  it('is the level\'s own quake on a shipped level (A1\'s ace moves the ground)', () => {
    const a = compileLevel(A1), ace = A1.solutions!.ace![0] as QuakeShot;
    expect(groundPeak(groundMotion(a, ace))).toBeGreaterThan(0.02);
  });

  it('raises dust on each swing\'s strongest push: twice a cycle, none outside the quake or under a whisper', () => {
    const m = groundMotion(c, q(30, 10, 30)), all = dustBeats(m, -10, m.steps + 10);
    // 1 Hz for 3 s: two pushes a cycle, less the ramp's first and last weak ones.
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeLessThanOrEqual(6);
    for (const s of all) expect(m.load[s]!).toBeGreaterThanOrEqual(0.05);
    expect(Math.max(...all.map((s) => m.load[s]!))).toBeCloseTo(0.3, 1);
    // Split at any frame, the beats are the same: none lost or doubled.
    const mid = all[1]! + 0.4;
    expect([...dustBeats(m, -10, mid), ...dustBeats(m, mid, m.steps + 10)]).toEqual(all);
    expect(dustBeats(groundMotion(c, q(3, 10, 30)), -10, 1e9)).toEqual([]);
  });
});

describe('a quake pushed with no shot (a Mason test\'s world 0: field events only)', () => {
  const g = c.scene.gravity, at = 300, others: FieldEvent[] = [];
  it('is found among the pushed events, its axis read off the keys, and draws as the same quake shot would', () => {
    for (const axis of [0, 90]) {
      const shot = q(30, 10, 10, axis), keys = quakeInputs(c, shot, at), f = fieldQuake(g, [...others, ...keys])!;
      expect(f.axis).toBe(axis);
      expect(f.step).toBe(keys[0]!.step);
      expect(f.step - at).toBeLessThanOrEqual(1);
      // From the same origin the field quake's motion is the shot's, sample for sample.
      const m = groundMotionOf(g, c.scene.dt, f.keys, at), s = groundMotion(c, shot);
      expect(m.steps).toBe(s.steps);
      expect([...m.x, ...m.z]).toEqual([...s.x, ...s.z]);
    }
  });

  it('a tilt, a jolt or nothing is no quake (the ground would drift away under a tilt)', () => {
    expect(fieldQuake(g, [])).toBeNull();
    expect(fieldQuake(g, [tiltEvent(at, 10, g)])).toBeNull();
    expect(fieldQuake(g, [joltEvent(at, [1, 0, 0])])).toBeNull();
    expect(fieldQuake(g, [tiltEvent(at, 10, g), tiltEvent(at + 60, 0, g), tiltEvent(at + 120, 5, g)])).toBeNull();
  });
});

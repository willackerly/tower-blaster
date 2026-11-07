// The ground's motion under a quake (quake-ground.ts, PT25): the side load the engine gets, integrated twice and
// turned around (the ground moves against the load its towers feel), along the quake's axis only, at rest at home
// at both ends, and about A g / (2 pi f)^2 at its peak for a quake long enough to reach full strength.
import { describe, expect, it } from 'vitest';
import { A1, compileLevel, quakeCandidate, type QuakeShot } from '@tb/keystone';
import { groundAt, groundMotion, groundPeak } from '../src/quake-ground.ts';
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
});

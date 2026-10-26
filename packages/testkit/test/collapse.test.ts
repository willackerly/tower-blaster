// The rigid-column model behind the S13 tests, checked against independent
// derivations: the small-angle closed forms and a direct ODE integration
// through the Housner impact.
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { bendOf, leanDeg, readColumn, rodRock, rodToppleTime, tippingAngle } from '../src/index.ts';

const G = 9.81, DEG = Math.PI / 180;
const model = (H: number) => {
  const R = Math.hypot(1, H) / 2, alpha = Math.atan(1 / H), I0 = (1 + H * H) / 3;
  return { alpha, p: Math.sqrt((G * R) / I0), r: 1 - 1.5 * Math.sin(alpha) ** 2 };
};

describe('rigid column model (S13)', () => {
  it('tips at atan(W / H)', () => {
    expect(tippingAngle(20)).toBeCloseTo(2.8624, 4);
    expect(tippingAngle(1)).toBeCloseTo(45, 10);
  });

  it('topple time: converged in its step, and phi0 cosh(p t) for small phi = theta - alpha', () => {
    const { alpha, p } = model(20);
    expect(Math.abs(rodToppleTime(20, 4, 30) - rodToppleTime(20, 4, 30, 1, 5e-5))).toBeLessThan(1e-6);
    // phi from 1e-3 to 1e-2 deg: sin(phi) = phi to 1e-11, so t = acosh(10) / p.
    const a = alpha / DEG;
    expect(rodToppleTime(20, a + 1e-3, a + 1e-2) * p).toBeCloseTo(Math.acosh(10), 4);
    expect(() => rodToppleTime(20, 2, 30)).toThrow(/below the tipping angle/);
  });

  it('rocking: time to upright and far-side lean agree with a direct integration through the impact', () => {
    const { alpha, p, r } = model(20);
    const th0 = 2 * DEG;
    const rock = rodRock(20, 2);
    // Small-angle closed form: phi = phi0 cosh(p t) reaches -alpha at acosh(alpha / (alpha - theta0)) / p.
    expect(rock.upright * p).toBeCloseTo(Math.acosh(alpha / (alpha - th0)), 3);
    // Direct: RK4 on theta'' = p^2 sin(theta - alpha) on the first corner; at theta = 0
    // the angular velocity is scaled by r and the pivot moves to the other corner,
    // theta'' = -p^2 sin(-theta - alpha); the far-side extreme is where it stops.
    // The pivot switches at the landing only: switching on the sign of theta inside
    // an RK4 stage would kick the landing speed.
    let f = (x: number) => p * p * Math.sin(x - alpha);
    const rk4 = (x: number, v: number, h: number): [number, number] => {
      const k1x = v, k1v = f(x), k2x = v + (h / 2) * k1v, k2v = f(x + (h / 2) * k1x);
      const k3x = v + (h / 2) * k2v, k3v = f(x + (h / 2) * k2x), k4x = v + h * k3v, k4v = f(x + h * k3x);
      return [x + (h / 6) * (k1x + 2 * k2x + 2 * k3x + k4x), v + (h / 6) * (k1v + 2 * k2v + 2 * k3v + k4v)];
    };
    let th = th0, om = 0, t = 0, upright = 0;
    const h = 1e-3;
    for (;;) {
      const [nth, nom] = rk4(th, om, h);
      if (nth >= 0) { th = nth; om = nom; t += h; continue; }
      // Land on the step's fraction that reaches theta = 0 (Newton on the step length):
      // the far-side lean is sensitive to the landing speed, since the potential is flat there.
      let hs = (h * th) / (th - nth);
      for (let i = 0; i < 4; i++) { const [x, v] = rk4(th, om, hs); hs -= x / v; }
      upright = t + hs;
      om = rk4(th, om, hs)[1] * r; th = 0;
      f = (x: number) => -p * p * Math.sin(-x - alpha);
      break;
    }
    for (;;) {
      const [nth, nom] = rk4(th, om, h);
      if (nom >= 0) break;
      th = nth; om = nom;
    }
    expect(upright).toBeCloseTo(rock.upright, 4);
    expect(-th / DEG).toBeCloseTo(rock.farSide, 4);
    // Slender: the impact keeps r^2 = 99.3% of the energy, so the far side leans 1.968 deg, not 2.
    expect(rock.farSide).toBeCloseTo(1.968, 3);
    expect(() => rodRock(20, 3)).toThrow(/must be inside/);
  });

  it('leanDeg and bendOf read S13 as built: the lean it was built with, no bend', () => {
    for (const [H, deg] of [[20, 4], [30, 3], [6, 2]] as const) {
      const pos = buildScenario('S13', { H, deg }, 1).bodies.flatMap((b) => b.pos);
      expect(leanDeg(pos, H)).toBeCloseTo(deg, 4);
      expect(bendOf(pos, H)).toBeLessThan(1e-4);
    }
  });
});

describe('readColumn', () => {
  // A column that leans by a(t) as a rigid line: cube k at (k sin a, k cos a).
  const line = (deg: number, H: number) => Array.from({ length: H }, (_, k) => [k * Math.sin(deg * DEG), k * Math.cos(deg * DEG), 0]).flat();
  it('interpolates the topple and upright times, and reads the far side and its turn', () => {
    const H = 5, lean = (t: number) => 2 * Math.cos(t); // 2 deg, upright at pi/2, far side -2 at pi
    const samples = Array.from({ length: 41 }, (_, i) => ({ t: i * 0.1, pos: line(lean(i * 0.1), H) }));
    const r = readColumn(samples, H, 30);
    expect(r.topple).toBeNull();
    expect(r.upright!).toBeCloseTo(Math.PI / 2, 2);
    expect(r.before).toBeCloseTo(2, 10);
    expect(r.farSide).toBeCloseTo(2, 2);
    expect(r.turned).toBe(true);
    // Cut before the far-side extreme: not turned.
    expect(readColumn(samples.slice(0, 25), H).turned).toBe(false);
    // A pause near the far-side extreme (loose cubes wiggle there) is not the turn.
    const wiggle = [0, 1, 1.79, 1.7898, 1.8, 1.86, 1.866, 1.85, 1.6].map((d, i) => ({ t: i, pos: line(d === 0 ? 0.5 : -d, H) }));
    const w = readColumn(wiggle, H);
    expect(w.farSide).toBeCloseTo(1.866, 10);
    expect(w.turned).toBe(true);
    expect(readColumn(wiggle.slice(0, 8), H).turned).toBe(false); // 1.85 is within turnDeg of 1.866
    const falls = Array.from({ length: 11 }, (_, i) => ({ t: i, pos: line(4 * i, H) }));
    const f = readColumn(falls, H, 30);
    expect(f.topple).toBeCloseTo(7.5, 10);
    expect(f.upright).toBeNull();
    expect(f.bend).toBeLessThan(1e-12);
  });
});

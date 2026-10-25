import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodiesAt, type BodyDesc, massOf, TAG_BALL } from '@tb/engine-api';
import { boundingRadius, groundDepth, shapeDepth, spherePairs } from '@tb/geom';
import { buildScenario, rng, SCENARIOS } from '../src/index.ts';

/** Small versions of every scenario, fast enough to check exhaustively. */
const SMALL: Record<string, Record<string, number | boolean>> = {
  S1: { F: 4, H: 12 }, S2: { C: 12, depth: 2 }, S3: { W: 12, H: 6, running: true }, S4: { N: 900, F: 4, H: 10 },
  S5: { N: 900, F: 4, H: 10 }, S6: { N: 600 }, S7: { N: 600 }, S8: { floors: 5, bays: 2 }, S9: { H: 6 },
  S10: { F: 3, H: 5 }, S11: { N: 200 },
};

function maxPenetration(bodies: BodyDesc[], groundY: number | null): number {
  const c = bodies.flatMap((b) => b.pos);
  const r = bodies.map((b) => boundingRadius(b.shape));
  let worst = 0;
  for (const [i, j] of spherePairs(c, r)) {
    const a = bodies[i]!, b = bodies[j]!;
    worst = Math.max(worst, shapeDepth(a.shape, a.pos, a.rot, b.shape, b.pos, b.rot));
  }
  if (groundY !== null) for (const b of bodies) worst = Math.max(worst, groundDepth(b.shape, b.pos, b.rot, groundY));
  return worst;
}

describe.each(Object.keys(SCENARIOS))('%s', (id) => {
  const scene = buildScenario(id, SMALL[id], 7);
  // Include bodies spawned by inputs, at their spawn time.
  const all = bodiesAt(scene, Infinity);

  it('starts with no interpenetration (touching allowed)', () => {
    expect(maxPenetration(all, scene.ground?.y ?? null)).toBeLessThan(1e-9);
  });

  it('is deterministic for a seed and serialisable', () => {
    expect(buildScenario(id, SMALL[id], 7)).toEqual(scene);
    expect(JSON.parse(JSON.stringify(scene))).toEqual(scene);
  });

  it('has unit quaternions, positive mass and finite state', () => {
    for (const b of all) {
      expect(Math.abs(Math.hypot(...b.rot) - 1)).toBeLessThan(1e-12);
      expect(massOf(b)).toBeGreaterThan(0);
      for (const v of [...b.pos, ...b.linVel, ...b.angVel]) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it('has defaults that build and records the params it used', () => {
    const def = SCENARIOS[id]!;
    expect(buildScenario(id).params).toEqual(def.defaults);
    expect(scene.params).toEqual({ ...def.defaults, ...SMALL[id] });
  });
});

describe('scenario specifics', () => {
  it('the overlap checker itself catches overlaps (negative gap)', () => {
    const s = buildScenario('S1', { F: 3, H: 2, gap: -0.05 });
    expect(maxPenetration(s.bodies, 0)).toBeCloseTo(0.05, 9);
  });

  it('S1 has exactly F*F*H cubes stacked to height H, for any size and gap', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 6 }), fc.integer({ min: 1, max: 20 }), fc.double({ min: 0, max: 0.5, noNaN: true }), (F, H, gap) => {
      const s = buildScenario('S1', { F, H, gap });
      expect(s.bodies.length).toBe(F * F * H);
      expect(Math.max(...s.bodies.map((b) => b.pos[1]))).toBeCloseTo(H - 0.5, 12);
    }));
  });

  it('S2 is a triangle of C(C+1)/2 cubes per depth layer', () => {
    expect(buildScenario('S2', { C: 69, depth: 1 }).bodies.length).toBe((69 * 70) / 2);
  });

  it('S4 and S5 build exactly N cubes, spread over towers', () => {
    const s4 = buildScenario('S4', { N: 10000 });
    expect(s4.bodies.length).toBe(10000);
    expect(new Set(s4.bodies.map((b) => b.tag)).size).toBe(Math.ceil(10000 / 1600));
    const s5 = buildScenario('S5', { N: 3000, massRatio: 50 });
    expect(s5.bodies.length).toBe(3000);
    const ball = s5.inputs[0]!.body;
    expect(ball.tag).toBe(TAG_BALL);
    expect(massOf(ball)).toBeCloseTo(50, 9);
    expect(ball.linVel[0]).toBeGreaterThan(0);
  });

  it('S6 differs between seeds; S7 disables sleep', () => {
    expect(buildScenario('S6', { N: 50 }, 1)).not.toEqual(buildScenario('S6', { N: 50 }, 2));
    expect(buildScenario('S7', { N: 50 }).sleep).toBe(false);
  });

  it('S10 is S1 translated', () => {
    const a = buildScenario('S1', { F: 3, H: 4 }), b = buildScenario('S10', { F: 3, H: 4, offset: 5000 });
    expect(b.bodies.map((x) => [x.pos[0] - 5000, x.pos[1], x.pos[2] - 5000])).toEqual(a.bodies.map((x) => x.pos));
  });

  it('rejects unknown scenarios and params', () => {
    expect(() => buildScenario('S99')).toThrow(/unknown scenario/);
    expect(() => buildScenario('S1', { Q: 1 })).toThrow(/no param Q/);
    expect(() => buildScenario('S1', { H: 0 })).toThrow(/integer >= 1/);
  });

  it('rng is uniform enough and reproducible', () => {
    const r = rng(42), xs = Array.from({ length: 20000 }, r);
    expect(rng(42)()).toBe(xs[0]);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.01);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
  });
});

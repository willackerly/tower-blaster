import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { bodiesAt, type BodyDesc, massOf, TAG_BALL, type SpawnEvent } from '@tb/engine-api';
import { boundingRadius, groundDepth, shapeDepth, spherePairs } from '@tb/geom';
import { bounceScene, buildScenario, rng, SCENARIOS } from '../src/index.ts';

/** Small versions of every scenario, fast enough to check exhaustively. */
const SMALL: Record<string, Record<string, number | boolean>> = {
  S1: { F: 4, H: 12 }, S2: { C: 12, depth: 2 }, S3: { W: 12, H: 6, running: true }, S4: { N: 900, F: 4, H: 10 },
  S5: { N: 900, F: 4, H: 10 }, S6: { N: 600 }, S7: { N: 600 }, S8: { floors: 5, bays: 2 }, S9: { H: 6 },
  S10: { F: 3, H: 5 }, S11: { N: 200 }, S12: { W: 9, H: 7, holeW: 3, holeH: 2, holeY: 1, running: true }, S13: { H: 6, deg: 4 },
  S14: { towers: 5, W: 3, D: 2, H: 6, street: 1.5, vary: 0.5 },
  S15: { planks: 800, toppleHeight: 0.5 },
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
    const ball = (s5.inputs[0] as SpawnEvent).body;
    expect(ball.tag).toBe(TAG_BALL);
    expect(massOf(ball)).toBeCloseTo(50, 9);
    expect(ball.linVel[0]).toBeGreaterThan(0);
  });

  it('S6 differs between seeds; S7 disables sleep', () => {
    expect(buildScenario('S6', { N: 50 }, 1)).not.toEqual(buildScenario('S6', { N: 50 }, 2));
    expect(buildScenario('S7', { N: 50 }).sleep).toBe(false);
  });

  it('S13 at 0 deg is an upright column that survives JSON (no -0 in its rotation)', () => {
    const s = buildScenario('S13', { H: 3, deg: 0 });
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
    expect(s.bodies.map((b) => b.pos)).toEqual([0, 1, 2].map((k) => [0, 0.5 + k + 1e-6 * (k + 1), 0]));
  });

  it('S10 is S1 translated', () => {
    const a = buildScenario('S1', { F: 3, H: 4 }), b = buildScenario('S10', { F: 3, H: 4, offset: 5000 });
    expect(b.bodies.map((x) => [x.pos[0] - 5000, x.pos[1], x.pos[2] - 5000])).toEqual(a.bodies.map((x) => x.pos));
  });

  it('S14 builds towers W x D x H cubes, one tag per tower, on a grid with street between footprints', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 5 }), fc.integer({ min: 1, max: 8 }), fc.double({ min: 0, max: 6, noNaN: true }), (towers, W, D, H, street) => {
      const s = buildScenario('S14', { towers, W, D, H, street });
      expect(s.bodies.length).toBe(towers * W * D * H);
      for (let t = 0; t < towers; t++) {
        const mine = s.bodies.filter((b) => b.tag === t);
        expect(mine.length).toBe(W * D * H);
        const span = (k: 0 | 1 | 2) => Math.max(...mine.map((b) => b.pos[k])) - Math.min(...mine.map((b) => b.pos[k])) + 1;
        [W, H, D].forEach((n, k) => expect(span(k as 0 | 1 | 2)).toBeCloseTo(n, 9));
      }
      // Neighbouring footprints (towers 0 and 1, when there are two) are street apart.
      if (towers > 1) {
        const edge = (t: number, f: (...x: number[]) => number) => f(...s.bodies.filter((b) => b.tag === t).map((b) => b.pos[0]));
        expect(edge(1, Math.min) - 0.5 - (edge(0, Math.max) + 0.5)).toBeCloseTo(street, 9);
      }
    }), { numRuns: 60 });
  });

  it('S14 vary spreads tower heights over [H (1 - vary), H] from the seed, and vary 0 ignores the seed', () => {
    const heights = (s: ReturnType<typeof buildScenario>) => Array.from({ length: 64 }, (_, t) => Math.max(0, ...s.bodies.filter((b) => b.tag === t).map((b) => b.pos[1] + 0.5)));
    const a = heights(buildScenario('S14', { towers: 64, W: 1, D: 1, H: 20, vary: 0.5 }, 3));
    expect(Math.min(...a)).toBeGreaterThanOrEqual(10);
    expect(Math.max(...a)).toBeLessThanOrEqual(20);
    expect(new Set(a).size).toBeGreaterThan(5);
    expect(heights(buildScenario('S14', { towers: 64, W: 1, D: 1, H: 20, vary: 0.5 }, 4))).not.toEqual(a);
    expect(buildScenario('S14', { vary: 0 }, 3).bodies).toEqual(buildScenario('S14', { vary: 0 }, 4).bodies);
    expect(() => buildScenario('S14', { vary: 1.5 })).toThrow(/vary/);
    expect(() => buildScenario('S14', { street: -1 })).toThrow(/street/);
    expect(() => buildScenario('S14', { towers: 0 })).toThrow(/integer >= 1/);
  });

  it('S1-S13 at their defaults are bit-identical to the scenes the benchmarks were run on', () => {
    // sha256 of the JSON scene, first 16 hex digits, pinned at 64c2969. A change here moves every
    // bench result for that scenario: change a scene on purpose only, and re-pin.
    const pinned: Record<string, string> = {
      S1: '60732b579cf034e4', S2: '494fa8c06737698c', S3: '0ea52a71d7ab9cf3', S4: '277a82fd43480d47', S5: 'e86af49fed32bbab',
      S6: 'bb13b94d5930abca', S7: '2a9896a199c8fc7a', S8: '13bf80840eb78c21', S9: '26ff7b459d845528', S10: 'cb706858f237ca78',
      S11: '5db510a720529485', S12: '475f0020ea675dd5', S13: '83d18c1ef34def89',
    };
    const hash = (id: string) => createHash('sha256').update(JSON.stringify(buildScenario(id))).digest('hex').slice(0, 16);
    expect(Object.fromEntries(Object.keys(pinned).map((id) => [id, hash(id)]))).toEqual(pinned);
  });

  it('bounceScene puts every body, every spawn and the ground at e, changes nothing else and leaves its argument alone', () => {
    // S5 fires a ball (a spawn input). The scenarios' own bodies have restitution 0, and their ground none.
    const plain = buildScenario('S5', SMALL.S5), before = structuredClone(plain);
    expect(plain.inputs.length).toBeGreaterThan(0);
    expect(plain.bodies.every((b) => b.restitution === 0) && plain.ground!.restitution === undefined).toBe(true);
    const on = bounceScene(plain, 0.6);
    expect(plain).toEqual(before);
    expect(on.ground).toEqual({ ...plain.ground, restitution: 0.6 });
    expect(on.bodies).toEqual(plain.bodies.map((b) => ({ ...b, restitution: 0.6 })));
    expect(on.inputs).toEqual(plain.inputs.map((ev) => (ev.kind === 'spawn' ? { ...ev, body: { ...ev.body, restitution: 0.6 } } : ev)));
    expect({ ...on, bodies: [], inputs: [], ground: null }).toEqual({ ...plain, bodies: [], inputs: [], ground: null });
    // e 0 is a value like any other, and a scene without a ground keeps none.
    expect(bounceScene(on, 0).bodies.every((b) => b.restitution === 0)).toBe(true);
    expect(bounceScene({ ...plain, ground: null }, 0.6).ground).toBeNull();
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

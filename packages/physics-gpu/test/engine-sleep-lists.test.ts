// Sleep's awake lists (SolverDispatch.awakeLists; roadmap E2 step 3b-2): with sleep, each iteration's dual updates run
// over the pair slots not both asleep and the bodies not asleep, listed once a step. Exact: each run here is compared
// step by step, bit for bit, with the same run at awakeLists false (every slot and body), and the lists are checked
// against what they must hold.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { call, cube, gpu, sceneOf } from './harness.ts';
import type { PlainSnapshot } from './page.ts';
import { asleep, at, run, SLEEP, sleepy } from './sleep-case.ts';

const state = (s: PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel, s.awake, s.tier];

async function same(scene: SceneDesc, steps: number, params: Record<string, number> = { iterations: 8 }) {
  const lists = await run(scene, steps, SLEEP, 1, params), all = await run(scene, steps, { ...SLEEP, awakeLists: false }, 1, params);
  expect(lists.snaps.length).toBe(all.snaps.length);
  lists.snaps.forEach((s, k) => expect(state(s), `step ${s.step}`).toEqual(state(all.snaps[k]!)));
  return lists;
}

const city = () => buildScenario('S14', { towers: 2, W: 2, D: 2, H: 3, street: 3 }, 1);
const blasted = () => {
  const c = city(), p0 = c.bodies[0]!.pos;
  return sleepy(c, [{ step: 70, kind: 'blast', blast: { centre: [p0[0] - 0.6, 0.5, p0[2]], radius: 1.2, impulse: 2 } }]);
};
// A cube that falls asleep beside one gliding on frictionless ground, which never sleeps (engine-sleep.test.ts).
const glide = (): SceneDesc => ({ ...sleepy(sceneOf([cube([0, 0.5, 0]), { ...cube([5, 0.5, 0], [0.04, 0, 0]), friction: 0 }])), ground: { y: 0, friction: 0 } });

describe('GPU sleep: dual updates over the awake lists', () => {
  it('a city that sleeps and is half woken by a blast runs as without the lists', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await same(blasted(), 110);
    const n = city().bodies.length;
    // Asleep before the blast, part of it awake after: the lists held part of the scene.
    expect(asleep(at(r.snaps, 69))).toBe(n);
    const after = asleep(at(r.snaps, 75));
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(n);
  });

  it('with records 0 (points) and 2 (centre friction) and the loaded-gap slop, a woken tower runs as without the lists', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(sceneOf([cube([0, 0.5, 0]), cube([0, 1.5, 0]), cube([3, 0.5, 0]), cube([3, 1.5, 0])]), [
      { step: 50, kind: 'blast', blast: { centre: [-0.8, 1, 0], radius: 1, impulse: 1.5 } },
    ]);
    const variants: Record<string, number>[] = [{ iterations: 8, records: 0 }, { iterations: 8, records: 2 }, { iterations: 8, gapSlop: 0.01 }];
    for (const params of variants) {
      const r = await same(scene, 90, params);
      expect(asleep(at(r.snaps, 49)), JSON.stringify(params)).toBe(4);
      expect(asleep(at(r.snaps, 55)), JSON.stringify(params)).toBeLessThan(4);
    }
  });

  it('lists the bodies not asleep and the pair slots not both asleep, and nothing without sleep', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const params = { iterations: 8 };
    // The cube asleep, the glider awake and touching nothing but the ground.
    const g = await call('awakeLists', glide(), 120, params, SLEEP);
    expect(g.error).toBeNull();
    expect(g.lists).toEqual({ pairs: [], slots: 0, bodies: [1], args: [0, 1, 1, 1, 1, 1] });
    // Half woken by the blast: fewer slots than the broadphase found, fewer bodies than the city.
    const n = city().bodies.length;
    const c = await call('awakeLists', blasted(), 75, params, SLEEP);
    expect(c.error).toBeNull();
    const { pairs, slots, bodies, args } = c.lists!;
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.length).toBeLessThan(slots);
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies.length).toBeLessThan(n);
    expect(new Set(pairs).size).toBe(pairs.length);
    expect(Math.max(...pairs)).toBeLessThan(slots);
    expect(args).toEqual([Math.ceil(pairs.length / 64), 1, 1, Math.ceil(bodies.length / 64), 1, 1]);
    // No lists without sleep, with them turned off, or in a scene that does not sleep.
    for (const [scene, opts] of [[glide(), {}], [glide(), { ...SLEEP, awakeLists: false }], [{ ...glide(), sleep: false }, SLEEP]] as const) {
      const r = await call('awakeLists', scene, 10, params, opts);
      expect(r.error).toBeNull();
      expect(r.lists).toBeNull();
    }
  });
});

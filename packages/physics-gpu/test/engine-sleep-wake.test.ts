// Per-body sleep (sleep.ts; roadmap E2), the wake rules: an awake neighbour moving faster than wakeSpeed, a contact
// deeper than wakeDepth, a lost contact, a blast, each with a fixture that fires it and one that must not; the
// backoff; and a woken stack that starts from the loads it slept with.
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { cube, gpu, sceneOf } from './harness.ts';
import type { PlainSnapshot } from './page.ts';
import { asleep, at, ball, column, run, SLEEP, sleepy, T, y } from './sleep-case.ts';

describe('GPU sleep: wake rules', () => {
  it('quiet arrivals do not wake: a cube set down at rest on a sleeping one leaves it asleep, and sleeps itself T steps later', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(sceneOf([cube([0, 0.5, 0])]), [{ step: 45, kind: 'spawn', body: cube([0, 1.5, 0]) }]);
    const r = await run(scene, 100, SLEEP);
    expect(at(r.snaps, 45).awake).toEqual([0]);
    for (const s of r.snaps) if (s.step > 45) expect(s.awake![0], `step ${s.step}`).toBe(0);
    expect(at(r.snaps, 46).awake).toEqual([0, 1]);
    const slept = r.snaps.find((s) => s.step > 45 && s.awake![1] === 0)!.step;
    expect(slept).toBeGreaterThanOrEqual(45 + T);
    expect(slept).toBeLessThanOrEqual(45 + T + 2);
    // The sleeper held still under it: it is exactly where it slept.
    expect(r.snaps.at(-1)!.pos.slice(0, 3)).toEqual(at(r.snaps, 45).pos.slice(0, 3));
  });

  it('depth: a cube spawned pressed 0.05 into a sleeping one wakes it on that step; at 0.005 (under wakeDepth) it does not', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const deep = await run(sleepy(sceneOf([cube([0, 0.5, 0])]), [{ step: 45, kind: 'spawn', body: cube([0, 1.45, 0]) }]), 50, SLEEP);
    expect(at(deep.snaps, 46).awake).toEqual([1, 1]);
    const shallow = await run(sleepy(sceneOf([cube([0, 0.5, 0])]), [{ step: 45, kind: 'spawn', body: cube([0, 1.495, 0]) }]), 50, SLEEP);
    expect(at(shallow.snaps, 46).awake![0]).toBe(0);
  });

  it('speed: a ball rolling into a sleeping column wakes all of it when it touches; the same ball set down against it at rest does not', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A 3-cube column sleeps by step 45; a ball 2 units off, sliding at 2 units/s along the frictionless ground, reaches it.
    const roll = { ...ball([-2, 0.5, 0], [0, 0, 0]), density: 2 };
    const r = await run(sleepy(sceneOf(column(3)), [{ step: 45, kind: 'spawn', body: { ...roll, linVel: [2, 0, 0] } }]), 120, SLEEP);
    expect(asleep(at(r.snaps, 45))).toBe(3);
    const woke = r.snaps.find((s) => s.step > 45 && s.awake!.slice(0, 3).some((a) => a === 1))!;
    expect(woke.awake!.slice(0, 3)).toEqual([1, 1, 1]);
    // It woke on contact, not before: the step before, the ball was within a radius, half a cube and the margins of it.
    expect(at(r.snaps, woke.step - 1).pos[9]!).toBeGreaterThan(-1.2);
    expect(r.snaps.at(-1)!.pos[0]!).toBeGreaterThan(1e-3);
    const still = await run(sleepy(sceneOf(column(3)), [{ step: 45, kind: 'spawn', body: { ...roll, pos: [-1.005, 0.5, 0] } }]), 70, SLEEP);
    for (const s of still.snaps) if (s.step >= 45) expect(s.awake!.slice(0, 3), `step ${s.step}`).toEqual([0, 0, 0]);
  });

  it('lost contact: removing the bottom of a sleeping column wakes it all on that step, and the top starts falling at once; a column apart sleeps on', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await run(sleepy(sceneOf(column(6)), [{ step: 50, kind: 'remove', id: 0 }]), 60, SLEEP);
    expect(asleep(at(r.snaps, 50))).toBe(6);
    const s51 = at(r.snaps, 51);
    expect(s51.awake).toEqual([0, 1, 1, 1, 1, 1]); // the removed body: asleep and tier free
    expect(s51.tier![0]).toBe(255);
    expect(y(s51, 5)).toBeLessThan(y(at(r.snaps, 50), 5));
    expect(y(r.snaps.at(-1)!, 5)).toBeLessThan(5.5 - 0.1);
    const q = await run(sleepy(sceneOf([...column(6), ...column(6, 3)]), [{ step: 50, kind: 'remove', id: 0 }]), 60, SLEEP);
    expect(at(q.snaps, 51).awake!.slice(6)).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('blast: wakes the tower it pushes, every sleeper of it, and no other tower', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const city = buildScenario('S14', { towers: 4, W: 2, D: 2, H: 4, street: 4 }, 1);
    // A small blast just outside the first tower's foot, reaching only that tower.
    const p0 = city.bodies[0]!.pos;
    const r = await run(sleepy(city, [{ step: 60, kind: 'blast', blast: { centre: [p0[0] - 0.6, 0.5, p0[2]], radius: 1.2, impulse: 2 } }]), 62, SLEEP);
    expect(asleep(at(r.snaps, 60))).toBe(city.bodies.length);
    const s61 = at(r.snaps, 61);
    const tower = (i: number) => city.bodies[i]!.tag;
    const woke = new Set(city.bodies.map((_, i) => i).filter((i) => s61.awake![i] === 1).map(tower));
    expect([...woke]).toEqual([tower(0)]);
    city.bodies.forEach((_, i) => { if (tower(i) === tower(0)) expect(s61.awake![i], `body ${i}`).toBe(1); });
  });

  it('backoff: a body woken once needs 2T quiet steps to sleep again', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A gentle blast wakes a sleeping cube at step 40; it settles at once, and sleeps again 2T steps later, not T.
    const scene = sleepy(sceneOf([cube([0, 0.5, 0])]), [{ step: 40, kind: 'blast', blast: { centre: [0, 0.5, -1], radius: 2, impulse: 0.02 } }]);
    const r = await run(scene, 40 + 3 * T, SLEEP);
    expect(at(r.snaps, 40).awake).toEqual([0]);
    expect(at(r.snaps, 41).awake).toEqual([1]);
    const again = r.snaps.find((s) => s.step > 41 && s.awake![0] === 0)!.step;
    // Woken in step 41 (the blast is due at index 40), quiet again from its end: 2T steps later at the earliest.
    expect(again).toBeGreaterThanOrEqual(40 + 2 * T);
    expect(again).toBeLessThan(40 + 3 * T);
  });

  it('wakes warm: a sleeping 12-high column, woken, ends within 1 mm of the never-sleeping run', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // The game's solver settings; the same gentle blast in both runs, when the sleeping column is long asleep.
    const params = { iterations: 40, gapSlop: 3e-5 };
    const blast: InputEvent = { step: 90, kind: 'blast', blast: { centre: [0, 6, -3], radius: 4, impulse: 0.02 } };
    const scene = sleepy(sceneOf(column(12)), [blast]);
    const awake = await run(scene, 150, {}, 10, params), slept = await run(scene, 150, SLEEP, 10, params);
    expect(asleep(at(slept.snaps, 90))).toBe(12);
    expect(asleep(at(slept.snaps, 100))).toBeLessThan(12);
    const top = (s: PlainSnapshot) => y(s, 11);
    expect(Math.abs(top(slept.snaps.at(-1)!) - top(awake.snaps.at(-1)!))).toBeLessThan(1e-3);
  });
});

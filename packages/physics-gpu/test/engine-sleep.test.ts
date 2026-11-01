// Per-body sleep (sleep.ts; roadmap E2), falling asleep: the sleep rule (quiet for T steps: |v| + |w| r < v_sleep
// and drift under 2% of r, every contact neighbour quiet for T / 2), and sleepers as frozen anchors. The wake rules
// are in engine-sleep-wake.test.ts.
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { call, cube, gpu, sceneOf } from './harness.ts';
import { asleep, at, ball, frictionless, run, SLEEP, sleepy, T } from './sleep-case.ts';

describe('GPU sleep: falling asleep', () => {
  it('leaves the trajectory bit-identical until the first body sleeps (a ball through a wall)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(buildScenario('S5', { N: 96, F: 2, H: 8, street: 2, fireStep: 20, radius: 0.6, speed: 15 }, 1));
    const off = await run(scene, 150, {}), on = await run(scene, 150, SLEEP);
    // snaps[k] is after step k. The first bodies fall asleep at the end of step T at the earliest; that step's poses
    // are still the same (falling asleep only zeroes the velocities), and every step before it is the same in full.
    const first = on.snaps.findIndex((s) => asleep(s) > 0);
    expect(first).toBeGreaterThanOrEqual(T);
    for (let k = 0; k < first; k++) {
      const s = on.snaps[k]!, o = off.snaps[k]!;
      expect([s.pos, s.rot, s.linVel, s.angVel], `step ${s.step}`).toEqual([o.pos, o.rot, o.linVel, o.angVel]);
    }
    expect([on.snaps[first]!.pos, on.snaps[first]!.rot]).toEqual([off.snaps[first]!.pos, off.snaps[first]!.rot]);
    // And the sleepers then stop: velocities exactly 0.
    const s = on.snaps[first]!;
    s.awake!.forEach((a, i) => { if (!a) expect([...s.linVel.slice(3 * i, 3 * i + 3), ...s.angVel.slice(3 * i, 3 * i + 3)]).toEqual([0, 0, 0, 0, 0, 0]); });
  });

  it('a resting city sleeps whole by 1 s, none before T, and then stays exactly where it slept, at rest', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sleepy(buildScenario('S14', { towers: 4, W: 3, D: 3, H: 6, street: 4 }, 1));
    const r = await run(scene, 120, SLEEP);
    const n = scene.bodies.length;
    for (const s of r.snaps) if (s.step < T) expect(asleep(s), `step ${s.step}`).toBe(0);
    const s60 = at(r.snaps, 60), last = r.snaps.at(-1)!;
    expect(asleep(s60)).toBe(n);
    expect(asleep(last)).toBe(n);
    expect([last.pos, last.rot]).toEqual([s60.pos, s60.rot]);
    expect(last.linVel.every((v) => v === 0) && last.angVel.every((v) => v === 0)).toBe(true);
  });

  it('never puts a falling body to sleep', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // From 30 m it is still falling at 1.5 s (11 m down).
    const r = await run(sleepy(sceneOf([cube([0, 30, 0])])), 90, SLEEP);
    for (const s of r.snaps) expect(s.awake, `step ${s.step}`).toEqual([1]);
  });

  it('displacement: a cube gliding at 0.04 units/s, under v_sleep, never sleeps; the same cube at rest does at step T', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // On frictionless ground it keeps its speed; over a window of T = 30 steps it moves 0.02, more than 2% of r (0.0173).
    const glider = { ...cube([0, 0.5, 0], [0.04, 0, 0]), friction: 0 };
    const glide = await run(frictionless([glider]), 240, SLEEP);
    expect(glide.snaps.at(-1)!.linVel[0]).toBeCloseTo(0.04, 3);
    for (const s of glide.snaps) expect(s.awake, `step ${s.step}`).toEqual([1]);
    // It is the drift rule that keeps it awake: with the window as wide as the body, the speed test alone lets it sleep.
    const loose = await run(frictionless([glider]), 40, { ...SLEEP, sleepDrift: 1 });
    expect(loose.snaps.at(-1)!.awake).toEqual([0]);
    const rest = await run(frictionless([{ ...cube([0, 0.5, 0]), friction: 0 }]), 40, SLEEP);
    const first = rest.snaps.find((s) => s.awake![0] === 0)!.step;
    expect(first).toBeGreaterThanOrEqual(T);
    expect(first).toBeLessThanOrEqual(T + 1);
  });

  it('neighbours: a cube beside a ball spinning in place stays awake; beside the same ball at rest both sleep', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Frictionless, and 0.01 apart (inside the contact margin): a speculative contact joins them, and the
    // spinning ball (|w| r = 1.5 units/s) neither slows nor pushes the cube.
    const box = { ...cube([1.01, 0.5, 0]), friction: 0 };
    const spin = await run(frictionless([ball([0, 0.5, 0], [0, 3, 0]), box]), 120, SLEEP);
    for (const s of spin.snaps) expect(s.awake, `step ${s.step}`).toEqual([1, 1]);
    const last = spin.snaps.at(-1)!;
    expect(Math.hypot(last.linVel[3]!, last.linVel[4]!, last.linVel[5]!)).toBeLessThan(1e-3);
    expect(last.angVel[1]).toBeCloseTo(3, 2);
    const still = await run(frictionless([ball([0, 0.5, 0], [0, 0, 0]), box]), 60, SLEEP);
    expect(still.snaps.at(-1)!.awake).toEqual([0, 0]);
  });

  it('acts only when the scene allows sleep (SceneDesc.sleep), and refuses restitution, which does not know sleepers yet', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await run(sceneOf([cube([0, 0.5, 0])]), 60, SLEEP);
    for (const s of off.snaps) expect(s.awake).toEqual([1]);
    await expect(call('simulateGpu', sleepy(sceneOf([cube([0, 0.5, 0])])), 1, { restitution: true }, 0, SLEEP)).rejects.toThrow(/sleep is not implemented with AvbdParams.restitution/);
  });
});

describe('GPU sleep: every contact layout', () => {
  it('points, exact records and centre-friction records all freeze a resting city, and a removal under it wakes it', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const city = buildScenario('S14', { towers: 2, W: 2, D: 2, H: 3, street: 3 }, 1);
    const scene = sleepy(city, [{ step: 70, kind: 'remove', id: 0 }]);
    for (const records of [0, 1, 2]) {
      const r = await run(scene, 80, SLEEP, 1, { iterations: 8, records });
      const s60 = at(r.snaps, 60), s70 = at(r.snaps, 70), s71 = at(r.snaps, 71);
      expect(asleep(s60), `records ${records}`).toBe(city.bodies.length);
      expect([s70.pos, s70.rot], `records ${records}`).toEqual([s60.pos, s60.rot]);
      // Body 0 is a corner of the first tower's bottom layer: its tower wakes, and the cube above it falls.
      const tower = city.bodies[0]!.tag;
      city.bodies.forEach((b, i) => { if (i > 0 && b.tag === tower) expect(s71.awake![i], `records ${records} body ${i}`).toBe(1); });
      const above = city.bodies.findIndex((b) => b.tag === tower && b.pos[0] === city.bodies[0]!.pos[0] && b.pos[2] === city.bodies[0]!.pos[2] && b.pos[1] > 1 && b.pos[1] < 2);
      expect(above, `records ${records}`).toBeGreaterThan(0);
      expect(r.snaps.at(-1)!.pos[3 * above + 1]!, `records ${records}`).toBeLessThan(s70.pos[3 * above + 1]! - 0.05);
    }
  });
});

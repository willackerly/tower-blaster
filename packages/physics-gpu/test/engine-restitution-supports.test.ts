// The GPU AVBD engine with restitution (AvbdParams.restitution), continued
// from engine-restitution.test.ts: the supports against the reference, a
// resting column and a knockdown, and the stats (GpuAvbdEngine.restitutionStats).
// Split from it so that each file stays under CI's ~300 s per file.
//
// Measured on SwiftShader (2026-10-27) unless a comment says otherwise.
import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { ball, both, cube, drop, floats, G, gainOf, gpuRun, H, knock, maxSpeed, ON, refRun, type Run, sceneOf, shadowEnergy, withE, zeroG } from './bounce.ts';
import { gpu } from './harness.ts';

describe('GPU AVBD engine: restitution on, supports (against the reference)', () => {
  // Measured: no gain (0, as the reference), both at rest from step 61 on (1.3e-9 m/s), the cube driven into the
  // ground at 10.0378 m/s and the ball back at 1.4148 (the reference's to 1e-4; off 0.797 and 1.606).
  it('a 510 kg ball (e 0.9, 10 m/s) bouncing off a 1 kg cube on the ground gains no energy, and both come to rest', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const rr = 0.25, mb = 510, v = 10, e = 0.9;
    const scene = sceneOf([cube([0, 0.5, 0], { e }), ball([0, 1 + rr + 0.3, 0], { e, radius: rr, mass: mb, linVel: [0, -v, 0] })], { groundE: e });
    const r = await both(scene, 180, ON);
    expect(gainOf(scene, r.gpu, mb * (0.5 * v * v + G * 0.3)).gain).toBeLessThan(1e-6);
    expect(Math.max(...r.gpu.snaps.slice(121).map(maxSpeed))).toBeLessThan(1e-6);
    const down = (x: Run) => Math.max(...x.snaps.map((s) => -s.linVel[1]!)), back = (x: Run) => Math.max(...x.snaps.map((s) => s.linVel[4]!));
    expect(Math.abs(down(r.gpu) - down(r.ref))).toBeLessThan(1e-3);
    expect(Math.abs(back(r.gpu) - back(r.ref))).toBeLessThan(1e-3);
  });

  // Supports stop at depth 1, as on the reference: a ball (e 0.9, 5 m/s) onto a resting 3-cube column. The ball
  // and the top cube are in the bouncing manifold, so the top cube's contact with the middle one is a support,
  // but the middle cube's contact with the bottom one, and the bottom one's ground points, are not. Measured
  // (impact in step 61): the ball back up at 2.860385 m/s against the reference's 2.860408 (off 0.031), the cubes'
  // fastest speeds down, bottom to top, 0.35028, 1.41147 and 1.45908 against 0.35022, 1.41145 and 1.45906 (the
  // largest gap 5.6e-5).
  it('a ball bouncing on a 3-cube column takes supports to depth 1 only, as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 0.9, v = 5, spawn = 30;
    const scene: SceneDesc = { ...sceneOf([0, 1, 2].map((k) => cube([0, 0.5 + k, 0], { e })), { groundE: e }), inputs: [{ step: spawn, kind: 'spawn', body: ball([0, 3.5 + v * v / (2 * G), 0], { e }) }] };
    const r = await both(scene, spawn + 1 + Math.ceil(v / (G * H)) + 15, ON);
    const up = (x: Run) => Math.max(...x.snaps.slice(spawn + 1).map((s) => s.linVel[10]!));
    const down = (x: Run, i: number) => Math.max(...x.snaps.map((s) => -s.linVel[3 * i + 1]!));
    expect(up(r.gpu)).toBeGreaterThan(1);
    expect(Math.abs(up(r.gpu) - up(r.ref))).toBeLessThan(1e-3);
    for (const i of [0, 1, 2]) expect(Math.abs(down(r.gpu, i) - down(r.ref, i)), `cube ${i}`).toBeLessThan(1e-3);
  });

  // Measured: no gain (0, as the reference), at rest from step 181 on (3.2e-9 m/s over 241-300).
  it('a 1 kg ball (e 0.9, 20 m/s) onto a 0.4 kg cube lying on the ground gains no energy', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const v = 20, e = 0.9;
    const scene = sceneOf([cube([0, 0.5, 0], { e, density: 0.4 }), ball([0, 1.8, 0], { e, linVel: [0, -v, 0] })], { groundE: e });
    const r = await gpuRun(scene, 300, ON);
    expect(gainOf(scene, r, 0.5 * v * v + G * 0.3).gain).toBeLessThan(1e-6);
    expect(Math.max(...r.snaps.slice(241).map(maxSpeed))).toBeLessThan(1e-6);
  });

  // The cost of supports (the reference test's offRestingCube, the ball spawned after 30 steps instead of 120): a
  // ball of e 0.9 at 3 m/s onto a cube resting on the ground. Measured (spawn 30, as here), rebound over approach
  // and the cube's fastest speed down: 0.15378 / 0.98132 at 4 rounds, 0.49003 / 0.47922 at 8, 0.72946 / 0.12031
  // at 16, and 0.18739 / 1.75186 for a 5 kg ball at 8, each the reference's to the digits shown (eV within
  // 3.2e-6 of it, the speed within 4.1e-6; the same digits at spawn 120).
  it('a ball bounces off a cube resting on the ground as on the reference, at 4, 8 and 16 rounds, and 5 kg', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const v = 3, e = 0.9, yc = 1.5, spawn = 30;
    const measure = (x: Run) => {
      const atContact = (y: number, vy: number) => Math.sqrt(Math.max(0, (vy - G * H / 2) ** 2 + 2 * G * (y - yc)));
      let vIn = 0, down = 0, prev = { y: x.snaps[spawn + 1]!.pos[4]!, vy: x.snaps[spawn + 1]!.linVel[4]! };
      for (let k = spawn + 2; k < x.snaps.length; k++) {
        const s = x.snaps[k]!, cur = { y: s.pos[4]!, vy: s.linVel[4]! }, free = Math.abs(cur.vy - prev.vy + G * H) < 1e-4;
        down = Math.max(down, -s.linVel[1]!);
        if (!vIn && !free) vIn = atContact(prev.y, prev.vy);
        else if (vIn && prev.vy > 0 && free) return { eV: atContact(prev.y, prev.vy) / vIn, down };
        prev = cur;
      }
      return { eV: 0, down };
    };
    const eVs: number[] = [];
    for (const [rounds, mass] of [[4, 1], [8, 1], [16, 1], [8, 5]] as const) {
      const scene: SceneDesc = { ...sceneOf([cube([0, 0.5, 0], { e })], { groundE: e }), inputs: [{ step: spawn, kind: 'spawn', body: ball([0, yc + v * v / (2 * G), 0], { e, mass }) }] };
      const r = await both(scene, spawn + 1 + Math.ceil(v / (G * H)) + 30, { ...ON, restitutionRounds: rounds });
      const g = measure(r.gpu), f = measure(r.ref), id = `${rounds} rounds, ${mass} kg`;
      expect(Math.abs(g.eV - f.eV), id).toBeLessThan(1e-4);
      expect(Math.abs(g.down - f.down), id).toBeLessThan(1e-3);
      eVs.push(g.eV);
    }
    expect(eVs[0]).toBeLessThan(eVs[1]!);
    expect(eVs[1]).toBeLessThan(eVs[2]!);
    expect(eVs[3]).toBeLessThan(0.5 * eVs[1]!);
  });
});

describe('GPU AVBD engine: restitution on, at rest and in a knockdown', () => {
  // A resting column has no approach anywhere near 1 m/s, so no point qualifies and the pass changes nothing
  // (it still runs: 3 dispatches do work, the others are empty). Under threshold 0 every loaded point that
  // approaches at all bounces (4565 over these 300 steps, the reference 4559: which points creep down at 1e-8
  // m/s differs in f32), and the undisturbed column still rests: 3.9e-8 m/s over steps 201-300 (off 4.8e-8; the
  // reference's 6e-17 over 401-600), its top sagging 0.0138865 m against the reference's 0.0138867 (off 0.01422
  // on both). Struck, it would not: threshold 0 keeps a column moving after an impact on both engines (the
  // reference's restitute() and docs/plan.md).
  it('a resting 10-cube column (e 0.9) is the same floats as off at threshold 1, and rests at threshold 0', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = withE({ ...buildScenario('S1', { F: 1, H: 10, gap: 0 }, 1), sleep: false }, 0.9);
    const off = await gpuRun(scene, 300, {});
    const on = await gpuRun(scene, 300, ON);
    expect(floats(on)).toEqual(floats(off));
    const zero = await gpuRun(scene, 300, { ...ON, restitutionThreshold: 0 }, {}, true);
    expect(zero.stats.reduce((a, s) => a + s!.contacts, 0)).toBeGreaterThan(100);
    expect(Math.max(...zero.snaps.slice(201).map(maxSpeed))).toBeLessThan(1e-6);
    const top = scene.bodies.length - 1, y0 = scene.bodies[top]!.pos[1];
    const sag = (x: Run) => y0 - Math.min(...x.snaps.map((s) => s.pos[3 * top + 1]!));
    const ref = await refRun(scene, 300, { ...ON, restitutionThreshold: 0 });
    expect(Math.abs(sag(zero) - sag(ref))).toBeLessThan(1e-4);
  });

  // Measured: 402 points bounced, no non-finite value, no gain (as off).
  it('a ball knocks a tower of e 0.3 down without NaNs or energy gain, deterministically, in either Hessian form', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = withE(knock(15), 0.3);
    const gain = (x: Run) => {
      // From step 1, once the ball is in.
      const E0 = shadowEnergy(scene, x.snaps[1]!);
      let m = E0;
      for (const s of x.snaps.slice(1)) m = Math.max(m, shadowEnergy(scene, s));
      return (m - E0) / Math.abs(E0);
    };
    const on = await gpuRun(scene, 181, ON, {}, true), off = await gpuRun(scene, 181, {});
    expect(on.stats.reduce((a, s) => a + s!.contacts, 0)).toBeGreaterThan(100);
    expect(on.snaps.reduce((a, s) => a + nonFinite(s), 0)).toBe(0);
    expect(gain(on)).toBeLessThan(Math.max(gain(off), 0) + 1e-6);
    // The same floats again over the first 60 steps, and with the
    // array Hessian and the whole sweep in the tail (the pass reads only the solve's results, which are the same
    // floats in every form on SwiftShader). The array Hessian runs points (gpuRecordsLayout) and the others
    // records 1, so the last line also crosses the two layouts (engine-restitution-records.test.ts).
    // Measured: 40 of the points bounced by step 60, the first in step 16.
    expect(on.stats.slice(0, 60).reduce((a, s) => a + s!.contacts, 0)).toBeGreaterThan(20);
    const first = floats(on).slice(0, 61);
    expect(floats(await gpuRun(scene, 60, ON))).toEqual(first);
    expect(floats(await gpuRun(scene, 60, ON, { hessian: 'array', colorTail: 0 }))).toEqual(first);
  });

  // The loaded-gap slop and restitution were not measured together on the reference beyond this: a bounced
  // point's force is zeroed, so the slop does not act there the next step. Measured: eV the reference's to 1e-7.
  it('with gapSlop on too, a drop bounces as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const shape of ['cube', 'edge'] as const) {
      const r = await drop(shape, 5, 0.6, { ...ON, gapSlop: 3e-5 });
      expect(Math.abs(r.gpu.eV - r.ref.eV), shape).toBeLessThan(1e-5);
    }
  });
});

describe('GPU AVBD engine: restitution stats (GpuAvbdEngine.restitutionStats)', () => {
  const sum = (r: Run) => {
    let contacts = 0, impulse = 0, ground = 0;
    for (const s of r.stats) { contacts += s!.contacts; impulse += s!.impulse; ground = Math.max(ground, Math.hypot(...s!.groundImpulse)); }
    return { contacts, impulse, ground };
  };
  // A ball (e 0.9) at 5 m/s onto a cube resting on the ground: its one point bounces (step 151), and the cube's
  // four ground points hold the cube. Measured: 7.41461 N s in all and 3.48261 from the ground (the reference
  // 7.41463 and 3.48262).
  it('count the bounced points, not the supports, and the impulse they and the ground took, as the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene: SceneDesc = { ...sceneOf([cube([0, 0.5, 0], { e: 0.9 })], { groundE: 0.9 }), inputs: [{ step: 120, kind: 'spawn', body: ball([0, 1.5 + 25 / (2 * G), 0], { e: 0.9 }) }] };
    const r = await both(scene, 160, ON, true);
    const g = sum(r.gpu), f = sum(r.ref);
    expect(g.contacts).toBe(1);
    expect(f.contacts).toBe(1);
    expect(Math.abs(g.impulse - f.impulse)).toBeLessThan(1e-3);
    expect(Math.abs(g.ground - f.ground)).toBeLessThan(1e-3);
    expect(g.impulse).toBeGreaterThan(g.ground + 1);
    const k = r.gpu.stats.findIndex((s) => s!.contacts > 0);
    expect(k).toBe(r.ref.stats.findIndex((s) => s!.contacts > 0));
    // GpuAvbdEngine.restitutionStats() itself, after the step of the bounce: the same as the history's.
    const at = await gpuRun(scene, k + 1, ON, {}, true), { contacts, impulse, groundImpulse } = r.gpu.stats[k]!;
    expect(at.live).toEqual({ contacts, impulse, groundImpulse });
    expect(at.live!.contacts).toBe(1);
  });

  // Zero g, 1 kg at 5 m/s onto 5 kg, e 0.6, no ground. Started 0.01 m further apart than the reference test's
  // pair: there the two touch exactly at the end of a step, and whether that step's contact ends loaded (lambda
  // < 0 by rounding) decides the step of the bounce; the reference's f64 bounces a step before the GPU's f32
  // (6.667 N s, the whole impact, from the start velocities, against 2.501 after the solve's inelastic step),
  // to the same e (0.6 on both). Here both bounce in step 7 with 3.00075 N s (the reference 3.00074), the rest
  // of the impact the solve's.
  it('between bodies: one bounced point, the reference\'s impulse, at most the whole impact\'s, and nothing from the ground', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = zeroG([ball([-0.76, 0, 0], { e: 0.6, linVel: [5, 0, 0] }), ball([0.75, 0, 0], { e: 0.6, mass: 5 })]);
    const r = await both(scene, 60, ON, true);
    const g = sum(r.gpu), f = sum(r.ref);
    expect([g.contacts, f.contacts]).toEqual([1, 1]);
    expect(Math.abs(g.impulse - f.impulse)).toBeLessThan(1e-3);
    expect(g.impulse).toBeLessThan(1.6 * (5 / 6) * 5 + 1e-4);
    expect(g.ground).toBe(0);
  });

  it('are null with restitution off', { timeout: 60_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpuRun(sceneOf([cube([0, 0.5, 0])]), 2, {}, {}, true);
    expect(r.stats).toEqual([null, null]);
    expect(r.live).toBeNull();
  });
});

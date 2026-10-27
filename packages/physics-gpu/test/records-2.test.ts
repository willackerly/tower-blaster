// Manifold records 2 (AvbdParams.records, centre friction) on the GPU engine:
// against the reference's records 2, and on the S12/S13 walls and columns and
// rolling balls. Split from records.test.ts (the option, its layouts, and
// records 1 against points bit for bit), for CI's shards.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, freeFlight, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import type * as Drivers from './page.ts';
import { cube, gpu, runGpu, sceneOf } from './harness.ts';

describe('GPU AVBD engine: manifold records 2 against the reference', () => {
  /** Worst |GPU - reference| position over sampled steps, both with the same params (the reference in f64). */
  async function parity(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, every: number) {
    const g = await runGpu(scene, steps, params, every);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    let worst = 0;
    const at: Array<[number, number]> = [];
    for (let i = 1; i <= steps; i++) {
      e.step();
      const s = g.snaps.find((x) => x.step === i);
      if (!s) continue;
      const ref = e.snapshot().pos;
      let w = 0;
      for (let k = 0; k < ref.length; k++) w = Math.max(w, Math.abs(ref[k]! - s.pos[k]!));
      at.push([i, w]);
      worst = Math.max(worst, w);
    }
    return { worst, at, g };
  }

  describe('records 2 (centre friction) against the reference\'s records 2, and on walls, columns and rolling balls', () => {
    it('S13, a 20-cube column leaning 4 deg, and S1, a 4x4x10 tower: positions within a few f32 ulps of the f64 reference, as points', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      // Once S13's column falls (from about step 90), f32 against f64 grows for points as well, so the whole run
      // is held to twice points' error, and the column before it falls (steps <= 80; 1.35e-5 on 2026-10-27) and
      // the tower (2.07e-5) to an absolute bound.
      const cases: Array<[string, SceneDesc, number, number, number]> = [
        ['S13 H=20 4 deg', buildScenario('S13', { H: 20, deg: 4 }, 1), 120, 80, 2e-5],
        ['S1 4x4x10', buildScenario('S1', { F: 4, H: 10, gap: 0 }, 1), 120, 120, 4e-5],
      ];
      for (const [name, scene, steps, early, bound] of cases) {
        const pts = await parity(scene, steps, { records: 0 }, 10), rec = await parity(scene, steps, { records: 2 }, 10);
        console.log(`records parity ${name}: points ${pts.worst.toExponential(2)} records 2 ${rec.worst.toExponential(2)} (${JSON.stringify(rec.at.map(([s, w]) => [s, Number(w.toExponential(2))]))})`);
        expect(nonFinite(rec.g.s1), name).toBe(0);
        expect(rec.worst, name).toBeLessThan(Math.max(1e-5, 2 * pts.worst));
        expect(Math.max(...rec.at.filter(([s]) => s <= early).map(([, w]) => w)), `${name}, steps <= ${early}`).toBeLessThan(bound);
      }
    });

    // The friction rows of a multi-point record, which the columns and walls barely load: a cube spinning on the
    // ground (the twist row of a ground record), a cube spinning on another (a pair's twist, body a not the
    // ground) and a cube sliding at 3 m/s (T1 and T2), GPU against the reference's records 2 at every step.
    // 2026-10-27 (review scratch test, separate scenes): |dw| 8.7e-7 and 2.4e-5, slide |dx| 9.4e-7.
    it('cubes spinning on the ground and on a cube, and a cube sliding: the friction rows as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const spun = (pos: Vec3, angVel: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), angVel });
      const scene = sceneOf([spun([-4, 0.5, 0], [0, 5, 0]), cube([0, 0.5, 0]), spun([0, 1.5, 0], [0, 4, 0]), cube([4, 0.5, 0], [3, 0, 0])]);
      const steps = 90, params = { records: 2 };
      const g = await runGpu(scene, steps, params, 1);
      const e = new AvbdReferenceEngine(params);
      await e.init(scene);
      let dw = 0, dx = 0;
      for (let i = 1; i <= steps; i++) {
        e.step();
        const s = g.snaps.find((x) => x.step === i)!, r = e.snapshot();
        for (const b of [0, 2]) dw = Math.max(dw, Math.abs(s.angVel[3 * b + 1]! - r.angVel[3 * b + 1]!));
        for (let k = 0; k < r.pos.length; k++) dx = Math.max(dx, Math.abs(s.pos[k]! - r.pos[k]!));
      }
      const r = e.snapshot();
      console.log(`records 2 spin and slide: |dw| ${dw.toExponential(2)} |dx| ${dx.toExponential(2)}; reference w ${r.angVel[1]} ${r.angVel[7]}, slide ${r.pos[9]! - 4} m`);
      // The friction acted: both spins stopped, and the slider stopped after sliding.
      expect([Math.abs(r.angVel[1]!), Math.abs(r.angVel[7]!)].every((w) => w < 0.05)).toBe(true);
      expect(r.pos[9]! - 4).toBeGreaterThan(0.5);
      expect(Math.abs(r.linVel[9]!)).toBeLessThan(0.05);
      expect(dw).toBeLessThan(1e-4);
      expect(dx).toBeLessThan(1e-5);
    });

    // The default S12/S13 tests (engine.test.ts, physics-ref/test/collapse.test.ts) with records 2, at the
    // shipping 10 iterations, against the rigid column and the reference's records 2. Records 2 reference,
    // 2026-10-26: Q1 4 deg topples +2.14% late (points +3.03%), Q2 2 deg uprights 4.85% early and swings 0.689
    // of the rigid column's far side (points 6.12% and 0.632).
    it('S12: the cubes above the hole fall freely, and the rest of the wall stays', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const scene = buildScenario('S12', {}, 1), steps = 30;
      const above = aboveHole(scene);
      const g = await runGpu(scene, steps, { records: 2 });
      for (const i of above) {
        const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
        expect((scene.bodies[i]!.pos[1] - g.s1.pos[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
      }
      let worst = 0;
      scene.bodies.forEach((b, i) => {
        if (!above.includes(i)) worst = Math.max(worst, Math.hypot(g.s1.pos[3 * i]! - b.pos[0], g.s1.pos[3 * i + 1]! - b.pos[1], g.s1.pos[3 * i + 2]! - b.pos[2]));
      });
      expect(worst).toBeLessThan(0.03);
    });

    const column = async (deg: number, steps: number, params: Partial<AvbdParams>) => {
      const H = 20, scene = buildScenario('S13', { H, deg }, 1);
      const g = await runGpu(scene, steps, params, 5);
      const e = new AvbdReferenceEngine(params);
      await e.init(scene);
      const ref = [{ t: 0, pos: [...e.snapshot().pos] }];
      for (let i = 1; i <= steps; i++) { e.step(); if (i % 5 === 0 || i === steps) ref.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
      return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref, H) };
    };

    it('S13: a 20-cube column leaning 4 deg topples like the rigid column, and as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await column(4, 330, { records: 2 }), rod = rodToppleTime(r.H, 4, 30);
      console.log(`records 2 S13 4 deg: GPU topple ${r.gpu.topple} reference ${r.ref.topple} rigid ${rod}`);
      expect(r.gpu.topple).not.toBeNull();
      expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(0.12);
      expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
    });

    it('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column, as the reference\'s records 2', { timeout: 300_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await column(2, 300, { records: 2 }), rod = rodRock(r.H, 2);
      console.log(`records 2 S13 2 deg: GPU upright ${r.gpu.upright} far ${r.gpu.farSide} reference ${r.ref.upright} far ${r.ref.farSide} rigid ${rod.upright} far ${rod.farSide}`);
      expect(r.gpu.upright).not.toBeNull();
      expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.15);
      expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
      expect(r.gpu.turned).toBe(true);
      expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.58);
      expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
      expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
      // The far side is the number rounding moves (engine.test.ts says why). With records 2 the unmoved reference
      // run is the outlier: moving every start position by up to 1e-6 m (physics-ref/scripts/records-quality.ts
      // spread, 120 seeds, 2026-10-26) puts its far side at 1.270-1.323 deg, 0.086-0.033 below the unmoved run's
      // 1.356. The GPU on SwiftShader lands at 1.279, inside that spread (0.077 below). So the bounds follow the
      // spread, -0.10 / +0.02. At 20 iterations the spread is 1.881-1.883 deg, and the GPU there is held to 0.07.
      expect(r.gpu.farSide - r.ref.farSide).toBeGreaterThan(-0.1);
      expect(r.gpu.farSide - r.ref.farSide).toBeLessThan(0.02);
    });

    // At 20 iterations, with the brief's Q1 and Q2 conditions. Reference records 2, 2026-10-26: 4 deg +0.05%,
    // bend 0.02; 2 deg 0.53% early, far side 0.957 of the rigid column's.
    it('S13 at 20 iterations: 4 deg topples within 3% of the rigid column, 2 deg rocks back within 3% and 0.85-1.02 of its far side, as the reference\'s records 2', { timeout: 600_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const t = await column(4, 330, { records: 2, iterations: 20 }), rod = rodToppleTime(t.H, 4, 30);
      console.log(`records 2 S13 4 deg, 20 iterations: GPU topple ${t.gpu.topple} bend ${t.gpu.bend} reference ${t.ref.topple} rigid ${rod}`);
      expect(t.gpu.topple).not.toBeNull();
      expect(Math.abs(t.gpu.topple! / rod - 1)).toBeLessThan(0.03);
      expect(t.gpu.bend).toBeLessThan(0.1);
      expect(Math.abs(t.gpu.topple! - t.ref.topple!)).toBeLessThan(0.02);
      const r = await column(2, 300, { records: 2, iterations: 20 }), rr = rodRock(r.H, 2);
      console.log(`records 2 S13 2 deg, 20 iterations: GPU upright ${r.gpu.upright} far ${r.gpu.farSide} reference ${r.ref.upright} far ${r.ref.farSide} rigid ${rr.upright} far ${rr.farSide}`);
      expect(r.gpu.upright).not.toBeNull();
      expect(Math.abs(r.gpu.upright! / rr.upright - 1)).toBeLessThan(0.03);
      expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
      expect(r.gpu.turned).toBe(true);
      expect(r.gpu.farSide / rr.farSide).toBeGreaterThan(0.85);
      expect(r.gpu.farSide / rr.farSide).toBeLessThan(1.02);
      expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
      expect(Math.abs(r.gpu.farSide - r.ref.farSide)).toBeLessThan(0.07);
    });

    // Rolling contacts with records 2: a one-point record is a point's friction (rt = 0), with its slip carried at
    // the centre, so a ball keeps rolling as with points (engine.test.ts, rolling contacts).
    it('a steel ball rolling on the ground at 2 and 6 m/s keeps its height, speed and rolling, as on the reference\'s records 2', { timeout: 120_000 }, async (ctx) => {
      if (!gpu) return ctx.skip();
      const R = 0.25, SETTLE = 60;
      const ball = (pos: Vec3): BodyDesc => ({ shape: { kind: 'sphere', radius: R }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 7800, friction: 0.55, restitution: 0, tag: 0 });
      const kick = (body: number, v: number): Drivers.Kick => ({ step: SETTLE, body, linVel: [v, 0, 0], angVel: [0, 0, -v / R] });
      const scene: SceneDesc = { ...sceneOf([ball([0, R, 0]), ball([0, R, 3])]), frictionCombine: 'min' };
      const { all } = await runGpu(scene, SETTLE + 120, { records: 2 }, 1, [kick(0, 2), kick(1, 6)]);
      for (const [b, v0] of [[0, 2], [1, 6]] as const) {
        let dy = 0, dv = 0, dw = 0;
        const y0 = all[SETTLE]!.pos[3 * b + 1]!;
        for (const s of all.slice(SETTLE + 1)) {
          dy = Math.max(dy, Math.abs(s.pos[3 * b + 1]! - y0));
          dv = Math.max(dv, Math.abs(s.linVel[3 * b]! / v0 - 1));
          dw = Math.max(dw, Math.abs((-s.angVel[3 * b + 2]! * R) / s.linVel[3 * b]! - 1));
        }
        console.log(`records 2 rolling at ${v0} m/s: dy ${dy.toExponential(2)} dv ${dv.toExponential(2)} dw ${dw.toExponential(2)}`);
        expect(dy, `${v0} m/s`).toBeLessThan(1e-3);
        expect(dv, `${v0} m/s`).toBeLessThan(0.01);
        expect(dw, `${v0} m/s`).toBeLessThan(0.01);
      }
    });
  });
});

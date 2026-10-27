// The GPU AVBD engine with restitution (AvbdParams.restitution, opt-in; the
// pass is in src/restitution.ts, the rule and its limits in the reference's
// restitute(), physics-ref/src/avbd.ts), against the reference's own cases
// (physics-ref/test/restitution.test.ts), each run on both engines: off it is
// the engine as before; on, it bounces as the reference does, to f32. Its
// checks and variant keys are in engine.test.ts; the supports, rest, a
// knockdown and the stats are in engine-restitution-supports.test.ts (two
// files, so that each stays under CI's ~300 s per file).
//
// Measured on SwiftShader (2026-10-27) unless a comment says otherwise. The
// reference's own values are in its test; here the GPU is held to the
// reference's run of the same scene.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, CombineRule, SceneDesc } from '@tb/engine-api';
import { combineRestitution, DEFAULT_RESTITUTION_COMBINE } from '@tb/engine-api';
import { NAN_RESTITUTION, restitutionWord } from '../src/index.ts';
import { ball, both, cube, drop, floats, G, gainOf, gpuRun, H, knock, maxSpeed, ON, type Run, sceneOf, withE, zeroG } from './bounce.ts';
import { call, gpu } from './harness.ts';

describe('GPU AVBD engine: restitution off', () => {
  // The pass has its own buffers and pipelines, made only while the switch is on (src/restitution.ts); off, the
  // other kernels differ from before the port only in BodyProps.restitution, which took a padding word nothing
  // read. Off, absent or false, the engine gave the same floats as at a475030 (before the port) on 6 scenes with
  // impacts and bodies of e 0.6-0.9, the array Hessian and gapSlop among them (2026-10-27).
  it('absent or false it is the same floats, every e set, the ground\'s and the rule too; on, the floats differ', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = { ...withE(knock(15), 0.9), restitutionCombine: 'max' as const };
    const off = floats(await gpuRun(scene, 60, {}));
    expect(floats(await gpuRun(scene, 60, { restitution: false, restitutionThreshold: 0, restitutionRounds: 3 }))).toEqual(off);
    expect(floats(await gpuRun(withE(knock(15), 0), 60, {}))).toEqual(off);
    expect(floats(await gpuRun(scene, 60, ON))).not.toEqual(off);
  });

  it('off it encodes no extra dispatch; on, 6 + 2 x restitutionRounds (2 direct)', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = withE(knock(15), 0.6);
    const off = await call('dispatchCounts', scene, {}, {});
    const no = await call('dispatchCounts', scene, { restitution: false }, {});
    const on = await call('dispatchCounts', scene, ON, {});
    const three = await call('dispatchCounts', scene, { ...ON, restitutionRounds: 3 }, {});
    expect([off.error, no.error, on.error, three.error]).toEqual([null, null, null, null]);
    expect([no.direct, no.indirect]).toEqual([off.direct, off.indirect]);
    expect([on.direct - off.direct, on.indirect - off.indirect]).toEqual([2, 4 + 2 * 8]);
    expect([three.direct - off.direct, three.indirect - off.indirect]).toEqual([2, 4 + 2 * 3]);
  });
});

describe('GPU AVBD engine: BodyProps.restitution (restitutionWord)', () => {
  // WGSL may assume no NaN or infinity reaches a shader (min and max of a NaN are unspecified), so the host keeps
  // them out (src/restitution.ts's header): a NaN e, which no rule of the reference's bounces, is a finite word
  // pairE reads as no bounce; an infinite one is finite and as large, in f32.
  it('is e itself, NAN_RESTITUTION for NaN (or undefined), and finite in f32 beyond its range', () => {
    for (const e of [0, 0.3, 1, 1.5, -0.8, 1e30, -1e30]) expect(restitutionWord(e)).toBe(e);
    expect(restitutionWord(NaN)).toBe(NAN_RESTITUTION);
    expect(restitutionWord(undefined as unknown as number)).toBe(NAN_RESTITUTION);
    expect(Math.fround(NAN_RESTITUTION)).toBe(NAN_RESTITUTION);
    for (const e of [Infinity, -Infinity, 1e39, -1e300]) {
      const w = restitutionWord(e);
      expect(Math.fround(w), String(e)).toBe(w);
      expect(w, String(e)).toBe(Math.sign(e) * 1.7014117331926443e38);
      expect(w).not.toBe(NAN_RESTITUTION);
    }
  });
});

describe('GPU AVBD engine: restitution on, against the reference', () => {
  // Drops onto a ground of the body's e (so the pair's e is e), the reference test's measure: the rebound over
  // the impact speed, at contact. The speeds keep away from the threshold (1 m/s), where f32 can flip the >=.
  // Measured: the GPU's eV within 1.41e-6 of the reference's over sphere, flat cube and edge at these speeds and
  // e (2.1e-7 for the sphere); the energy never above its start by more than 3.8e-7 of it (f32: as much as before
  // the impact, in free flight; the reference's at most 1.9e-15).
  it('a sphere dropped at 2, 3, 5 and 10 m/s bounces at the reference\'s rebound, at e 0.3, 0.6 and 0.9', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const v of [2, 3, 5, 10]) for (const e of [0.3, 0.6, 0.9]) {
      const r = await drop('sphere', v, e), id = `e ${e} at ${v} m/s`;
      expect(r.ref.eV / e, id).toBeGreaterThan(0.75); // it did bounce (the reference's own band)
      expect(Math.abs(r.gpu.eV - r.ref.eV), id).toBeLessThan(1e-5);
      expect(r.gpu.eV, id).toBeLessThan(e);
      expect(r.gpu.eGain, id).toBeLessThan(1e-6);
    }
  });

  // Measured: eV within 1.41e-6 of the reference's, spin at most 5.1e-6 rad/s (the reference's 8.3e-10). A
  // sweep over the points alone leaves spin that later rounds take out (the reference's restitute()), so the
  // centroid step shows at 1 round: there the flat cube's eV is the reference's to 2e-7 and it does not spin
  // (the edge 8.6e-7 rad/s); with the GPU's centroid step taken out, its eV was 0.0226 off.
  it('a flat cube and a cube on its edge bounce as on the reference, with no spin (centroid step)', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const shape of ['cube', 'edge'] as const) for (const e of [0.3, 0.9]) for (const v of [3, 10]) {
      const r = await drop(shape, v, e), id = `${shape} e ${e} at ${v} m/s`;
      expect(Math.abs(r.gpu.eV - r.ref.eV), id).toBeLessThan(1e-5);
      expect(r.gpu.spinMax, id).toBeLessThan(1e-4);
      expect(r.gpu.eGain, id).toBeLessThan(1e-6);
    }
    for (const shape of ['cube', 'edge'] as const) {
      const r = await drop(shape, 5, 0.9, { ...ON, restitutionRounds: 1 });
      expect(Math.abs(r.gpu.eV - r.ref.eV), `${shape}, 1 round`).toBeLessThan(1e-5);
      expect(r.gpu.spinMax, `${shape}, 1 round`).toBeLessThan(1e-4);
    }
  });

  // Zero-g sphere pairs (the reference test's pair()), 1 kg onto 1 kg at 5 m/s, run 20 steps (they meet in step
  // 6): (vB - vA) / v is the pair's e. Measured: within 1.1e-7 of the reference's under every rule and order;
  // clamped at 1 (1.5 / 1.5) and at 0 (0.6 / -0.8 under average: the solve's own 0.0185). A NaN e bounces
  // nothing under any rule, as on the reference (with NaN itself in BodyProps, SwiftShader bounced it under min
  // and max: eEff 0.88); an infinite one combines as the reference's (average 1, times 0 no bounce).
  it('two coefficients combine by SceneDesc.restitutionCombine (default average), in either order, clamped to [0, 1]', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const eEff = (r: Run, v: number) => (r.snaps.at(-1)!.linVel[3]! - r.snaps.at(-1)!.linVel[0]!) / v;
    const cases: Array<[CombineRule | undefined, number, number]> = [];
    for (const rule of [undefined, 'average', 'min', 'max', 'multiply'] as const) for (const [eA, eB] of [[0.2, 0.8], [0.8, 0.2]] as const) cases.push([rule, eA, eB]);
    cases.push(['average', 1.5, 1.5], ['average', 0.6, -0.8], ['max', 0.6, -0.8]);
    cases.push(['min', NaN, 0.9], ['max', 0.9, NaN], ['average', NaN, 0.9], ['multiply', 0.9, NaN], ['average', Infinity, 0.2], ['multiply', Infinity, 0]);
    for (const [rule, eA, eB] of cases) {
      const v = 5, scene = zeroG([ball([-0.75, 0, 0], { e: eA, linVel: [v, 0, 0] }), ball([0.75, 0, 0], { e: eB })], rule);
      const r = await both(scene, 20, ON), id = `${rule} ${eA}/${eB}`;
      const want = Math.min(1, Math.max(0, combineRestitution(rule ?? DEFAULT_RESTITUTION_COMBINE, eA, eB)));
      expect(Math.abs(eEff(r.gpu, v) - eEff(r.ref, v)), id).toBeLessThan(1e-6);
      if (want > 0) expect(eEff(r.gpu, v), id).toBeCloseTo(want, 5);
      else expect(eEff(r.gpu, v), id).toBeLessThan(0.1);
    }
  });

  // The threshold is compared with >= (the reference test's own case), off the step-boundary knife edge (the
  // pair starts 0.505 m apart, so no step ends exactly at the touch): at exactly the threshold speed vn0 is
  // exactly -threshold in f32 too (sphere normals along x, velocities 1 and 2 exact). Measured: eEff
  // 0.6000000238 against the reference's 0.6 at 1 m/s, 0.5999999940 against 0.6 at 2 m/s under threshold 2, and
  // 0.000376273 against 0.000376267 at 0.999 m/s (no bounce: the solve's own). With > for >=, 0.5997 off at 1 m/s.
  it('a pair approaching at exactly the threshold bounces (>=), one just below does not', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const eEff = (r: Run, v: number) => (r.snaps.at(-1)!.linVel[3]! - r.snaps.at(-1)!.linVel[0]!) / v;
    for (const [v, threshold] of [[1, 1], [2, 2], [0.999, 1]] as const) {
      const scene = zeroG([ball([-0.755, 0, 0], { e: 0.6, linVel: [v, 0, 0] }), ball([0.75, 0, 0], { e: 0.6 })]);
      const r = await both(scene, Math.ceil(0.505 / v / H) + 30, { ...ON, restitutionThreshold: threshold }), id = `${v} m/s, threshold ${threshold}`;
      const g = eEff(r.gpu, v);
      expect(Math.abs(g - eEff(r.ref, v)), id).toBeLessThan(1e-5);
      if (v < threshold) expect(g, id).toBeLessThan(0.1);
      else expect(g, id).toBeCloseTo(0.6, 4);
    }
  });

  // The pass's effective masses take the world inverse inertia at q0 (the start of the step, the Jacobians'
  // pose): a box of half extents 1 x 0.25 x 0.5 spinning at 10 rad/s about the normal (0.17 rad a step) is struck
  // off-centre by a 0.25 m ball at 5 m/s (zero g, frictionless). Measured at step 8: the ball's vy -2.698228
  // against the reference's -2.698219, the box's within 9.8e-6, its w within 3.1e-5 (off -2.405; with the
  // inverse inertia at the end-of-step rotation, -2.783526).
  it('a spinning anisotropic box struck off-centre takes the impulse at the start-of-step inertia, as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const box: BodyDesc = { ...cube([0, 0, 0], { e: 0.6, friction: 0 }), shape: { kind: 'box', half: [1, 0.25, 0.5] }, angVel: [0, 10, 0] };
    const scene = zeroG([box, ball([0.6, 0.25 + 0.25 + 0.2537, 0], { e: 0.6, radius: 0.25, friction: 0, linVel: [0, -5, 0] })]);
    const r = await both(scene, 8, ON);
    const at = (x: Run) => { const s = x.snaps.at(-1)!; return { ball: s.linVel[4]!, box: s.linVel[1]!, w: [0, 1, 2].map((k) => s.angVel[k]!) }; };
    const g = at(r.gpu), f = at(r.ref);
    expect(g.ball).toBeGreaterThan(-2.75);
    expect(Math.abs(g.ball - f.ball)).toBeLessThan(1e-4);
    expect(Math.abs(g.box - f.box)).toBeLessThan(1e-4);
    for (let k = 0; k < 3; k++) expect(Math.abs(g.w[k]! - f.w[k]!), `w ${k}`).toBeLessThan(1e-3);
  });

  // A manifold with points that bounce and loaded points that do not is two of the pass's manifolds, and counts
  // twice in its bodies' split: a cube landing nearly flat (tilted 0.07 rad, 1.6 m/s) while spinning about z at
  // 3 rad/s, its leading corners approaching above the threshold and its trailing ones below. Measured at step 2
  // (the bounce): v (-0.592836, 1.393548), w_z -3.007924 against the reference's (-0.592726, 1.393495),
  // -3.008030, the largest gap over steps 1-3 1.2e-4; counted once, vy 1.428315. The gap is the solve's: with
  // restitution off the two part by up to 2.3e-4 over the same steps (vx by the same 1.1e-4 on and off).
  it('a spinning cube landing on bouncing and supporting points of one manifold rebounds as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const w = 3, v = 1.6, g0 = 0.04, t = (-v + Math.sqrt(v * v + 2 * G * g0)) / G, th = -w * t;
    const c: BodyDesc = { ...cube([0, 0.5 + g0, 0], { e: 0.9, linVel: [0, -v, 0], rot: [0, 0, Math.sin(th / 2), Math.cos(th / 2)] }), angVel: [0, 0, w] };
    const r = await both(sceneOf([c], { groundE: 0.9 }), 3, ON);
    for (const k of [1, 2, 3]) {
      const at = (x: Run) => [x.snaps[k]!.linVel[0]!, x.snaps[k]!.linVel[1]!, x.snaps[k]!.angVel[2]!];
      const g = at(r.gpu), f = at(r.ref);
      for (let j = 0; j < 3; j++) expect(Math.abs(g[j]! - f[j]!), `step ${k}, component ${j}`).toBeLessThan(1e-3);
    }
  });

  // An e 0.6 ball at 5 m/s on grounds of other e. Measured: eV within 9.3e-8 of the reference's.
  it('the ground\'s restitution (SceneDesc.ground.restitution, default 0) combines with the body\'s', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const [o, e] of [[{ groundE: 0.6 }, 0.6], [{ groundE: undefined }, 0.3], [{ groundE: undefined, rule: 'max' }, 0.6], [{ groundE: 0.2, rule: 'min' }, 0.2], [{ groundE: 0.4, rule: 'multiply' }, 0.24]] as const) {
      const r = await drop('sphere', 5, 0.6, ON, o), id = JSON.stringify(o);
      expect(r.gpu.eV / e, id).toBeGreaterThan(0.9);
      expect(r.gpu.eV / e, id).toBeLessThan(1);
      expect(Math.abs(r.gpu.eV - r.ref.eV), id).toBeLessThan(1e-5);
    }
  });

  // Measured: eV within 1e-7 of the reference's, the tangential speed kept to the last bit, no spin.
  it('frictionless oblique impacts keep the tangential velocity and gain no spin', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const shape of ['sphere', 'cube'] as const) {
      const r = await drop(shape, 5, 0.6, ON, { vt: 4 });
      expect(Math.abs(r.gpu.eV - r.ref.eV), shape).toBeLessThan(1e-5);
      expect(Math.abs(r.gpu.vtOut / 4 - 1), shape).toBeLessThan(1e-6);
      expect(r.gpu.spinMax, shape).toBeLessThan(1e-4);
    }
  });

  // Mass splitting (the reference test's twoOnOne): two cubes strike a box side by side, e 1. Measured: no gain
  // at 1, 4 or 8 rounds; the energy kept 0.741009, 0.973251 and 0.999832 (the reference's to 1e-6).
  it('two cubes striking a box side by side (e = 1) gain no energy, and converge with the rounds as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const rounds of [1, 4, 8]) {
      const e = 1, box: BodyDesc = { ...cube([0, 0, 0], { e }), shape: { kind: 'box', half: [0.5, 1, 0.5] } };
      const scene = zeroG([cube([-1.3, 0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), cube([-1.3, -0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), box]);
      const r = await both(scene, 90, { ...ON, restitutionRounds: rounds });
      const g = gainOf(scene, r.gpu), f = gainOf(scene, r.ref);
      expect(g.gain, `${rounds} rounds`).toBeLessThan(1e-6);
      expect(Math.abs(g.end - f.end), `${rounds} rounds`).toBeLessThan(1e-5);
    }
  });

  // Two bouncing manifolds at once (the reference test's pin). Measured: the first rebound 3.843064 m/s (the
  // reference's 3.843063), the top cube's velocity at step 100 within 1.3e-5 of the reference's, energy at most
  // 1.2e-7 above its start (f32), and at rest over steps 421-480 (8.7e-7 m/s; still 6.9e-6 over 361-420, where
  // the reference's, its bounces drifted apart from the GPU's by then, is at 0.5 m/s, and 6e-15 a window later).
  it('a cube dropped flat onto two cubes gains no energy, comes to rest, and moves as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 0.9, scene = sceneOf([cube([-0.55, 0.5, 0], { e }), cube([0.55, 0.5, 0], { e }), cube([0, 1.5 + 25 / (2 * G), 0], { e })], { groundE: e });
    const r = await both(scene, 480, ON);
    const up = (x: Run) => Math.max(...x.snaps.map((s) => s.linVel[7]!));
    expect(up(r.gpu)).toBeGreaterThan(3.8);
    expect(Math.abs(up(r.gpu) - up(r.ref))).toBeLessThan(1e-4);
    for (const k of [6, 7, 8]) expect(Math.abs(r.gpu.snaps[100]!.linVel[k]! - r.ref.snaps[100]!.linVel[k]!)).toBeLessThan(1e-4);
    expect(gainOf(scene, r.gpu).gain).toBeLessThan(1e-6);
    expect(Math.max(...r.gpu.snaps.slice(421).map(maxSpeed))).toBeLessThan(1e-5);
  });
});

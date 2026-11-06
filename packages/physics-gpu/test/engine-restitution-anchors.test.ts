// Anchors in the GPU's restitution pass (AvbdParams.restitutionAnchors, on by
// default with restitution; src/restitution.ts, the reference's restitute(),
// "Anchors"): a body in a bouncing manifold is held exactly by the ground and
// by resting bodies it sits on. Each case runs on both engines and holds the
// GPU to the reference's run of the same scene; the weakness they fix (a heavy
// striker drives a struck body into what it rests on) is pinned without them in
// engine-restitution-supports.test.ts.
//
// Measured on SwiftShader (2026-11-05) unless a comment says otherwise.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, CombineRule, SceneDesc, Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { ball, both, cube, floats, G, gainOf, gpuRun, H, knock, OLD, ON, type Run, sceneOf, shadowEnergy, withE, zeroG } from './bounce.ts';
import { gpu } from './harness.ts';

/** The first upward speed of body i over v (0 if it never rose), from step `from` on. */
const upOf = (x: Run, i: number, v: number, from = 0) => {
  for (const s of x.snaps.slice(from)) if (s.linVel[3 * i + 1]! > 0) return s.linVel[3 * i + 1]! / v;
  return 0;
};

describe('GPU AVBD engine: restitution anchors, against the reference', () => {
  // A ball (radius 0.25) at 10 m/s, e 0.9, onto a 1 kg cube on the ground (the reference's mass table). Measured
  // the ball's first upward speed over its speed at contact 0.889, 0.883, 0.811 and 0.808 for 1, 5, 510 and 2000 kg
  // (the reference's to 4e-4; without anchors 0.582, 0.137, 0.137 and 0.0005), the cube's fastest speed down 0.012,
  // 0.139, 0.798 and 0.829 m/s (the reference's to 3.9e-3; without anchors 1.58, 5.67, 10.04 and 12.1).
  it.for([1, 5, 510, 2000])('a %i kg ball bounces off a cube on the ground as on the reference, near e, and drives it down no faster than without anchors', { timeout: 120_000 }, async (mb, ctx) => {
    if (!gpu) return ctx.skip();
    const rr = 0.25, v = 10, e = 0.9;
    const scene = sceneOf([cube([0, 0.5, 0], { e }), ball([0, 1 + rr + 0.3, 0], { e, radius: rr, mass: mb, linVel: [0, -v, 0] })], { groundE: e });
    const v1 = Math.sqrt(v * v + 2 * G * 0.3);
    const r = await both(scene, 30, ON), old = await gpuRun(scene, 30, OLD);
    const down = (x: Run) => Math.max(...x.snaps.map((s) => -s.linVel[1]!));
    expect(upOf(r.gpu, 1, v1)).toBeGreaterThan(0.78);
    expect(Math.abs(upOf(r.gpu, 1, v1) - upOf(r.ref, 1, v1))).toBeLessThan(1e-3);
    expect(Math.abs(down(r.gpu) - down(r.ref))).toBeLessThan(5e-3);
    expect(down(r.gpu)).toBeLessThanOrEqual(down(old) + 1e-6);
    expect(gainOf(scene, r.gpu, mb * (0.5 * v * v + G * 0.3)).gain).toBeLessThan(1e-6);
  });

  // The brief's probe (the reference test's ontoColumn): a 144 kg rubber ball (e 0.6) at 20 m/s onto a 10-cube
  // plaster column (e 0.05, rule max). The top cube sits on a resting cube, so that contact holds it (an anchor
  // between bodies). Measured over the strike (60 steps): up 0.5171 of v and 5.3 mm into the top cube (the
  // reference's 0.5171 and 5.3 mm); without anchors 0.165 and 0.129 m.
  it('a 144 kg ball onto a 10-cube column bounces off its top and sinks in under 0.05 m, as on the reference', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const n = 10, r = 0.5, v = 20, spawn = 120, v0 = Math.sqrt(v * v - 2 * G * 0.3);
    const scene: SceneDesc = {
      ...sceneOf(Array.from({ length: n }, (_, k) => cube([0, 0.5 + k, 0], { e: 0.05 })), { groundE: 0.05, rule: 'max' as CombineRule }),
      inputs: [{ step: spawn, kind: 'spawn', body: ball([0, n + r + 0.3, 0], { e: 0.6, mass: 144, radius: r, linVel: [0, -v0, 0] }) }],
    };
    const sinkOf = (x: Run) => Math.max(...x.snaps.slice(spawn + 1).map((s) => s.pos[3 * (n - 1) + 1]! + 0.5 - (s.pos[3 * n + 1]! - r)));
    const res = await both(scene, spawn + 1 + 60, ON), old = await gpuRun(scene, spawn + 1 + 60, OLD);
    expect(upOf(res.gpu, n, v, spawn + 1)).toBeGreaterThan(0.4);
    expect(Math.abs(upOf(res.gpu, n, v, spawn + 1) - upOf(res.ref, n, v, spawn + 1))).toBeLessThan(2e-3);
    expect(sinkOf(res.gpu)).toBeLessThan(0.05);
    expect(Math.abs(sinkOf(res.gpu) - sinkOf(res.ref))).toBeLessThan(2e-3);
    expect(sinkOf(old)).toBeGreaterThan(0.1);
  });

  // An anchor holds whichever body of the pair is in the pass: listed bottom first the struck top cube is body b of
  // its contact with the lower one, top first body a (the reference's holdsB and holdsA). A 50 kg ball (e 0.9) at 8
  // m/s onto a resting 2-cube stack. Measured up/v 0.7479 both ways (the reference's to 4e-6; without anchors 0.18).
  it('a 50 kg ball bounces off a resting 2-cube stack the same whichever cube is listed first, as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 0.9, v = 8, spawn = 60;
    const stack = (topFirst: boolean): SceneDesc => {
      const cubes = [cube([0, 0.5, 0], { e }), cube([0, 1.5, 0], { e })];
      return { ...sceneOf(topFirst ? cubes.reverse() : cubes, { groundE: e }), inputs: [{ step: spawn, kind: 'spawn', body: ball([0, 2.85, 0], { e, mass: 50, radius: 0.25, linVel: [0, -v, 0] }) }] };
    };
    const up = await both(stack(false), spawn + 20, ON), down = await both(stack(true), spawn + 20, ON), old = await gpuRun(stack(false), spawn + 20, OLD);
    const u = (x: Run) => upOf(x, 2, v, spawn + 2);
    expect(u(up.gpu)).toBeGreaterThan(0.7);
    expect(Math.abs(u(up.gpu) - u(down.gpu))).toBeLessThan(1e-3);
    expect(Math.abs(u(up.gpu) - u(up.ref))).toBeLessThan(1e-3);
    expect(Math.abs(u(down.gpu) - u(down.ref))).toBeLessThan(1e-3);
    expect(u(old)).toBeLessThan(0.5);
  });

  // The reference test's plank: a 20 kg ball (e 0.9) at 8 m/s onto the tip of a 0.32 kg plank lying on a cube, its
  // tip 0.85 m beyond the cube's centre. Anchored on the cube's edge it bears on, the plank pivots as on a rigid
  // pivot. Measured w_z -27.48 rad/s on the GPU (the reference's to 2e-5, the rigid pivot's 27.03). Struck from
  // below (5 kg) with a cube on its tip, the cube above is a support, not an anchor: 9.397 (the reference's to
  // 2e-6; without anchors 9.54).
  it('a plank struck on its overhang pivots on the edge it bears on; struck from below, it lifts the cube on it; as on the reference', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const plank = (fromBelow: boolean, load: boolean, mass: number): SceneDesc => {
      const e = 0.9, r = 0.15, spawn = 120;
      const box = (pos: Vec3, half: Vec3): BodyDesc => ({ ...cube(pos, { e }), shape: { kind: 'box', half } });
      const bodies = [cube([0, 0.5, 0], { e }), box([0.2, 1.1, 0], [1, 0.1, 0.4]), ...(load ? [box([1.05, 1.3, 0], [0.1, 0.1, 0.1])] : [])];
      return { ...sceneOf(bodies, { groundE: e }), inputs: [{ step: spawn, kind: 'spawn', body: ball([1.05, fromBelow ? 1.0 - r - 0.05 : 1.2 + r + (load ? 0.2 : 0) + 0.05, 0], { e, mass, radius: r, friction: 0, linVel: [0, fromBelow ? 8 : -8, 0] }) }] };
    };
    const wz = (x: Run) => { let w = 0; for (const s of x.snaps.slice(121, 125)) if (Math.abs(s.angVel[5]!) > Math.abs(w)) w = s.angVel[5]!; return w; };
    const I = 0.32 * (4 + 0.04) / 12 + 0.32 * 0.3 ** 2, L = 0.55, rigid = 1.9 * 20 * 8 / (20 + I / L ** 2) / L;
    const top = await both(plank(false, false, 20), 124, ON);
    expect(Math.abs(Math.abs(wz(top.gpu)) / rigid - 1)).toBeLessThan(0.03);
    expect(Math.abs(wz(top.gpu) - wz(top.ref))).toBeLessThan(0.05);
    const below = await both(plank(true, true, 5), 124, ON), old = await gpuRun(plank(true, true, 5), 124, OLD);
    expect(wz(below.gpu)).toBeGreaterThan(0.5 * wz(old));
    expect(Math.abs(wz(below.gpu) - wz(below.ref))).toBeLessThan(0.05);
  });
});

describe('GPU AVBD engine: restitution anchors, where none hold', () => {
  // In zero g nothing sits on anything (anchors need up), and there is no ground: the pass is the floats it is
  // without anchors. Two cubes strike a box side by side (e 1, mass splitting) and a ball strikes a pair.
  it('in zero g the pass gives the same floats with and without anchors', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 1, box: BodyDesc = { ...cube([0, 0, 0], { e }), shape: { kind: 'box', half: [0.5, 1, 0.5] } };
    const scene = zeroG([cube([-1.3, 0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), cube([-1.3, -0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), box, ball([0, 1.8, 0], { e: 0.6, mass: 30, radius: 0.3, linVel: [0, -6, 0] })]);
    const on = await gpuRun(scene, 60, ON, {}, true), off = await gpuRun(scene, 60, OLD, {}, true);
    expect(on.stats.reduce((a, s) => a + s!.contacts, 0)).toBeGreaterThan(1);
    expect(floats(on)).toEqual(floats(off));
  });

  // The reference test's sliding support: a 50 kg ball onto a cube that sits on a cube sliding at 2 m/s
  // (frictionless). The lower cube does not rest (restitutionAnchorSpeed), so it holds nothing and the GPU moves
  // as the reference does; at rest it holds the top cube. Measured up/v 0.183 sliding and 0.748 at rest (the
  // reference's to 4e-6).
  it('a support that slides holds nothing, one at rest does, as on the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const e = 0.9, spawn = 60;
    const slide = (speed: number): SceneDesc => ({
      ...sceneOf([cube([0, 0.5, 0], { e, linVel: [speed, 0, 0], friction: 0 }), cube([0, 1.5, 0], { e, linVel: [speed, 0, 0] })], { groundE: e, friction: 0 }),
      inputs: [{ step: spawn, kind: 'spawn', body: ball([speed * spawn * H, 2.85, 0], { e, mass: 50, radius: 0.25, linVel: [speed, -8, 0] }) }],
    });
    const u = (x: Run) => upOf(x, 2, 8, spawn + 2);
    const moving = await both(slide(2), spawn + 20, ON), still = await both(slide(0), spawn + 20, ON);
    expect(Math.abs(u(moving.gpu) - u(moving.ref))).toBeLessThan(1e-3);
    expect(Math.abs(u(still.gpu) - u(still.ref))).toBeLessThan(1e-3);
    expect(u(still.gpu)).toBeGreaterThan(u(moving.gpu) + 0.2);
  });

  // Measured: no non-finite value, no gain over the start once the ball is in (as off). On SwiftShader (2026-11-05)
  // no S5 knock gained at e 0.3, 0.5 or 0.6 (8, 15 and 25 m/s, mass ratio 5 and 50, anchors on and off); at e 0.9
  // one of six did, this scene at 15 m/s: 3.9% of |E0| with anchors, 1.3e-4 without (the reference's run of it
  // gains nothing, nor does it on 30 others at e 0.5 and 0.9; restitute(), "Energy in chains", says why).
  it('a ball knocks a tower of e 0.6 down without NaNs or energy gain', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = withE(knock(15), 0.6);
    const gain = (x: Run) => {
      const E0 = shadowEnergy(scene, x.snaps[1]!);
      let m = E0;
      for (const s of x.snaps.slice(1)) m = Math.max(m, shadowEnergy(scene, s));
      return (m - E0) / Math.abs(E0);
    };
    const on = await gpuRun(scene, 181, ON, {}, true), off = await gpuRun(scene, 181, {});
    expect(on.stats.reduce((a, s) => a + s!.contacts, 0)).toBeGreaterThan(100);
    expect(on.snaps.reduce((a, s) => a + nonFinite(s), 0)).toBe(0);
    expect(gain(on)).toBeLessThan(Math.max(gain(off), 0) + 1e-6);
  });
});

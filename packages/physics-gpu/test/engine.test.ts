// The GPU AVBD engine against analytic results and the f64 reference: single
// bodies, friction, rolling contacts, snapshot(), the engine contract and
// finish(). The other engine*.test.ts files hold the slower groups, so CI
// shards can run them side by side; harness.ts has the shared setup.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, type CombineRule, emptySnapshot, freeFlight, massOf, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { drift, penetration } from '@tb/metrics';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { appliedMu, slideMu, slideScene, THROW, throwScene } from '@tb/testkit';
import { GpuAvbdEngine } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { gpu, call, runGpu, runRef, cube, sceneOf, G, MU, stopping } from './harness.ts';

describe('GPU AVBD engine: single bodies against analytic results', () => {
  it('a resting cube stays put', async (ctx) => {
    if (!gpu) return ctx.skip();
    const { s1 } = await runGpu(sceneOf([cube([0, 0.5, 0])]), 120);
    expect(Math.abs(s1.pos[1]! - 0.5)).toBeLessThan(1e-4);
    expect(Math.hypot(s1.linVel[0]!, s1.linVel[1]!, s1.linVel[2]!)).toBeLessThan(1e-4);
  });

  it('a dropped cube lands on time without bouncing', async (ctx) => {
    if (!gpu) return ctx.skip();
    const { all } = await runGpu(sceneOf([cube([0, 2, 0])]), 90, {}, 1);
    const landed = all.findIndex((s) => s.pos[1]! < 0.51);
    expect(landed).toBeGreaterThanOrEqual(31);
    expect(landed).toBeLessThanOrEqual(34);
    expect(Math.max(...all.slice(landed).map((s) => s.pos[1]!))).toBeLessThan(0.51);
  });

  // Off-axis error: exact along a face normal (symmetry); at 120 deg the GPU
  // and the reference both end 4e-6 rad off. Before the secant friction
  // stiffness (2026-10-25) the cube spun after it stopped, so this depended
  // on rounding: 3.8e-3 rad here, 2.7e-2 on macOS SwiftShader. Per-row
  // friction penalties (the bug this first guarded against) gave 0.2 rad.
  it.for([[3, 0, 1e-5], [-1.5, 2.598, 1e-4]] as const)('a cube sliding at (%s, %s) stops where Coulomb friction says', async ([vx, vz, offAxis], ctx) => {
    if (!gpu) return ctx.skip();
    const { s1 } = await runGpu(sceneOf([cube([0, 0.5, 0], [vx, 0, vz])]), 120);
    const d = Math.hypot(s1.pos[0]!, s1.pos[2]!) / stopping(Math.hypot(vx, vz));
    expect(d).toBeGreaterThan(0.97);
    expect(d).toBeLessThan(1.03);
    expect(Math.abs(Math.atan2(s1.pos[2]!, s1.pos[0]!) - Math.atan2(vz, vx))).toBeLessThan(offAxis);
  });

  it('incline: sticks below the friction angle, slides at g (sin - mu cos) above', async (ctx) => {
    if (!gpu) return ctx.skip();
    const tilted = (t: number): Vec3 => [G * Math.sin(t), -G * Math.cos(t), 0];
    const stick = await runGpu(sceneOf([cube([0, 0.5, 0])], tilted(Math.atan(0.5))), 120);
    expect(Math.abs(stick.s1.pos[0]!)).toBeLessThan(1e-3);
    const theta = Math.atan(0.8);
    const slide = await runGpu(sceneOf([cube([0, 0.5, 0])], tilted(theta)), 60);
    const ratio = slide.s1.linVel[0]! / (G * (Math.sin(theta) - MU * Math.cos(theta)));
    expect(ratio).toBeGreaterThan(0.95);
    expect(ratio).toBeLessThan(1.05);
  });
});

// The stick/slip boundary (see the reference's tests of the same name). Each
// test failed before the secant friction stiffness and the dual-branch stick
// flag: a cube that slid or spun to a stop kept turning and creeping, so
// where it ended depended on rounding.
describe('GPU AVBD engine: friction at the stick/slip boundary', () => {
  const yawOf = (q: ArrayLike<number>) => 2 * Math.atan2(q[1]!, q[3]!);
  const at = (speed: number, deg: number): Vec3 => [Math.fround(speed * Math.cos((deg * Math.PI) / 180)), 0, Math.fround(speed * Math.sin((deg * Math.PI) / 180))];
  const offAxis = (s: Snapshot, v: Vec3) => {
    const a = Math.atan2(s.pos[2]!, s.pos[0]!) - Math.atan2(v[2], v[0]);
    return Math.atan2(Math.sin(a), Math.cos(a));
  };

  // Baseline at (3, 120): 0.65 rad/s and 0.2 mm of creep between steps 70 and 120.
  it.for([[3, 120], [6, 200]] as const)('a cube slid at %s m/s, %s deg comes to rest: no spin, creep or yaw drift', async ([speed, deg], ctx) => {
    if (!gpu) return ctx.skip();
    const v = at(speed, deg);
    const { all, s1 } = await runGpu(sceneOf([cube([0, 0.5, 0], v)]), 150, {}, 10);
    const stop = Math.ceil(speed / ((MU * G) / 60));
    const rest = all.filter((_, k) => 10 * k >= stop + 20);
    expect(rest.length).toBeGreaterThanOrEqual(5);
    const r0 = rest[0]!;
    expect(Math.max(...rest.map((s) => Math.hypot(s.angVel[0]!, s.angVel[1]!, s.angVel[2]!)))).toBeLessThan(1e-4);
    expect(Math.max(...rest.map((s) => Math.hypot(s.linVel[0]!, s.linVel[1]!, s.linVel[2]!)))).toBeLessThan(1e-4);
    expect(Math.hypot(s1.pos[0]! - r0.pos[0]!, s1.pos[2]! - r0.pos[2]!)).toBeLessThan(1e-4);
    expect(Math.abs(yawOf(s1.rot) - yawOf(r0.rot))).toBeLessThan(1e-4);
    expect(Math.abs(Math.hypot(s1.pos[0]!, s1.pos[2]!) / stopping(speed) - 1)).toBeLessThan(0.01);
    expect(Math.abs(offAxis(s1, v))).toBeLessThan(1e-4);
  });

  it('where it stops does not depend on rounding: 1-ulp nudges of the start velocity', async (ctx) => {
    if (!gpu) return ctx.skip();
    const nudge = (x: number, k: number) => { const f = new Float32Array([x]); new Int32Array(f.buffer)[0]! += k; return f[0]!; };
    // Seven cubes 3 m apart in one scene (one pipeline build instead of seven); they never meet.
    const ks = [-3, -2, -1, 0, 1, 2, 3];
    const vs = ks.map((k): Vec3 => [nudge(-1.5, k), 0, nudge(2.598, -k)]);
    const { s1 } = await runGpu(sceneOf(ks.map((k, j) => cube([3 * k, 0.5, 0], vs[j]))), 120);
    const offs = ks.map((k, j) => {
      const a = Math.atan2(s1.pos[3 * j + 2]!, s1.pos[3 * j]! - 3 * k) - Math.atan2(vs[j]![2], vs[j]![0]);
      return Math.atan2(Math.sin(a), Math.cos(a));
    });
    // Baseline spread: 2.9e-2 rad (one cube at a time: -2.7e-2 to 3.5e-3, in clusters; macOS SwiftShader's 2.7e-2 is one). Now 2e-6.
    expect(Math.max(...offs) - Math.min(...offs)).toBeLessThan(1e-5);
    for (const o of offs) expect(Math.abs(o)).toBeLessThan(1e-4);
  });

  it('a contact never reuses anchors that have drifted apart by stickThreshold, even after an impact at 1-3 iterations', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // The reference test of the same name says why. Before the drift was checked at reuse: 4.1 cm.
    const spin = { ...cube([0, 0.6, 0], [0, -1, 0]), angVel: [0, 8, 0] as Vec3 };
    const ball: BodyDesc = { ...cube([-3, 2.5, 0], [10, 0, 0]), shape: { kind: 'sphere', radius: 0.3 }, density: 5, friction: 0.5 };
    const scenes = [sceneOf([cube([0, 0.6, 0], [3, -1, 0])]), sceneOf([spin]), sceneOf([0, 1, 2, 3].map((k) => cube([0, 0.5 + k, 0])).concat([ball]))];
    for (const iterations of [1, 2, 3]) for (const [k, scene] of scenes.entries()) {
      const r = await call('anchorDrift', scene, 60, { iterations });
      expect(r.error).toBeNull();
      expect(r.worst, `${iterations} iterations, scene ${k}`).toBeLessThan(0.01);
    }
  });

  it('a cube spinning on the ground stops on the step Coulomb friction says, and stays stopped', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Four corner contacts at r = sqrt(1/2) carry mu m g / 4 each: alpha = 6 r mu g for I = m / 6.
    const mu = 0.6, w0 = 5;
    const scene = { ...sceneOf([{ ...cube([0, 0.5, 0]), angVel: [0, w0, 0] as Vec3, friction: mu }]), ground: { y: 0, friction: mu } };
    const { all, s1 } = await runGpu(scene, 60, {}, 1);
    const stop = all.findIndex((s) => Math.abs(s.angVel[1]!) < 1e-2);
    expect(Math.abs(stop - Math.ceil(w0 / ((6 * Math.SQRT1_2 * mu * G) / 60)))).toBeLessThanOrEqual(1);
    const after = all.slice(stop + 10);
    expect(Math.max(...after.map((s) => Math.hypot(s.angVel[0]!, s.angVel[1]!, s.angVel[2]!, s.linVel[0]!, s.linVel[1]!, s.linVel[2]!)))).toBeLessThan(1e-4);
    expect(Math.hypot(s1.pos[0]!, s1.pos[2]!)).toBeLessThan(1e-4);
  });
});

// Rolling contacts (AvbdParams.rollingContacts): the reference's collide()
// says why, and physics-ref/test/avbd.test.ts has these cases in f64. Steel
// balls of R 0.25 settle at rest for 60 steps and are then set rolling, w R = v.
describe('GPU AVBD engine: rolling contacts', () => {
  const R = 0.25, SETTLE = 60;
  const ball = (pos: Vec3, v = 0, radius = R): BodyDesc => ({
    shape: { kind: 'sphere', radius }, pos, rot: [0, 0, 0, 1], linVel: [v, 0, 0], angVel: [0, 0, -v / radius], density: 7800, friction: 0.55, restitution: 0, tag: 0,
  });
  const slab = (z: number, hx = 2): BodyDesc => ({ ...cube([0, 0.25, z]), shape: { kind: 'box', half: [hx, 0.25, 2] }, density: 1e4 });
  const rollScene = (bodies: BodyDesc[]): SceneDesc => ({ ...sceneOf(bodies), frictionCombine: 'min' });
  const kick = (body: number, v: number, step = SETTLE): Drivers.Kick => ({ step, body, linVel: [v, 0, 0], angVel: [0, 0, -v / R] });
  /** Ball b over the steps after its kick at `from` (snapshots every step): worst change of its height above `surface`, lowest height, |v / v0 - 1| and |w R / v - 1|. */
  const rolling = (all: Snapshot[], b: number, v0: number, surface: (s: Snapshot) => number, from = SETTLE) => {
    const y = (s: Snapshot) => s.pos[3 * b + 1]! - surface(s) - R;
    const y0 = y(all[from]!);
    let dy = 0, low = Infinity, dv = 0, dw = 0;
    for (const s of all.slice(from + 1)) {
      dy = Math.max(dy, Math.abs(y(s) - y0));
      low = Math.min(low, y(s));
      dv = Math.max(dv, Math.abs(s.linVel[3 * b]! / v0 - 1));
      dw = Math.max(dw, Math.abs((-s.angVel[3 * b + 2]! * R) / s.linVel[3 * b]! - 1));
    }
    return { dy, low, dv, dw };
  };
  const state = (s: Snapshot) => [s.pos, s.rot, s.linVel, s.angVel].map((a) => [...a]);

  it('a steel ball rolling on the ground at 2 and 6 m/s keeps its height, speed and rolling', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Both balls in one scene, 3 m apart (one pipeline build), 2 s after the kick. 2026-10-26 (SwiftShader):
    // height within 1.5e-7 m, speed and w R exact. Kept anchors (rollingContacts false, GPU and reference
    // alike): 1.19 m and 1.51 m sunk.
    const { all } = await runGpu(rollScene([ball([0, R, 0]), ball([0, R, 3])]), SETTLE + 120, { iterations: 10 }, 1, [kick(0, 2), kick(1, 6)]);
    for (const [b, v0] of [[0, 2], [1, 6]] as const) {
      const r = rolling(all, b, v0, () => 0), at = `${v0} m/s`;
      expect(r.dy, at).toBeLessThan(1e-3);
      expect(r.low, at).toBeGreaterThan(-1e-3);
      expect(r.dv, at).toBeLessThan(0.01);
      expect(r.dw, at).toBeLessThan(0.01);
    }
  });

  it('a ball rolls across a heavy box at constant height and speed, listed before or after the box', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Listed first the ball is a, and matching keys on its arm; listed after the box, on b's. A 4 x 0.5 x 4 slab
    // at 2 m/s, and an 8 m slab at 6 m/s (kicked 35 steps later, so it rolls 65 steps as on the reference). At
    // 6 m/s the box's anchor moves v h = 0.1 m a step, past matchDistance: keyed on it, the ball listed first
    // lost the match every step and sank 0.51 m. 2026-10-26 (SwiftShader): height within 1.8e-7 m, |w R / v - 1|
    // 7.7e-6. Kept anchors (rollingContacts false, GPU and reference alike): 0.72 m and 0.89 m into the box at 2 m/s.
    const LATE = SETTLE + 35;
    const scene = rollScene([
      ball([0.4 - 2, 0.5 + R, 0]), slab(0), slab(6), ball([0.4 - 2, 0.5 + R, 6]),
      ball([0.4 - 4, 0.5 + R, 12]), slab(12, 4), slab(18, 4), ball([0.4 - 4, 0.5 + R, 18]),
    ]);
    const { all } = await runGpu(scene, SETTLE + 100, { iterations: 10 }, 1, [kick(0, 2), kick(3, 2), kick(4, 6, LATE), kick(7, 6, LATE)]);
    const cases = [[0, 1, 2, SETTLE, 'ball first'], [3, 2, 2, SETTLE, 'box first'], [4, 5, 6, LATE, 'ball first'], [7, 6, 6, LATE, 'box first']] as const;
    for (const [b, box, v0, from, order] of cases) {
      const r = rolling(all, b, v0, (s) => s.pos[3 * box + 1]! + 0.25, from), at = `${v0} m/s, ${order}`;
      expect(r.dy, at).toBeLessThan(1e-3);
      expect(r.low, at).toBeGreaterThan(-1e-3);
      expect(r.dv, at).toBeLessThan(0.01);
      expect(r.dw, at).toBeLessThan(0.01);
    }
  });

  it('a ball rolling over a much larger sphere stays on its surface, listed before or after it', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Between two spheres matching keys on the smaller one's arm (a's or b's). GPU and reference: -0.44 to
    // +3.34 mm in both orders; kept anchors, or keyed on b's arm with the big sphere listed second: 817 mm into it.
    const Rb = 10, v0 = 4;
    const big = (z: number): BodyDesc => ({ ...ball([0, Rb, z], 0, Rb), density: 1e5, friction: MU });
    const small = (z: number) => ball([-0.5, Rb + Math.sqrt((Rb + R) ** 2 - 0.25), z], v0);
    const { all } = await runGpu(sceneOf([big(0), small(0), small(25), big(25)]), 70, { iterations: 10 }, 1);
    for (const [sm, bg, at] of [[1, 0, 'big sphere first'], [2, 3, 'big sphere second']] as const) {
      let low = Infinity, high = -Infinity, n = 0;
      for (const [k, s] of all.entries()) {
        if (k === 0) continue;
        const d = [0, 1, 2].map((c) => s.pos[3 * sm + c]! - s.pos[3 * bg + c]!);
        if (Math.abs(Math.atan2(d[0]!, d[1]!)) > (20 * Math.PI) / 180) break; // 20 deg past the top
        const gap = Math.hypot(d[0]!, d[1]!, d[2]!) - Rb - R;
        if (k > 10) { low = Math.min(low, gap); high = Math.max(high, gap); n++; }
      }
      expect(n, at).toBeGreaterThan(20);
      expect(low, at).toBeGreaterThan(-5e-3);
      expect(high, at).toBeLessThan(5e-3);
    }
  });

  it('a plank on two ball rollers ends where the reference does, plank listed before or after the balls', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Pair contacts with the ball as b (plank first) and as a (balls first), and the balls' ground contacts.
    // The bound is f32's: a random 1-ulp error added to every position, rotation and velocity after every
    // step moves the reference's final positions by 4.6e-6 to 7.5e-5 m (24 draws; rounding them to f32
    // instead, 2e-7), so 1e-4 allows the GPU an ulp of state error per step. 2026-10-26 (SwiftShader): 3.6e-7.
    // (By 180 steps the same noise moves them 1.2e-4 to 7.2e-4, so a longer run needs a wider bound.)
    const plank = (z: number): BodyDesc => ({ ...cube([0, 2 * R + 0.05, z], [1, 0, 0]), shape: { kind: 'box', half: [2.4, 0.05, 0.4] }, density: 500 });
    const rollers = (z: number) => [-0.6, 0.6].map((x): BodyDesc => ({ ...ball([x, R, z]), density: 1000, friction: MU }));
    const scene = sceneOf([plank(0), ...rollers(0), ...rollers(3), plank(3)]);
    const steps = 90;
    const g = await runGpu(scene, steps, { iterations: 10 });
    const ref = await runRef(scene, steps);
    let worst = 0;
    for (let k = 0; k < ref.pos.length; k++) worst = Math.max(worst, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(worst).toBeLessThan(1e-4);
    // And the analytic speeds: the plank at 2 M / (2 M + 1.4 m), the balls at half that, rolling.
    const M = 500 * 4.8 * 0.1 * 0.8, m = (1000 * 4 * Math.PI * R ** 3) / 3, V = (2 * M) / (2 * M + 1.4 * m);
    for (const [p, bs] of [[0, [1, 2]], [5, [3, 4]]] as const) {
      expect(Math.abs(g.s1.linVel[3 * p]! / V - 1)).toBeLessThan(0.01);
      for (const b of bs) {
        expect(Math.abs(g.s1.linVel[3 * b]! / (V / 2) - 1)).toBeLessThan(0.01);
        expect(Math.abs((-g.s1.angVel[3 * b + 2]! * R) / g.s1.linVel[3 * b]! - 1)).toBeLessThan(0.01);
      }
    }
  });

  /** Snapshots of a reference run, one per step from the start. */
  async function refSteps(scene: SceneDesc, steps: number) {
    const e = new AvbdReferenceEngine();
    await e.init(scene);
    const out = [e.snapshot()];
    for (let i = 0; i < steps; i++) { e.step(); out.push(e.snapshot()); }
    return out;
  }
  /** The bodies `idx` of a snapshot, as a snapshot of their own. */
  const pick = (s: Snapshot, idx: readonly number[]) => {
    const p = emptySnapshot(idx.length);
    idx.forEach((i, k) => {
      for (let c = 0; c < 3; c++) { p.pos[3 * k + c] = s.pos[3 * i + c]!; p.linVel[3 * k + c] = s.linVel[3 * i + c]!; p.angVel[3 * k + c] = s.angVel[3 * i + c]!; }
      for (let c = 0; c < 4; c++) p.rot[4 * k + c] = s.rot[4 * i + c]!;
    });
    return p;
  };

  it('a heavy ball\'s impact on a light cube goes as deep as on the reference: the load floor cap is sqrt(m_a m_b) / h^2, and only in an impact', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A 510 kg steel ball dropped 1 m onto a 31 kg (Keystone's plaster) and a 1 kg cube on the ground, and one
    // placed at rest on a 1 kg cube, side by side. Reference, deepest over 2 s: 24.6, 73.6 and 7.6 mm (the
    // resting one's landing transient), all 0 from step 61. Capped at the lighter body's m / h^2: 59.1, 102.2
    // and 42.8 mm. Capped whether or not the contact moved along its normal: 26.1, 73.6 and 19.3 mm, and 0.7 and
    // 1.3 mm on the 1 kg cubes from step 61. Each case alone, its start moved by up to 1e-5 m, gives the same
    // deepest to 0.01 mm, so the GPU must follow within 1 mm. 2026-10-26 (SwiftShader): the same to 0.001 mm.
    const cases = [[250, 1.75, 'dropped on 31 kg'], [8, 1.75, 'dropped on 1 kg'], [8, 0.75, 'at rest on 1 kg']] as const;
    const bodies = cases.flatMap(([density, y], i): BodyDesc[] => [
      { ...cube([0, 0.25, 3 * i]), shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, density }, ball([0, y, 3 * i]),
    ]);
    const scene = sceneOf(bodies), steps = 120;
    const g = await runGpu(scene, steps, { iterations: 10 }, 1);
    const ref = await refSteps(scene, steps);
    cases.forEach(([, , at], i) => {
      const idx = [2 * i, 2 * i + 1], sub = idx.map((k) => bodies[k]!);
      const depth = (all: Snapshot[], from: number) => Math.max(...all.slice(from).map((s) => penetration(sub, pick(s, idx), 0).max));
      expect(Math.abs(depth(g.all, 1) - depth(ref, 1)), at).toBeLessThan(1e-3);
      expect(depth(g.all, 61), at).toBeLessThan(1e-4);
    });
  });

  it('a ball hitting a free cube in zero g keeps the momentum as on the reference, head-on and grazing', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // A 5 kg ball at 15 m/s hits a 1 kg cube (the reference's test, both hits side by side). Worst momentum drift
    // over 1.5 s, reference: 0.405% head-on and 0.116% grazing. Kept anchors (rollingContacts false): 8.99% and
    // 0.160%. Capped whether or not the contact moved along its normal: 0.157% head-on, so the GPU must follow
    // within 0.1 points. 2026-10-26 (SwiftShader): the same to 0.0001 points.
    const R6 = 0.6, density = 5 / ((4 / 3) * Math.PI * R6 ** 3);
    const hits = [[[-1.5, 0, 0], [15, 0, 0], 'head-on'], [[-1.5, 0.45, 0.2], [15, -2.6, 0], 'grazing']] as const;
    const bodies = hits.flatMap(([p, v], i): BodyDesc[] => [
      cube([0, 0, 10 * i]), { ...ball([p[0], p[1], p[2] + 10 * i], 0, R6), linVel: [...v], angVel: [0, 0, 0], density, friction: MU },
    ]);
    const scene: SceneDesc = { ...sceneOf(bodies, [0, 0, 0]), ground: null }, steps = 90;
    const g = await runGpu(scene, steps, { iterations: 10 }, 1);
    const ref = await refSteps(scene, steps);
    const m = bodies.map(massOf);
    hits.forEach(([, , at], i) => {
      const P = (s: Snapshot) => [0, 1, 2].map((c) => m[2 * i]! * s.linVel[6 * i + c]! + m[2 * i + 1]! * s.linVel[6 * i + 3 + c]!);
      const drift = (all: Snapshot[]) => {
        const p0 = P(all[0]!);
        return Math.max(...all.map((s) => { const p = P(s); return Math.hypot(p[0]! - p0[0]!, p[1]! - p0[1]!, p[2]! - p0[2]!) / Math.hypot(...p0); }));
      };
      expect(g.s1.linVel[6 * i], at).toBeGreaterThan(5); // the cube was hit
      expect(drift(g.all), at).toBeLessThan(0.01);
      expect(Math.abs(drift(g.all) - drift(ref)), at).toBeLessThan(1e-3);
    });
  });

  it('rollingContacts false changes nothing for boxes, bit for bit, and keeps a ball\'s anchors as the reference does', { timeout: 120_000 }, async (ctx) => {
    expect(new GpuAvbdEngine({ rollingContacts: false }).info.variant.rollingContacts).toBe(false);
    expect(new GpuAvbdEngine().info.variant.rollingContacts).toBe(true);
    if (!gpu) return ctx.skip();
    // Loose cubes falling into a heap: contacts made, sliding, sticking and lost.
    const heap = buildScenario('S11', { N: 200 }, 7);
    const on = await runGpu(heap, 60), off = await runGpu(heap, 60, { rollingContacts: false });
    expect(state(off.s1)).toEqual(state(on.s1));
    // A ball rolling at 2 m/s: false must bring the kept anchors back, not just leave the flag unread. It
    // sinks 0.36 m in 1 s on the reference; 2026-10-26 (SwiftShader) the GPU followed within 2.8e-6 m.
    const roll = rollScene([ball([0, R, 0], 2)]);
    const g = await runGpu(roll, 60, { rollingContacts: false }, 1);
    const e = new AvbdReferenceEngine({ rollingContacts: false });
    await e.init(roll);
    let worst = 0;
    for (let i = 1; i <= 60; i++) {
      e.step();
      worst = Math.max(worst, Math.abs(e.snapshot().pos[1]! - g.all[i]!.pos[1]!));
    }
    expect(e.snapshot().pos[1]).toBeLessThan(0);
    expect(worst).toBeLessThan(1e-4);
  });
});

describe('GPU AVBD engine: snapshot()', () => {
  const knock = (fireStep: number) => buildScenario('S5', { N: 48, F: 2, H: 12, fireStep, speed: 15, massRatio: 5, radius: 0.6 }, 1);

  it('equals the readStruct decode bit for bit at the call, reads awake from flags bit 0 only, and reuses one staging buffer', async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = knock(0);
    const r = await call('snapshotDecode', scene, 50, 7);
    expect(r.error).toBeNull();
    expect(r.count).toBe(bodiesAt(scene, 50).length);
    expect(r.compared).toBe(14 * r.count);
    // A step() issued before snapshot() resolves is not in it.
    expect(r.mismatches, JSON.stringify(r.examples)).toBe(0);
    expect(r.changedByStep).toBeGreaterThan(0);
    // add() writes flags 1, and nothing else writes them.
    const ones = Array<number>(r.count).fill(1);
    const body7 = (a: number) => ones.map((x, i) => (i === 7 ? a : x));
    expect(r.awake).toEqual({ start: ones, tierBits: body7(0), woken: ones, highBits: body7(0), lowByte: ones });
    expect(r.created).toBe(1);
  });

  it('diagnostics() reads through the same pool, and dispose() destroys it, rejecting a snapshot in flight', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('engineReadback', knock(0), 5);
    expect(r.error).toBeNull();
    expect(r.diagnostics).toEqual({ created: 2, bytesRead: 2 * r.diagnostics.perCall, perCall: r.diagnostics.perCall });
    expect(r.snapshotInFlight).toBe('Readback: destroyed during a read');
    // The two diagnostics buffers and the snapshot's.
    expect(r.destroyed).toEqual([true, true, true]);
    expect(r.readAfterDispose).toBe('Readback: destroyed');
  });

  it('reads only the bodies spawned so far, n * 64 bytes, not the capacity', async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = knock(30);
    const r = await call('snapshotSpawn', scene, [0, 10, 31]);
    expect(r.error).toBeNull();
    const n = scene.bodies.length;
    expect(r.capacityBytes).toBe((n + 1) * 64);
    expect(r.reads).toEqual([
      { step: 0, count: n, posLength: 3 * n, bytes: 64 * n },
      { step: 10, count: n, posLength: 3 * n, bytes: 64 * n },
      { step: 31, count: n + 1, posLength: 3 * (n + 1), bytes: 64 * (n + 1) },
    ]);
  });
});

describe('GPU AVBD engine: engine contract (friction rule, integrator)', () => {
  const mu = async (rule: CombineRule | undefined) => {
    const { all } = await runGpu(slideScene(rule), 11, {}, 1);
    return appliedMu(all[1]!.linVel[0]!, all[11]!.linVel[0]!);
  };
  it.for(['average', 'min', 'max', 'multiply'] as const)('SceneDesc.frictionCombine %s: a sliding cube decelerates with the combined mu', async (rule, ctx) => {
    if (!gpu) return ctx.skip();
    // Within solver convergence; the closest two rules differ by 0.03.
    expect(await mu(rule)).toBeCloseTo(slideMu(rule), 3);
  });

  it('frictionCombine defaults to average', async (ctx) => {
    if (!gpu) return ctx.skip();
    expect(await mu(undefined)).toBe(await mu('average'));
  });

  it('restitution (AvbdParams.restitution) throws until it is ported, its params are checked as in the reference, and while off its keys stay out of the variant', () => {
    expect(() => new GpuAvbdEngine({ restitution: true })).toThrow('GpuAvbdEngine: restitution is not implemented on the GPU yet');
    // The reference's checks, switch on or off.
    for (const [p, msg] of [[{ restitutionThreshold: -1 }, 'restitutionThreshold must be a finite number >= 0, got -1'], [{ restitutionRounds: 0 }, 'restitutionRounds must be an integer >= 1, got 0']] as const) {
      expect(() => new AvbdReferenceEngine(p)).toThrow(msg);
      expect(() => new GpuAvbdEngine(p)).toThrow(msg);
    }
    const keys = Object.keys(new GpuAvbdEngine().info.variant);
    expect(Object.keys(new GpuAvbdEngine({ restitution: false, restitutionThreshold: 2, restitutionRounds: 3 }).info.variant)).toEqual(keys);
    expect(keys.some((k) => k.startsWith('restitution'))).toBe(false);
  });

  it('the loaded-gap slop (AvbdParams.gapSlop) is accepted, checked as in the reference, and in the variant exactly while it is on, as there', () => {
    // Its effect on the GPU: engine-gapslop.test.ts.
    for (const g of [-1, -1e-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new AvbdReferenceEngine({ gapSlop: g })).toThrow(`AvbdParams.gapSlop must be a finite number >= 0, got ${g}`);
      expect(() => new GpuAvbdEngine({ gapSlop: g })).toThrow(`AvbdParams.gapSlop must be a finite number >= 0, got ${g}`);
    }
    for (const p of [{}, { gapSlop: 0 }, { gapSlop: 3e-5 }, { gapSlop: 1 }]) expect(new GpuAvbdEngine(p).info.variant).toEqual(new AvbdReferenceEngine(p).info.variant);
    expect(Object.keys(new GpuAvbdEngine({ gapSlop: 0 }).info.variant)).toEqual(Object.keys(new GpuAvbdEngine().info.variant));
    expect('gapSlop' in new GpuAvbdEngine().info.variant).toBe(false);
    expect(new GpuAvbdEngine({ gapSlop: 3e-5 }).info.variant.gapSlop).toBe(3e-5);
  });

  it('free flight is semi-implicit Euler with one substep, as EngineInfo.integrator says', async (ctx) => {
    expect(new GpuAvbdEngine().info.integrator).toEqual({ substeps: 1 });
    if (!gpu) return ctx.skip();
    const scene = throwScene();
    const { s1 } = await runGpu(scene, THROW.steps);
    const want = freeFlight(THROW.pos, THROW.vel, scene.gravity, scene.dt, 1, THROW.steps);
    // f32 state; two substeps would put it 8 cm higher by now.
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(s1.pos[k]! - want.pos[k]!)).toBeLessThan(5e-4);
      expect(Math.abs(s1.linVel[k]! - want.vel[k]!)).toBeLessThan(5e-4);
    }
  });
});

describe('GPU AVBD engine: finish()', () => {
  it('waits until the device queue reports the submitted work done', async () => {
    const e = new GpuAvbdEngine();
    let release!: () => void;
    const done = new Promise<void>((r) => { release = r; });
    (e as unknown as { device: unknown }).device = { queue: { onSubmittedWorkDone: () => done } };
    let finished = false;
    const f = e.finish().then(() => { finished = true; });
    await new Promise((r) => setTimeout(r, 10));
    expect(finished).toBe(false);
    release();
    await f;
    expect(finished).toBe(true);
  });

  it('rejects after a GPU error or a lost device, so work that never ran is never timed', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('finishFailures', sceneOf([cube([0, 0.5, 0])]));
    expect(r.healthy).toBe('resolved');
    expect(r.afterError).toMatch(/^GpuAvbdEngine: GPU error: /);
    expect(r.stepAfterError).toMatch(/^GpuAvbdEngine: GPU error: /);
    expect(r.afterLoss).toMatch(/^GpuAvbdEngine: GPU device lost \(destroyed\)/);
    expect(r.reinit).toBe('resolved');
  });
});

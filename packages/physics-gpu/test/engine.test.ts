// The GPU AVBD engine against analytic results and the f64 reference.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, type CombineRule, emptySnapshot, freeFlight, massOf, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { drift, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { type AvbdParams, AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, appliedMu, loadBundle, openWebGPU, readColumn, rodRock, rodToppleTime, slideMu, slideScene, THROW, throwScene, tippingAngle, type WebGPUSession } from '@tb/testkit';
import { defaultTailThreads, GpuAvbdEngine, type GpuEngineOptions, HESSIAN_FORMS, solveWgsl } from '../src/index.ts';
import type * as Drivers from './page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__phys');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __phys: Record<string, (...x: unknown[]) => unknown> }).__phys[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

const toSnap = (p: Drivers.PlainSnapshot): Snapshot => {
  const s = emptySnapshot(p.pos.length / 3);
  s.pos.set(p.pos); s.rot.set(p.rot); s.linVel.set(p.linVel); s.angVel.set(p.angVel); s.awake.fill(1);
  return s;
};
async function runGpu(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}, every = 0, kicks: Drivers.Kick[] = []) {
  const r = await call('simulateGpu', scene, steps, params, every, {}, kicks);
  expect(r.error).toBeNull();
  expect(r.worst.uncolored).toBe(0);
  expect(r.worst.colorOverflow).toBe(0);
  expect(r.worst.pairsRequired).toBeLessThanOrEqual(r.worst.pairsWritten);
  return { ...r, s0: toSnap(r.snaps[0]!), s1: toSnap(r.snaps[r.snaps.length - 1]!), all: r.snaps.map(toSnap) };
}
async function runRef(scene: SceneDesc, steps: number) {
  const e = new AvbdReferenceEngine();
  await e.init(scene);
  for (let i = 0; i < steps; i++) e.step();
  return e.snapshot();
}

const cube = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.6, restitution: 0, tag: 0,
});
const sceneOf = (bodies: BodyDesc[], gravity: Vec3 = [0, -9.81, 0]): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity, dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: false, bodies, inputs: [],
});
const G = 9.81, MU = 0.6;
const stopping = (v0: number, h = 1 / 60) => {
  let x = 0;
  for (let v = v0 - MU * G * h; v > 0; v -= MU * G * h) x += h * v;
  return x;
};

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

describe('GPU AVBD engine: stacks, towers and impacts', () => {
  // One test per scene, with room to spare: under SwiftShader on a 4-core
  // CI runner the two together took 51 s of the default 60 s, and timed
  // out once another GPU test file ran alongside. The tower alone is most
  // of that (19 s of 27 s on the dev VM).
  it.for([['10-cube stack', 'S9', { H: 10, ratio: 1 }], ['3x3x8 tower', 'S1', { F: 3, H: 8, gap: 0 }]] as const)('a %s stands, matching the reference', { timeout: 120_000 }, async ([, id, params], ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario(id, params, 1);
    const g = await runGpu(scene, 120);
    expect(nonFinite(g.s1)).toBe(0);
    expect(survival(scene.bodies, g.s0, g.s1, [0, 1])).toBeGreaterThan(0.999);
    expect(drift(g.s0, g.s1)).toBeLessThan(1e-3);
    expect(jitter(g.s1)).toBeLessThan(1e-3);
    expect(penetration(scene.bodies, g.s1, 0).max).toBeLessThan(1e-3);
    const ref = await runRef(scene, 120);
    let worst = 0;
    for (let k = 0; k < ref.pos.length; k++) worst = Math.max(worst, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(worst).toBeLessThan(1e-3);
  });

  // The load floor (AvbdParams.restDepth). Without it this column falls over
  // (physics-ref/test/avbd.test.ts; on the reference at 10 iterations it is
  // 0.31 m sideways 6 s after the settle, measured 2026-10-26), so matching the
  // reference to 0.1 mm also shows the GPU applies the floor. 12 cubes of
  // 0.5 m plaster, settled with a 0.1 mm lean, then 6 s.
  const leaning = (k: number): BodyDesc => ({
    shape: { kind: 'box', half: [0.25, 0.25, 0.25] }, pos: [1e-5 * k, 0.25 + 0.5 * k, 0], rot: [0, 0, 0, 1],
    linVel: [0, 0, 0], angVel: [0, 0, 0], density: 250, friction: 0.6, restitution: 0.05, tag: 0,
  });
  it('a 12-cube column, settled with a lean, stands for 6 s, matching the reference', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const column: SceneDesc = { ...sceneOf(Array.from({ length: 12 }, (_, k) => leaning(k))), frictionCombine: 'min' };
    const g = await runGpu(column, 450, {}, 30);
    const p0 = g.snaps.find((s) => s.step === 90)!.pos;
    let side = 0;
    for (const s of g.snaps.filter((x) => x.step >= 90))
      for (let b = 0; b < 12; b++) side = Math.max(side, Math.hypot(s.pos[3 * b]! - p0[3 * b]!, s.pos[3 * b + 2]! - p0[3 * b + 2]!));
    expect(side).toBeLessThan(1e-3);
    const ref = await runRef(column, 450);
    let worst = 0;
    for (let k = 0; k < ref.pos.length; k++) worst = Math.max(worst, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(worst).toBeLessThan(1e-4);
  });

  it('a 100:1 mass ratio stack holds', async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S9', { H: 10, ratio: 100 }, 1);
    const g = await runGpu(scene, 300);
    expect(nonFinite(g.s1)).toBe(0);
    expect(survival(scene.bodies, g.s0, g.s1, [0, 1])).toBeGreaterThan(0.99);
    expect(penetration(scene.bodies, g.s1, 0).max).toBeLessThan(0.01);
  });

  it('a ball knocks a slender tower down, impacts as shallow as the reference', async (ctx) => {
    if (!gpu) return ctx.skip();
    // One collapse's deepest transient is set by a single tumbling cube and
    // varies 4x between nearby ball speeds, so penetration is compared with
    // the reference as statistics over 5 speeds, sampled every 10 steps
    // (2026-10-25, after the friction fix: mean 0.0067 GPU vs 0.0075
    // reference; median of the per-run sampled maxima 0.015 vs 0.011. Over
    // every step the reference's median maximum is 0.053, Rapier's 0.14 at
    // speed 15).
    const knock = async (speed: number) => {
      const scene = buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
      const bodies = bodiesAt(scene, 1);
      const g = await runGpu(scene, 181, {}, 10);
      const e = new AvbdReferenceEngine();
      await e.init(scene);
      const gp: number[] = [], rp: number[] = [];
      for (let i = 1; i <= 181; i++) {
        e.step();
        const k = g.snaps.findIndex((s) => s.step === i);
        if (k < 1) continue;
        gp.push(penetration(bodies, g.all[k]!, 0).max);
        rp.push(penetration(bodies, e.snapshot(), 0).max);
      }
      return { scene, bodies, g, gp, rp };
    };
    const runs = [];
    for (const speed of [13, 14, 15, 16, 17]) runs.push(await knock(speed));
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const median = (x: number[]) => [...x].sort((a, b) => a - b)[x.length >> 1]!;
    const max = (x: number[]) => x.reduce((a, b) => Math.max(a, b), 0);
    // The outcome is chaotic too (a nudge flips the ball's rebound in a few
    // percent of runs), so it is a median as well. 2026-10-25, after the
    // friction fix: survival 0.22-0.31 (median 0.23; reference 0.18-0.28,
    // median 0.22), ball vx -4.2 to -2.1 (median -3.4; reference -4.4 to
    // -1.6, median -3.1).
    for (const { g } of runs) expect(nonFinite(g.s1)).toBe(0);
    expect(median(runs.map(({ bodies, g }) => survival(bodies, g.all[1]!, g.s1, [0])))).toBeLessThan(0.5);
    expect(median(runs.map(({ bodies, g }) => g.s1.linVel[3 * (bodies.length - 1)]!))).toBeLessThan(-1);
    const gMean = mean(runs.flatMap((r) => r.gp)), rMean = mean(runs.flatMap((r) => r.rp));
    // Two reference runs re-rolled by f32-sized jitter (1e-6 m on every
    // position) differ by this ratio within 0.72-1.39 in 99.9% of bootstrap
    // draws (2026-10-25, after the friction fix, 12 re-rolls per speed), so
    // wider means a real difference; the GPU's was 0.90. (Jitter of 1e-12 no
    // longer changes 4 of the 5 runs at all.)
    expect(gMean / rMean).toBeGreaterThan(0.7);
    expect(gMean / rMean).toBeLessThan(1.4);
    expect(median(runs.map((r) => max(r.gp)))).toBeLessThan(0.08);
  }, 300_000);

  it('pair history: each persisting pair finds last step\'s slot and SAT axis, new pairs find none', async (ctx) => {
    if (!gpu) return ctx.skip();
    const knock = (fireStep: number) => buildScenario('S5', { N: 48, F: 2, H: 12, fireStep, speed: 15, massRatio: 5, radius: 0.6 }, 1);
    const ok = (r: Awaited<ReturnType<D['pairHistory']>>) => {
      expect(r.error).toBeNull();
      expect(r.wrong).toBe(0);
      expect(r.missed).toBe(0);
      // A mismatch is f32 rounding (a tie) when the GPU's axis is the one a comparison within AXIS_TIE
      // of its bar would flip the reference to (axisSlack). 2026-10-25, after the friction fix changed
      // the collapse: 1 tie in its 12.4k checks (slack 4.5e-8 m, axis 1 against 4), none in the other runs.
      expect(r.axisMismatch, JSON.stringify(r.examples)).toBe(0);
      expect(r.axisTies, JSON.stringify(r.examples)).toBeLessThan(1e-3 * r.checked);
      expect(r.presenceMismatch, JSON.stringify(r.examples)).toBeLessThan(1e-3 * r.checked);
    };
    // A collapse, so pairs appear, vanish and change slots between steps.
    // 2026-10-25, after the friction fix: 12.3k pairs found, 254 where the
    // hint changed the reference's axis; the narrowphase agreed on all but the tie.
    const collapse = await call('pairHistory', knock(0), 60);
    ok(collapse);
    expect(collapse.found).toBeGreaterThan(5000);
    expect(collapse.axes).toBeGreaterThan(3000);
    expect(collapse.hinted).toBeGreaterThan(50);
    // The ball spawned mid-run, 0.2 m from the tower so it has (speculative)
    // pairs in its first step: those are new, the tower's keep their history.
    const late = knock(30);
    late.inputs[0]!.body.pos[0] += 3.8;
    const spawn = await call('pairHistory', late, 60);
    ok(spawn);
    expect(spawn.found).toBeGreaterThan(5000);
    expect(spawn.spawnPairs).toBeGreaterThan(0);
    // Pair buffer too small every step (3 per body): only written pairs have history, and no slot is out of range.
    const overflow = await call('pairHistory', knock(0), 60, { pairsPerBody: 3 });
    ok(overflow);
    expect(overflow.overflowSteps).toBe(60);
    expect(overflow.found).toBeGreaterThan(1000);
  }, 180_000);

  // init() awaits the GPU's error scopes after building its stages. A call in
  // that window must fail as before init(), not step the new, empty buffers
  // with the previous scene's body count, pending inputs and step index (and
  // advance the solver's contact history with that garbage step). A dispose()
  // or a second init() in that window wins; the overtaken init() rejects
  // rather than install its stages over the newer ones.
  it('step(), push() and probeParts() during init() throw init() first, an overtaken init() rejects, and neither leaves anything behind', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const first = buildScenario('S11', { N: 40 }, 3);
    first.inputs = [{ step: 1000, kind: 'spawn', body: cube([20, 0.5, 20]) }];
    const r = await call('callsDuringInit', first, buildScenario('S11', { N: 60 }, 7), 20);
    expect([r.error, r.uncaptured]).toEqual([null, []]);
    for (const k of [0, 1]) {
      expect(r.calls[k]!.length).toBeGreaterThanOrEqual(3);
      expect(r.calls[k]!.filter((c) => !c.endsWith(': init() first'))).toEqual([]);
    }
    const overtaken = 'GpuAvbdEngine: init() was overtaken by dispose() or another init() before it finished';
    expect(r.overtaken).toEqual({ disposed: overtaken, superseded: overtaken, last: 'resolved' });
    expect(r.count).toBe(60);
    expect(r.after).toEqual(r.clean);
    expect(r.reinit).toEqual(r.clean);
  });

  it('init() names the buffer that does not fit the device instead of failing validation later', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('initError', buildScenario('S9', { H: 10, ratio: 1 }, 1), 1e6);
    // Checked before anything is allocated: the contact buffer is the largest.
    expect(r.message).toMatch(/^avbd contacts: \d+ bytes exceeds the device's \d+-byte storage binding limit$/);
    expect(r.validation).toBeNull();
  });

  it('push() during a run replays exactly as the same events in scene.inputs', async (ctx) => {
    if (!gpu) return ctx.skip();
    // An init-time input (step 30) lands after the pushed ones: pushes merge into the scene's queue.
    const r = await call('pushReplay', 40);
    expect(r.error).toBeNull();
    expect(r.live.count).toBe(r.n + 4);
    expect(r.live.pos).toEqual(r.replay.pos);
    expect(r.live.rot).toEqual(r.replay.rot);
    const n = r.n;
    expect([0, 1, 2, 3].map((k) => Math.round(r.live.pos[3 * (n + k)]!))).toEqual([-10, 10, 20, 0]);
    expect(r.rejected.capacity.message).toMatch(/capacity is \d+/);
    expect(r.rejected.radius.message).toMatch(/radius 2 exceeds/);
    expect(r.rejected.noRoom.message).toMatch(/capacity is \d+/);
    // A rejected batch queues nothing: no body spawns at step 5.
    for (const k of ['capacity', 'radius', 'noRoom', 'spare'] as const) expect(r.rejected[k].count).toBe(n);
    expect(r.rejected.spare.message).toMatch(new RegExp(`capacity is ${n + 2}\\b`));
    expect(r.rejected.spareFits).toEqual({ message: null, count: n + 3 });
  });

  it('is bit-for-bit deterministic', async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 200 }, 7);
    const a = await runGpu(scene, 90), b = await runGpu(scene, 90);
    expect([...a.s1.pos]).toEqual([...b.s1.pos]);
    expect([...a.s1.rot]).toEqual([...b.s1.rot]);
  });
});

describe('GPU AVBD engine: primal dispatch (direct colours and the one-workgroup tail)', () => {
  // Colours below colorTail get a dispatch each; the rest are solved in order
  // by one workgroup. A colour's bodies share no contact, so who solves which
  // body must not change a bit of the result.
  const state = (r: { s1: Snapshot }) => [r.s1.pos, r.s1.rot, r.s1.linVel, r.s1.angVel].map((a) => [...a]);
  // Few iterations and steps: on SwiftShader the cost is dispatches, and
  // bit-identity holds at any iteration count.
  const params = { iterations: 4 };
  const run = (scene: SceneDesc, steps: number, opts: Omit<GpuEngineOptions, 'device'>, every = 0) =>
    call('simulateGpu', scene, steps, params, every, opts);
  // A ball into two 2x2x8 towers: contacts from the first step, and colours
  // that change as they fall.
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

  it('every split between direct colours and the tail gives the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = knock();
    const base = await runGpu(scene, 16, params, 4);
    expect(base.maxColors).toBeGreaterThan(2); // so colorTail = 2 puts colours with bodies in the tail
    // Then every colour in the tail, at its largest size, and the serial
    // sweep: every colour in the tail, one thread.
    for (const opts of [{ indirectColors: true }, { colorTail: 0 }, { colorTail: 2 }, { colorTail: 63 }, { colorTail: 0, tailThreads: 256 }, { colorTail: 0, tailThreads: 1 }]) {
      const r = await run(scene, 16, opts);
      expect(r.error).toBeNull();
      expect(state({ ...base, s1: toSnap(r.snaps.at(-1)!) }), JSON.stringify(opts)).toEqual(state(base));
    }
  });

  it('the tail solves a colour larger than its workgroup, every body of it', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // 600 cubes, barely touching yet, in so few colours that every step has
    // one of more than 256 bodies (at least 600 / colours), which the tail
    // (64 threads by default, 256 at most) takes in strides. Colours are read
    // after every step.
    const scene = buildScenario('S11', { N: 600 }, 3);
    const a = await runGpu(scene, 10, params, 1);
    expect(600 / a.maxColors).toBeGreaterThan(256);
    for (const opts of [{ colorTail: 0 }, { colorTail: 0, tailThreads: 1 }]) {
      const b = await run(scene, 10, opts);
      expect(b.error).toBeNull();
      expect(state({ ...a, s1: toSnap(b.snaps.at(-1)!) }), JSON.stringify(opts)).toEqual(state(a));
    }
  });

  it('uncoloured bodies, which may touch, are solved one after another, the same on every split', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // Two colouring rounds leave most bodies uncoloured (51 of 65 here); they
    // all go to the last colour, which one thread of the tail solves in order.
    // The serial sweep is the oracle: solving that colour with the whole
    // workgroup races where its bodies touch, and no longer matches it.
    const scene = knock();
    const s = [];
    for (const opts of [{ colorTail: 0, tailThreads: 1 }, {}, { colorTail: 0 }, { indirectColors: true }]) {
      const r = await run(scene, 16, { ...opts, colorRounds: 2 }, 4);
      expect(r.error).toBeNull();
      expect(r.worst.uncolored, JSON.stringify(opts)).toBeGreaterThan(0);
      s.push(toSnap(r.snaps.at(-1)!));
    }
    for (const other of s.slice(1)) expect(state({ s1: other })).toEqual(state({ s1: s[0]! }));
    expect(nonFinite(s[0]!)).toBe(0);
    // Every split skipping that colour would agree too, so check that it is
    // solved at all: against the fully coloured sweep, the other colour order
    // moves the towers by 0.7 mm; leaving the colour out, by about 0.35 m.
    const full = await run(scene, 16, {});
    expect(full.error).toBeNull();
    const f = full.snaps.at(-1)!.pos;
    expect(Math.max(...s[0]!.pos.map((v, i) => Math.abs(v - f[i]!)))).toBeLessThan(5e-3);
  });

  it('dispatches each colour below colorTail directly, and the rest in one dispatch', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 200 }, 7);
    for (const iterations of [3, 6]) {
      const def = await call('dispatchCounts', scene, { iterations }, {});
      const old = await call('dispatchCounts', scene, { iterations }, { indirectColors: true });
      const tail0 = await call('dispatchCounts', scene, { iterations }, { colorTail: 0 });
      const tail3 = await call('dispatchCounts', scene, { iterations }, { colorTail: 3 });
      expect([def.error, old.error, tail0.error, tail3.error]).toEqual([null, null, null, null]);
      const sweeps = iterations + 1;
      // Indirect, outside the primal: match, narrowphase pairs, degree, fill, pair setup, and the dual per iteration.
      for (const r of [def, tail0, tail3]) expect(r.indirect).toBe(iterations + 5);
      expect(old.indirect).toBe(iterations + 5 + 63 * sweeps);
      // Per sweep: colorTail direct colours + the tail; indirectColors and colorTail 0 have the tail alone.
      expect(old.direct).toBe(tail0.direct);
      expect(tail3.direct - tail0.direct).toBe(3 * sweeps);
      expect(def.direct - tail0.direct).toBe(8 * sweeps);
      expect(def.direct + def.indirect).toBe(old.direct + old.indirect - 55 * sweeps);
    }
  });
  it('(e) the tail is 256 threads on a hardware GPU and 64 on a software adapter, unless set', async () => {
    expect([defaultTailThreads(false), defaultTailThreads(true)]).toEqual([256, 64]);
    const scene = buildScenario('S11', { N: 50 }, 7);
    const def = await call('dispatchPlan', scene, {});
    expect(def.before).toBeNull();
    expect(def.software).not.toBeNull();
    expect(def.dispatch).toEqual({ colorTail: 8, indirectColors: false, tailThreads: def.software ? 64 : 256, hessian: 'registers' });
    // The tests run on SwiftShader unless a real GPU is present; it must count as software.
    if (/swiftshader/i.test(def.adapter ?? '')) expect(def.software).toBe(true);
    const set = await call('dispatchPlan', scene, { tailThreads: 32, colorTail: 3, indirectColors: true, hessian: 'array' });
    expect(set.dispatch).toEqual({ colorTail: 3, indirectColors: true, tailThreads: 32, hessian: 'array' });
  });
});

describe('GPU AVBD engine: primal hessian form (named registers against the private array)', () => {
  // hessian 'registers' (plan step 2b) holds each body's 6x6 system in named
  // scalars, unrolled; 'array' is the earlier private-array form. The register
  // form does the array form's floating-point operations in the same order
  // (registerSolveBody in solver.ts), so where the compiler does not contract
  // or reassociate one differently, the two agree bit for bit: on SwiftShader
  // they do, every scene here, at every step compared.
  const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
  const same = async (scene: SceneDesc, steps: number, params: Partial<{ iterations: number }>, opts: Omit<GpuEngineOptions, 'device' | 'hessian'> = {}, every = 0) => {
    const [a, r] = [await call('simulateGpu', scene, steps, params, every, { ...opts, hessian: 'array' }), await call('simulateGpu', scene, steps, params, every, { ...opts, hessian: 'registers' })];
    expect([a.error, r.error]).toEqual([null, null]);
    expect(r.snaps.length).toBe(a.snaps.length);
    a.snaps.forEach((s, k) => expect(state(r.snaps[k]!), `step ${s.step}`).toEqual(state(s)));
    const last = toSnap(r.snaps.at(-1)!);
    expect(nonFinite(last)).toBe(0);
    // Contacts acted, so the comparison is not of free flight: bodies held up, falling at under half the free-fall speed.
    let held = 0;
    for (let i = 0; i < last.count; i++) if (last.linVel[3 * i + 1]! > -0.5 * G * steps * scene.dt) held++;
    expect(held).toBeGreaterThanOrEqual(10);
    return { a, r };
  };
  const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);
  const sphere = (pos: Vec3, radius: number, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ ...cube(pos, linVel), shape: { kind: 'sphere', radius } });

  // The ball reaches the towers at about step 17.
  it('two 2x2x8 towers and a ball: the same state, bit for bit, every 4 steps', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(knock(), 24, {}, {}, 4);
  });

  it('S11, 300 loose cubes landing: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(buildScenario('S11', { N: 300 }, 7), 40, {});
  });

  it('S5, a small city hit by a ball: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S5', { N: 150, F: 3, H: 6, street: 2, fireStep: 0, radius: 0.8, speed: 15 }, 1);
    await same(scene, 30, {});
  });

  it('spheres on boxes, on each other and rolling into a box: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = sceneOf([
      cube([-1.2, 0.5, 0]), cube([0, 0.5, 0]), cube([1.2, 0.5, 0]),
      sphere([-1.2, 1.4, 0], 0.4), sphere([0, 1.4, 0], 0.4, [0.5, 0, 0.2]), sphere([1.2, 1.4, 0], 0.4),
      // Three touching spheres on the ground and one resting on them (just above, it drops into contact).
      sphere([3, 0.5, 0], 0.5), sphere([4, 0.5, 0], 0.5), sphere([3.5, 0.5, 0.866], 0.5), sphere([3.5, 1.32, 0.289], 0.5),
      sphere([-4.5, 0.5, 0], 0.5, [3, 0, 0.3]), cube([-3, 0.5, 0]),
    ]);
    await same(scene, 60, {}, {}, 20);
  });

  it('20 iterations: the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await same(knock(), 20, { iterations: 20 });
  });

  it('every colour in the tail, uncoloured bodies included (primalTail): the same state, bit for bit', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const { r } = await same(knock(), 24, { iterations: 4 }, { colorTail: 0, colorRounds: 2 });
    expect(r.worst.uncolored).toBeGreaterThan(0);
  });

  // One primal dispatch of the solve kernel on 2048 synthetic bodies with up
  // to 16 contact points each (page.ts primalKernel): random poses, normals
  // (a quarter axis-aligned, so the Jacobian has exact and signed zeros),
  // lever arms, forces, and stiffnesses (15% zero).
  //
  // Bodies 0 and 1 are built so that skipping a zero-stiffness row, as both
  // forms must, is visible. Negative inertia at the identity rotation seeds
  // the rotational block's off-diagonal entries with -0 (I[1][0] = -0 + -0 +
  // -0), and one ground contact has kN = kT = 0. Skipped, entry (4, 3) stays
  // -0, so l43 = -0 / d3 = +0 (d3 < 0), x3 = y3 - l43 x4 - l53 x5 = -0 with
  // y3 = +0 / d3 = -0, and phi.x = -0 - x3 = +0. A row with J[4] = 1 and
  // J[3] = 0 (u = x, lever arm (1, 1, 1)) added as (0 J[4]) J[3] = +0
  // instead turns the entry +0, x3 = +0 and phi.x = -0. That row is body 0's
  // first tangent (n = y, t1 = x) and body 1's normal (n = x, t1 = y); every
  // other row of the two adds -0, which leaves the entry as it is.
  it('the solve kernel on random systems: the two forms agree bit for bit, a skipped zero-stiffness row included', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const [a, r] = [await call('primalKernel', 'array', 2048, 5), await call('primalKernel', 'registers', 2048, 5)];
    expect([a.error, r.error]).toEqual([null, null]);
    expect(a.points).toBeGreaterThan(10_000);
    expect(a.zeroRows).toBeGreaterThan(1000);
    expect(a.changed).toBeGreaterThan(0.95 * a.bits.length);
    expect(a.nonFinite).toBe(0);
    let differ = 0;
    for (let k = 0; k < a.bits.length; k++) if (a.bits[k] !== r.bits[k]) differ++;
    expect(differ).toBe(0);
    // Bodies 0 and 1: phi.x is +0 (bits 0), not -0 (0x80000000).
    expect([a.bits[3], r.bits[3], a.bits[9], r.bits[9]]).toEqual([0, 0, 0, 0]);
  });

  it('the option reaches the shader: registers by default, two different modules, and the array form is the private-array code', async (ctx) => {
    expect(HESSIAN_FORMS).toEqual(['registers', 'array']);
    const reg = solveWgsl('registers'), arr = solveWgsl('array');
    expect(arr).toContain('var<private> lhs: array<f32, 36>;');
    expect(arr).toContain('fn accumulate(ct: SolverContact, i: u32)');
    const code = (wgsl: string) => wgsl.replace(/\/\/.*$/gm, '');
    for (const name of ['lhs', 'rhs', 'accumulate', 'var<private>', 'array<f32, 36>']) expect(code(reg)).not.toContain(name);
    expect(reg).toContain('h43 += k4 * J1[3];');
    expect(() => solveWgsl('matrix' as never)).toThrow(/hessian must be one of registers, array, got matrix/);
    expect(() => new GpuAvbdEngine({}, { hessian: 'matrix' as never })).toThrow("GpuEngineOptions.hessian must be one of registers, array, got matrix");
    expect(new GpuAvbdEngine({}, { hessian: 'array' }).info.variant).toMatchObject({ hessian: 'array' });
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 50 }, 7);
    const def = await call('solveShader', scene, {});
    expect(def.dispatch!.hessian).toBe('registers');
    expect(def.codes).toEqual([reg]);
    const set = await call('solveShader', scene, { hessian: 'array' });
    expect(set.dispatch!.hessian).toBe('array');
    expect(set.codes).toEqual([arr]);
  });

  it('init() fails, naming the error, when a solve pipeline cannot be built (on Metal: too many registers for the tail workgroup)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('solvePipelineFailure', buildScenario('S11', { N: 50 }, 7));
    expect(r.maxInvocations).toBeLessThan(512);
    expect(r.message).toMatch(/^GpuAvbdEngine: init\(\) could not build the GPU pipelines \(hessian registers, tailThreads 256\): /);
    expect(r.message).toMatch(/primalTail/);
    // Nothing is left half-built: step() needs a new init(), which works once the shader does.
    expect(r.stepAfter).toBe('init() first');
    expect(r.healthy).toBe('resolved');
    expect(r.uncaptured).toEqual([]);
  });
});

describe('GPU AVBD engine: walls and columns fall as rigid bodies do (S12, S13)', () => {
  // The cases of physics-ref/test/collapse.test.ts, which says why, at the
  // default 10 iterations, plus agreement with the reference run. The
  // reference also covers 20 iterations; on SwiftShader each S13 case here
  // takes 17-27 s on the dev VM, so the GPU runs only the shipping default.
  it('S12: the cubes above a hole in a stack-bond wall fall freely, and the rest of the wall stays', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S12', {}, 1), steps = 30;
    const above = aboveHole(scene);
    expect(above).toHaveLength(18);
    const g = await runGpu(scene, steps);
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      expect((scene.bodies[i]!.pos[1] - g.s1.pos[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free)).toBeGreaterThan(0.99);
    }
    let worst = 0;
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(g.s1.pos[3 * i]! - b.pos[0], g.s1.pos[3 * i + 1]! - b.pos[1], g.s1.pos[3 * i + 2]! - b.pos[2]));
    });
    expect(worst).toBeLessThan(0.03);
    const ref = await runRef(scene, steps);
    let diff = 0;
    for (let k = 0; k < ref.pos.length; k++) diff = Math.max(diff, Math.abs(ref.pos[k]! - g.s1.pos[k]!));
    expect(diff).toBeLessThan(1e-3);
  });

  const column = async (deg: number, steps: number, iterations: number) => {
    const H = 20, scene = buildScenario('S13', { H, deg }, 1);
    const g = await runGpu(scene, steps, { iterations }, 5);
    const e = new AvbdReferenceEngine({ iterations });
    await e.init(scene);
    const ref = [{ t: 0, pos: [...e.snapshot().pos] }];
    for (let i = 1; i <= steps; i++) { e.step(); if (i % 5 === 0 || i === steps) ref.push({ t: i * scene.dt, pos: [...e.snapshot().pos] }); }
    return { H, gpu: readColumn(g.snaps.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H), ref: readColumn(ref, H) };
  };

  it('S13: a 20-cube column leaning 4 deg topples like the rigid column', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(4, 330, 10), rod = rodToppleTime(r.H, 4, 30);
    expect(r.gpu.topple).not.toBeNull();
    expect(Math.abs(r.gpu.topple! / rod - 1)).toBeLessThan(0.12);
    expect(Math.abs(r.gpu.topple! - r.ref.topple!)).toBeLessThan(0.02);
  });

  it('S13: a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column', { timeout: 120_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await column(2, 300, 10), rod = rodRock(r.H, 2);
    expect(r.gpu.upright).not.toBeNull();
    expect(Math.abs(r.gpu.upright! / rod.upright - 1)).toBeLessThan(0.15);
    expect(r.gpu.before).toBeLessThan(tippingAngle(r.H));
    expect(r.gpu.turned).toBe(true);
    expect(r.gpu.farSide / rod.farSide).toBeGreaterThan(0.6);
    expect(r.gpu.farSide / rod.farSide).toBeLessThan(1.02);
    expect(Math.abs(r.gpu.upright! - r.ref.upright!)).toBeLessThan(0.02);
    expect(Math.abs(r.gpu.farSide - r.ref.farSide)).toBeLessThan(0.02);
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

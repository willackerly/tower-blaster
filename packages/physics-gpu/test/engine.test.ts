// The GPU AVBD engine against analytic results and the f64 reference.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type BodyDesc, bodiesAt, emptySnapshot, type SceneDesc, type Snapshot, type Vec3 } from '@tb/engine-api';
import { drift, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { GpuAvbdEngine } from '../src/index.ts';
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
async function runGpu(scene: SceneDesc, steps: number, params = {}, every = 0) {
  const r = await call('simulateGpu', scene, steps, params, every);
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

  // Off-axis error: exact along a face normal (symmetry). At 120 deg the
  // cube yaws slightly while it slides (4 contact points, the tipping
  // balance is not fully converged in 10 iterations): the reference ends
  // 1.2e-3 rad off and yawed 2 deg, the GPU 3.8e-3 rad off, yawed the other
  // way. Per-row friction penalties (the bug this guards against) gave 0.2 rad.
  it.for([[3, 0, 1e-5], [-1.5, 2.598, 6e-3]] as const)('a cube sliding at (%s, %s) stops where Coulomb friction says', async ([vx, vz, offAxis], ctx) => {
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
    // (2026-10-25: mean 0.0074 GPU vs 0.0086 reference; median of the
    // per-run sampled maxima 0.013 vs 0.030. Over every step the reference's
    // median maximum is 0.042, Rapier's 0.14 at speed 15).
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
    // percent of runs), so it is a median as well. 2026-10-25: survival
    // 0.20-0.30 (median 0.23; reference 0.22), ball vx -4.2 to -1.8 (median
    // -2.4; reference -4.3 to -1.1, median -3.4).
    for (const { g } of runs) expect(nonFinite(g.s1)).toBe(0);
    expect(median(runs.map(({ bodies, g }) => survival(bodies, g.all[1]!, g.s1, [0])))).toBeLessThan(0.5);
    expect(median(runs.map(({ bodies, g }) => g.s1.linVel[3 * (bodies.length - 1)]!))).toBeLessThan(-1);
    const gMean = mean(runs.flatMap((r) => r.gp)), rMean = mean(runs.flatMap((r) => r.rp));
    // Two re-rolled reference runs (1e-12 jitter) differ by this ratio within
    // 0.71-1.41 in 99.9% of bootstrap draws (2026-10-25), so wider means a real difference.
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
      expect(r.axisMismatch, JSON.stringify(r.examples)).toBe(0);
      expect(r.presenceMismatch, JSON.stringify(r.examples)).toBeLessThan(1e-3 * r.checked);
    };
    // A collapse, so pairs appear, vanish and change slots between steps.
    // 2026-10-25: 12.4k pairs found, 184 where the hint changed the
    // reference's axis, and the narrowphase agreed on every one.
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
    for (const k of ['capacity', 'radius', 'noRoom'] as const) expect(r.rejected[k].count).toBe(n);
  });

  it('is bit-for-bit deterministic', async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S11', { N: 200 }, 7);
    const a = await runGpu(scene, 90), b = await runGpu(scene, 90);
    expect([...a.s1.pos]).toEqual([...b.s1.pos]);
    expect([...a.s1.rot]).toEqual([...b.s1.rot]);
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

// The GPU AVBD engine on stacks, towers and impacts against the f64 reference
// (the knock-down statistics are in engine-knock.test.ts).
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc, type SpawnEvent } from '@tb/engine-api';
import { drift, jitter, nonFinite, penetration, survival } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { AvbdSolver } from '../src/index.ts';
import { type D, gpu, call, runGpu, runRef, cube, sceneOf } from './harness.ts';

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
      // The broadphase's sticky counters matched the running max and count of every step's own, and
      // diagnostics() reports them over the whole run; a new init() starts them from zero.
      expect(r.stickyWrong).toBe(0);
      expect(r.diagnostics).toMatchObject({ pairsRequired: r.lastRequired, pairsRequiredPeak: r.peak, pairsOverflowSteps: r.overflowSteps, steps: 60 });
      expect(r.reinit).toMatchObject({ pairsRequiredPeak: 0, pairsOverflowSteps: 0, steps: 0 });
      expect(r.reinit5.steps).toBe(5);
      expect(r.reinit5.pairsRequiredPeak).toBeGreaterThan(0);
    };
    // A collapse, so pairs appear, vanish and change slots between steps.
    // 2026-10-25, after the friction fix: 12.3k pairs found, 254 where the
    // hint changed the reference's axis; the narrowphase agreed on all but the tie.
    const collapse = await call('pairHistory', knock(0), 60);
    ok(collapse);
    expect(collapse.found).toBeGreaterThan(5000);
    // The collapse needs fewer pairs on some steps than before them (so a counter that kept the last count
    // would differ from the peak), and never more than the buffer holds.
    expect(collapse.peakDrops).toBeGreaterThan(0);
    expect(collapse.lastRequired).toBeLessThan(collapse.peak); // so the peak is not the last step's word
    expect(collapse.overflowSteps).toBe(0);
    expect(collapse.diagnostics.pairsRequiredPeak).toBeLessThanOrEqual(collapse.diagnostics.maxPairs);
    expect(collapse.axes).toBeGreaterThan(3000);
    expect(collapse.hinted).toBeGreaterThan(50);
    // The ball spawned mid-run, 0.2 m from the tower so it has (speculative)
    // pairs in its first step: those are new, the tower's keep their history.
    const late = knock(30);
    (late.inputs[0] as SpawnEvent).body.pos[0] += 3.8;
    const spawn = await call('pairHistory', late, 60);
    ok(spawn);
    expect(spawn.found).toBeGreaterThan(5000);
    expect(spawn.spawnPairs).toBeGreaterThan(0);
    // Pair buffer too small every step (3 per body): only written pairs have history, and no slot is out of range.
    const overflow = await call('pairHistory', knock(0), 60, { pairsPerBody: 3 });
    ok(overflow);
    expect(overflow.overflowSteps).toBe(60);
    expect(overflow.diagnostics.pairsRequiredPeak).toBeGreaterThan(overflow.diagnostics.maxPairs);
    expect(overflow.reinit5.pairsOverflowSteps).toBe(5);
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
    const scene = buildScenario('S9', { H: 10, ratio: 1 }, 1), n = scene.bodies.length + scene.inputs.length;
    // A pair buffer one indirect dispatch cannot cover is refused first (its kernels would run nothing at all).
    const over = await call('initError', scene, 1e6);
    const limit = over.limits.maxComputeWorkgroupsPerDimension;
    expect(over.message).toBe(`GpuAvbdEngine: ${1e6 * n} pair slots exceed the ${64 * limit} one indirect dispatch covers (64 x maxComputeWorkgroupsPerDimension ${limit}); lower pairsPerBody or capacity`);
    expect(over.validation).toBeNull();
    // Within the dispatch, a contact buffer past the device's limit: the largest buffer, checked before anything is
    // allocated. Room for 4M bodies at one pair slot each is 2 x 8M x 384 B = 6.1 GB at records 1, past any device's.
    const capacity = 4e6;
    expect(AvbdSolver.contactBytes(capacity, capacity, 1)).toBeGreaterThan(Math.min(over.limits.maxStorageBufferBindingSize, over.limits.maxBufferSize));
    const r = await call('initError', scene, 1, capacity);
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

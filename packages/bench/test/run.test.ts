import { describe, expect, it } from 'vitest';
import { emptySnapshot, type PhysicsEngine, type SceneDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { RapierEngine } from '@tb/adapter-rapier';
import { compareBlocks, gpuEngineArgs, makeEngine, parseSpec, qualityGates, qualityRun, SlowedEngine, slowdownArms, timeInterleaved, timingSummary } from '../src/index.ts';

/** An engine whose step "takes" cost(step) ms on a fake clock, and logs its order. */
function fakeEngine(name: string, clock: { t: number }, cost: (step: number) => number, log: string[]): PhysicsEngine {
  let stepIndex = 0;
  return {
    info: { name, variant: {}, backend: 'fake' },
    get stepIndex() { return stepIndex; },
    async init() { stepIndex = 0; },
    push() {},
    step() { clock.t += cost(stepIndex); log.push(name); stepIndex++; },
    snapshot: () => emptySnapshot(0),
    dispose() {},
  };
}

/**
 * A fake GPU engine on a fake clock. step() spends `cpu` ms of host time and
 * queues `gpu` ms of work on its own queue; the GPU runs every queue's work in
 * submission order, so engines given the same `gpu` timeline wait behind each
 * other. finish() resolves in a later task, as onSubmittedWorkDone does, once
 * this engine's own work is done.
 */
function fakeGpuEngine(clock: { t: number }, cpu: number, gpu: number, device = { busyUntil: 0 }): PhysicsEngine {
  let stepIndex = 0, doneAt = 0;
  return {
    info: { name: 'gpu', variant: {}, backend: 'fake-gpu' },
    get stepIndex() { return stepIndex; },
    async init() { stepIndex = 0; },
    push() {},
    step() {
      clock.t += cpu;
      doneAt = device.busyUntil = Math.max(device.busyUntil, clock.t) + gpu;
      stepIndex++;
      return { gpuMs: gpu };
    },
    finish() {
      const until = doneAt;
      return new Promise<void>((resolve) => setTimeout(() => { clock.t = Math.max(clock.t, until); resolve(); }, 0));
    },
    snapshot: () => emptySnapshot(0),
    dispose() {},
  };
}

const tiny: SceneDesc = buildScenario('S1', { F: 1, H: 1 });

describe('timeInterleaved', () => {
  it('measures per-step time and alternates which engine goes first', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const a = fakeEngine('A', clock, () => 2, log), b = fakeEngine('B', clock, () => 3, log);
    const [ta, tb] = await timeInterleaved([a, b], tiny, { warmup: 1, blockSteps: 2, blocks: 3, clock: () => clock.t });
    expect(ta!.map((x) => x.median)).toEqual([2, 2, 2]);
    expect(tb!.map((x) => x.median)).toEqual([3, 3, 3]);
    // warmup A, B; then blocks A A B B | B B A A | A A B B
    expect(log.join('')).toBe('AB' + 'AABB' + 'BBAA' + 'AABB');
    expect(timingSummary(ta!).wallMs.median).toBe(2);
    // Latency mode is the default: one sample per step.
    expect(timingSummary(ta!).mode).toBe('latency');
    expect(ta![0]!.samples).toHaveLength(2);
  });

  it('pairs blocks by simulated phase, so a workload that changes over time compares fairly', async () => {
    const clock = { t: 0 }, log: string[] = [];
    // Cost falls over the run (e.g. bodies going to sleep); B is 10% cheaper at every step.
    const a = fakeEngine('A', clock, (s) => 100 / (1 + s), log);
    const b = fakeEngine('B', clock, (s) => 90 / (1 + s), log);
    const [ta, tb] = await timeInterleaved([a, b], tiny, { warmup: 0, blockSteps: 5, blocks: 8, clock: () => clock.t });
    const cmp = compareBlocks(ta!, tb!);
    expect(cmp.verdict).toBe('faster');
    expect(cmp.diff.estimate).toBeCloseTo(-0.1, 9);
  });
});

describe('timing modes for engines that submit work and return (finish())', () => {
  const run = async (e: PhysicsEngine, clock: { t: number }, mode: 'latency' | 'throughput', warmup = 0) =>
    (await timeInterleaved([e], tiny, { warmup, blockSteps: 10, blocks: 3, mode, clock: () => clock.t }))[0]!;

  it('latency: every step is charged its host time plus its device time', async () => {
    const clock = { t: 0 };
    const blocks = await run(fakeGpuEngine(clock, 1, 4), clock, 'latency');
    expect(blocks.flatMap((b) => b.samples)).toEqual(Array(30).fill(5));
  });

  it('throughput: a block overlaps host and device work, costing max(cpu, gpu) + min(cpu, gpu) / steps per step', async () => {
    for (const [cpu, gpu] of [[1, 4], [4, 1]] as const) {
      const clock = { t: 0 };
      const blocks = await run(fakeGpuEngine(clock, cpu, gpu), clock, 'throughput');
      expect(blocks.map((b) => [b.samples.length, b.steps, b.median])).toEqual(Array(3).fill([1, 10, 4.1]));
      // One sample per block can't show drift within it, so it is reported as unchecked.
      expect(timingSummary(blocks)).toMatchObject({ mode: 'throughput', blocks: 3, stepsPerBlock: 10, driftSuspectBlocks: null });
    }
  });

  it('device work queued in warmup or an earlier block is never charged to a block', async () => {
    // 50 warmup steps leave 150 ms of device work queued.
    for (const mode of ['latency', 'throughput'] as const) {
      const clock = { t: 0 };
      const blocks = await run(fakeGpuEngine(clock, 1, 4), clock, mode, 50);
      expect(blocks[0]!.samples[0]).toBe(mode === 'latency' ? 5 : 4.1);
    }
  });

  it('work another engine queued on the same GPU is never charged to a block', async () => {
    // Two GPU engines with their own queues on one GPU; each warmup leaves 150 ms queued.
    for (const mode of ['latency', 'throughput'] as const) {
      const clock = { t: 0 }, gpu = { busyUntil: 0 };
      const engines = [fakeGpuEngine(clock, 1, 4, gpu), fakeGpuEngine(clock, 1, 4, gpu)];
      const blocks = await timeInterleaved(engines, tiny, { warmup: 50, blockSteps: 10, blocks: 3, mode, clock: () => clock.t });
      for (const b of blocks.flat()) expect(b.samples).toEqual(mode === 'latency' ? Array(10).fill(5) : [4.1]);
    }
  });

  it('collects reported GPU time from every step in both modes', async () => {
    for (const mode of ['latency', 'throughput'] as const) {
      const clock = { t: 0 };
      expect(timingSummary(await run(fakeGpuEngine(clock, 1, 4), clock, mode)).gpuMs).toMatchObject({ n: 30, median: 4 });
    }
  });

  it('awaits an async step() in both modes', async () => {
    for (const mode of ['latency', 'throughput'] as const) {
      const clock = { t: 0 };
      let stepIndex = 0;
      const e: PhysicsEngine = {
        info: { name: 'async', variant: {}, backend: 'fake' },
        get stepIndex() { return stepIndex; },
        async init() { stepIndex = 0; },
        push() {},
        step: () => new Promise<void>((resolve) => setTimeout(() => { clock.t += 2; stepIndex++; resolve(); }, 0)),
        snapshot: () => emptySnapshot(0),
        dispose() {},
      };
      expect((await run(e, clock, mode)).map((b) => b.median)).toEqual([2, 2, 2]);
    }
  });

  it('a device error reported a task after the last step still fails the run', async () => {
    const clock = { t: 0 };
    let failed = false, steps = 0;
    const e: PhysicsEngine = {
      info: { name: 'gpu', variant: {}, backend: 'fake-gpu' },
      get stepIndex() { return steps; },
      async init() { steps = 0; },
      push() {},
      step() { clock.t += 1; if (++steps === 30) setTimeout(() => { failed = true; }, 0); },
      async finish() { if (failed) throw new Error('device error'); },
      snapshot: () => emptySnapshot(0),
      dispose() {},
    };
    await expect(run(e, clock, 'throughput')).rejects.toThrow('device error');
  });

  it('SlowedEngine passes finish() through, and adds none to an engine without it', async () => {
    const clock = { t: 0 };
    const blocks = await run(new SlowedEngine(fakeGpuEngine(clock, 1, 4), 0, () => clock.t), clock, 'latency');
    expect(blocks.flatMap((b) => b.samples)).toEqual(Array(30).fill(5));
    expect(new SlowedEngine(fakeEngine('A', clock, () => 1, []), 0).finish).toBeUndefined();
  });

  it('an engine without finish() gets the same per-step cost in both modes', async () => {
    for (const mode of ['latency', 'throughput'] as const) {
      const clock = { t: 0 };
      const blocks = await run(fakeEngine('A', clock, () => 2, []), clock, mode);
      expect(blocks.map((b) => b.median)).toEqual([2, 2, 2]);
      expect(timingSummary(blocks).mode).toBe(mode);
    }
  });
});

describe('engine registry and SlowedEngine', () => {
  it('parses specs', () => {
    expect(parseSpec('rapier:iterations=8,ccd=true')).toEqual({ name: 'rapier', options: { iterations: 8, ccd: true } });
    expect(() => makeEngine('nope')).toThrow(/unknown engine/);
    expect(makeEngine('rapier:iterations=6').info.variant.iterations).toBe(6);
    expect(makeEngine('avbd-ref:iterations=4,sweep=false').info.variant).toMatchObject({ iterations: 4, sweep: false });
    // Constructing needs no device (init() gets one), so the registry works in Node.
    expect(makeEngine('avbd-gpu:iterations=6').info).toMatchObject({ name: 'avbd-gpu', backend: 'webgpu', variant: { iterations: 6 } });
    // spare is a GpuEngineOptions field (room for pushed bodies), not a solver parameter: the
    // engine checks it (a solver parameter would pass unchecked) and records it in the variant.
    expect(makeEngine('avbd-gpu:iterations=6,spare=8').info.variant).toEqual({ ...makeEngine('avbd-gpu:iterations=6').info.variant, spare: 8 });
    for (const bad of ['-1', '2.5', 'true']) expect(() => makeEngine(`avbd-gpu:spare=${bad}`)).toThrow(/spare must be a non-negative integer/);
    expect(() => makeEngine('avbd-gpu:spare=')).toThrow(/bad engine option/);
    expect(() => makeEngine('avbd-gpu:spare=abc')).toThrow(/bad engine option "spare=abc" .*: spare takes a number, true or false/);
    // The other buffer-sizing options reach the engine too (it checks them, as it would not check a solver parameter).
    expect(makeEngine('avbd-gpu:capacity=100,pairsPerBody=4,maxRadius=2.5').info.variant).toMatchObject({ capacity: 100, pairsPerBody: 4, maxRadius: 2.5 });
    // So do the options that shape the primal dispatch and the colouring.
    expect(makeEngine('avbd-gpu:colorTail=3,indirectColors=true,tailThreads=1,colorRounds=8').info.variant).toMatchObject({ colorTail: 3, indirectColors: true, tailThreads: 1, colorRounds: 8 });
    // And the box broadphase (Kapla planks).
    expect(makeEngine('avbd-gpu:boxBroadphase=true').info.variant).toMatchObject({ boxBroadphase: true });
    for (const [k, bad, what] of [
      ['capacity', '0', 'a positive integer'], ['pairsPerBody', '1.5', 'a positive integer'], ['maxRadius', '-1', 'a finite number >= 0'],
      ['colorTail', '64', 'an integer from 0 to 63'], ['colorRounds', '3', 'an even integer >= 2'], ['indirectColors', '1', 'a boolean'],
      ['tailThreads', '0', 'an integer from 1 to 256'], ['tailThreads', '257', 'an integer from 1 to 256'], ['boxBroadphase', '1', 'a boolean'],
    ] as const) {
      expect(() => makeEngine(`avbd-gpu:${k}=${bad}`)).toThrow(`GpuEngineOptions.${k} must be ${what}`);
    }
    // hessian takes a word: a value that is not a number stays a string, and the engine checks it.
    expect(parseSpec('avbd-gpu:hessian=array,iterations=4')).toEqual({ name: 'avbd-gpu', options: { hessian: 'array', iterations: 4 } });
    expect(makeEngine('avbd-gpu:hessian=array').info.variant).toMatchObject({ hessian: 'array' });
    expect(makeEngine('avbd-gpu:hessian=registers').info.variant).toMatchObject({ hessian: 'registers' });
    expect(makeEngine('avbd-gpu:iterations=6').info.variant.hessian).toBeUndefined();
    for (const bad of ['matrix', 'Array', '1', 'true']) {
      expect(() => makeEngine(`avbd-gpu:hessian=${bad}`)).toThrow(`GpuEngineOptions.hessian must be one of registers, array, got ${bad}`);
    }
    // The fused dual is a solver parameter (the reference has it too), the contacts binding a GpuEngineOptions field;
    // the engine checks both, and records them in the variant only when given.
    expect(makeEngine('avbd-gpu:dualFusion=true,solveContactsRW=true').info.variant).toMatchObject({ dualFusion: true, solveContactsRW: true });
    expect(makeEngine('avbd-ref:dualFusion=true').info.variant).toMatchObject({ dualFusion: true });
    expect(makeEngine('avbd-gpu:iterations=6').info.variant).not.toHaveProperty('dualFusion');
    expect(makeEngine('avbd-gpu:iterations=6').info.variant).not.toHaveProperty('solveContactsRW');
    expect(gpuEngineArgs(parseSpec('avbd-gpu:dualFusion=true,iterations=20,colorTail=4,solveContactsRW=false').options))
      .toEqual({ params: { dualFusion: true, iterations: 20 }, opts: { colorTail: 4, solveContactsRW: false } });
    expect(() => makeEngine('avbd-gpu:dualFusion=1')).toThrow('AvbdParams.dualFusion must be a boolean, got 1');
    expect(() => makeEngine('avbd-gpu:solveContactsRW=1')).toThrow('GpuEngineOptions.solveContactsRW must be a boolean, got 1');
    // records (AvbdParams.records, manifold records) is a solver parameter both AVBD engines take and check; the
    // GPU engine needs the register form for it.
    expect(makeEngine('avbd-gpu:records=1,iterations=20').info.variant).toMatchObject({ records: 1, iterations: 20 });
    expect(makeEngine('avbd-ref:records=2').info.variant).toMatchObject({ records: 2 });
    expect(makeEngine('avbd-gpu:iterations=6').info.variant.records).toBeUndefined();
    // On the GPU unset is records 1 (gpuRecordsLayout), so an explicit records=0 (points) is another engine, named so.
    expect(makeEngine('avbd-gpu:records=0').info.variant).toEqual({ ...makeEngine('avbd-gpu').info.variant, records: 0 });
    expect(makeEngine('avbd-ref:records=0').info.variant).toEqual(makeEngine('avbd-ref').info.variant);
    expect(() => makeEngine('avbd-gpu:records=3')).toThrow('AvbdParams.records must be one of 0, 1, 2, got 3');
    expect(() => makeEngine('avbd-ref:records=3')).toThrow('AvbdParams.records must be one of 0, 1, 2, got 3');
    expect(() => makeEngine('avbd-gpu:records=1,hessian=array')).toThrow('AvbdParams.records 1 needs GpuEngineOptions.hessian registers, got array');
    // Any other option given a word is rejected rather than passed on as a truthy string.
    for (const spec of ['avbd-gpu:sweep=off', 'avbd-ref:slidingHessian=no', 'avbd-gpu:iterations=ten', 'rapier:ccd=yes']) {
      expect(() => parseSpec(spec)).toThrow(/bad engine option .* takes a number, true or false/);
    }
  });

  it('slows each step by the requested fraction', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const inner = fakeEngine('A', clock, () => 10, log);
    // The fake clock only moves when stepping, so spinning must advance it.
    const spinClock = () => (clock.t += 0.001);
    const slowed = new SlowedEngine(inner, 0.1, spinClock);
    await slowed.init(tiny);
    const t0 = clock.t;
    await slowed.step();
    expect(clock.t - t0).toBeGreaterThan(10 * 1.1 - 0.01);
    expect(clock.t - t0).toBeLessThan(10 * 1.1 + 0.01);
    expect(slowed.info.variant.slowed).toBe(0.1);
  });

  it('self-check arms: both wrapped, the baseline spins zero time and the copy the requested fraction', async () => {
    const clock = { t: 0 }, log: string[] = [];
    const spinClock = () => (clock.t += 0.001);
    const arms = slowdownArms(() => fakeEngine('A', clock, () => 10, log), 0.1, spinClock);
    expect(arms.map((e) => e instanceof SlowedEngine)).toEqual([true, true]);
    expect(arms.map((e) => e.info.variant.slowed)).toEqual([0, 0.1]);
    const took: number[] = [];
    for (const e of arms) {
      await e.init(tiny);
      const t0 = clock.t;
      await e.step();
      took.push(clock.t - t0);
    }
    // Three clock reads (start, end, one loop test) and no spinning on the baseline.
    expect(took[0]).toBeCloseTo(10.003, 9);
    expect(took[1]).toBeGreaterThan(10 * 1.1 - 0.01);
    expect(took[1]).toBeLessThan(10 * 1.1 + 0.01);
  });
});

describe('qualityRun on Rapier', () => {
  it('reports a standing, sleeping small tower as passing every gate', async () => {
    const scene = buildScenario('S1', { F: 3, H: 6, gap: 0.02 });
    const q = await qualityRun(new RapierEngine(), scene, { steps: 300, sampleEvery: 30 });
    expect(q.nonFinite).toBe(0);
    expect(q.survival).toBeGreaterThan(0.98);
    expect(q.allAsleepStep).not.toBeNull();
    expect(Object.values(qualityGates(q, true)).filter(Boolean)).toEqual([]);
    expect(q.series.length).toBe(11);
  });

  it('flags a collapse: a staggered column falls and fails survival', async () => {
    const scene = buildScenario('S1', { F: 1, H: 8 });
    // Shift every second cube sideways by 0.6: the column must fall over.
    scene.bodies.forEach((b, i) => { if (i % 2 === 1) b.pos[0] += 0.6; });
    const q = await qualityRun(new RapierEngine(), scene, { steps: 240, sampleEvery: 60 });
    expect(q.survival).toBeLessThan(0.9);
    expect(qualityGates(q, true).survival).toMatch(/survival/);
  });
});

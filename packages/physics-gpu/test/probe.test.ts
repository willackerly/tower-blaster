// The solver probe (pnpm bench:probe) under SwiftShader: every section runs
// in a tiny configuration, and its kernels compute what they claim (CPU
// references, exact barrier results). Timing from here is never a
// performance result; the probe marks it invalid.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { isSoftwareAdapter, loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { type Checkpoint, DEFAULT_PROBE, probeMarkdown, type ProbeOptions } from '../src/probe.ts';
import { probeEngine } from '../src/probe-engine.ts';
import { DEFAULT_DISPATCH } from '../src/solver.ts';
import type * as Drivers from './probe-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./probe-page.ts', import.meta.url)), '__probe');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __probe: Record<string, (...x: unknown[]) => unknown> }).__probe[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

const TINY: Partial<ProbeOptions> = {
  reps: 2, warmup: 1, N: 300, checkpoints: [4, 8], R: 2, solveSteps: 2, hessian: 'array',
  p3Sizes: [32, 64, 96, 128], p3Points: [4, 8], p3Threads: [64, 130], p3Inner: 1, p3Reps: 1,
  barrierRounds: 20, barrierThreads: [64, 256],
  gridGroups: [1, 2, 4], gridRounds: 10, maxPolls: 20_000,
  tileGroups: [2], tileThreads: [64], tileK: [4], tileIters: [1, 2], tilePoints: 4,
};

describe('solver probe defaults', () => {
  it('P2 times the engine\'s default hessian form (registers since plan step 2b) unless --hessian says otherwise', () => {
    expect(DEFAULT_DISPATCH.hessian).toBe('registers');
    expect(DEFAULT_PROBE.hessian).toBe(DEFAULT_DISPATCH.hessian);
  });

  it('--engine takes an avbd-gpu spec as pnpm bench does, checked before the page runs; without it P2 runs the default engine', () => {
    expect(DEFAULT_PROBE).not.toHaveProperty('engine');
    expect(probeEngine('avbd-gpu:iterations=20,dualFusion=true,colorTail=4')).toEqual({
      spec: 'avbd-gpu:iterations=20,dualFusion=true,colorTail=4', params: { iterations: 20, dualFusion: true }, opts: { colorTail: 4 },
    });
    expect(probeEngine('avbd-gpu')).toEqual({ spec: 'avbd-gpu', params: {}, opts: {} });
    expect(() => probeEngine('avbd-ref:iterations=4')).toThrow(/must be avbd-gpu/);
    expect(() => probeEngine('avbd-gpu:dualFusion=1')).toThrow('AvbdParams.dualFusion must be a boolean');
    expect(() => probeEngine('avbd-gpu:colorTail=64')).toThrow('GpuEngineOptions.colorTail must be');
    expect(() => probeEngine('avbd-gpu:sweep=off')).toThrow(/bad engine option/);
    expect(() => probeEngine('avbd-gpu:hessian=array', { hessian: 'registers' })).toThrow('give hessian in the spec or as --hessian, not both');
    expect(probeEngine('avbd-gpu:hessian=array').opts).toEqual({ hessian: 'array' });
    // #58's engine flags add to the spec's options; one given both ways is an error.
    expect(() => probeEngine('avbd-gpu:pairsPerBody=8', { pairsPerBody: 32 })).toThrow('give pairsPerBody in the spec or as --pairs-per-body, not both');
    expect(() => probeEngine('avbd-gpu:boxBroadphase=true', { boxBroadphase: true })).toThrow('give boxBroadphase in the spec or as --box-broadphase, not both');
    expect(probeEngine('avbd-gpu:dualFusion=true', { hessian: 'array', pairsPerBody: 32, boxBroadphase: true }).opts).toEqual({});
    expect(probeEngine('avbd-gpu:boxBroadphase=true', { boxBroadphase: false }).opts).toEqual({ boxBroadphase: true });
  });
});

describe('solver probe hooks', () => {
  it('probeStep() and encodeProbe() leave the trajectory bit-identical to step(), and encodeProbe issues the sweep\'s dispatches', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('probeHooks', buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1), 6, 3);
    expect(r.error).toBeNull();
    // The primal pieces only write dp and phi, which the next step's initBodies overwrites.
    expect(r.b).toEqual(r.a);
    // reps copies of colour 0's dispatch, sized for every body as solve() sizes it; the tail is one workgroup.
    expect(r.direct).toEqual([r.groups, r.groups, r.groups]);
    expect(r.tail).toEqual([1, 1, 1]);
    expect(r.threw).toMatch(/solved serially/);
    if (r.timestamps) for (const t of r.solveMs) expect(t).toBeGreaterThanOrEqual(0);
  });

  it('with the fused dual (side array) too: the primal pieces leave the trajectory bit-identical', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    // They run fused colour dispatches, which write the side array; the next step's first fused sweep rewrites it before reading.
    const r = await call('probeHooks', buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1), 6, 3, { iterations: 4, dualFusion: true });
    expect(r.error).toBeNull();
    expect(r.b).toEqual(r.a);
    expect(r.direct).toEqual([r.groups, r.groups, r.groups]);
  });
});

describe('solver probe P2 with --engine', () => {
  it('times the variant: its iterations and dispatch, one dual pass with the fused dual, and says so', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const engine = probeEngine('avbd-gpu:iterations=3,dualFusion=true,colorTail=4');
    const r = await call('runProbe', { ...TINY, sections: ['p2'], checkpoints: [6], engine });
    expect(r.errors).toEqual([]);
    const p2 = r.p2!;
    expect([p2.engine, p2.dualPasses, p2.iterations]).toEqual([engine.spec, 1, 3]);
    const c = p2.checkpoints[0]!;
    expect(c.colorTail).toBe(4);
    expect(c.direct).toHaveLength(4);
    expect(c.dual).not.toBeNull();
    expect(c.check!.predicted).toBeCloseTo(4 * (c.direct.reduce((s, d) => s + d.t!.median, 0) + c.tail.t!.median) + c.dual!.median, 9);
    const md = probeMarkdown(r, '## test');
    expect(md).toContain(`R=2 dispatches per timed pass, engine ${engine.spec}`);
    expect(md).toContain('+ 1·t_dual');
    expect(md).toContain("the step's 1 dual pass");
  });

  it('reads the records layout (AvbdParams.records): records 1 has the point form\'s structure, read one record per slot', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const run = async (spec: string) => {
      const r = await call('runProbe', { ...TINY, sections: ['p2'], checkpoints: [6], hessian: 'registers', engine: probeEngine(spec) });
      expect(r.errors).toEqual([]);
      return r.p2!.checkpoints[0]!;
    };
    const [pts, rec1, rec2] = [await run('avbd-gpu:iterations=3,records=0'), await run('avbd-gpu:iterations=3,records=1'), await run('avbd-gpu:iterations=3,records=2')];
    // The default (unset) is records 1 (gpuRecordsLayout): its structure and reads are records 1's.
    const def = await run('avbd-gpu:iterations=3');
    // records 1's trajectory is the point form's, bit for bit, so its colours and contacts are too.
    const shape = (c: Checkpoint) => ({
      colours: c.coloursUsed, direct: c.direct.map((d) => [d.bodies, d.W, d.R, d.points]), tail: [c.tail.bodies, c.tail.Wcrit, c.tail.Rcrit, c.tail.points],
      sumW: c.sumW, sumR: c.sumR, totalPoints: c.totalPoints, contactPairs: c.contactPairs,
    });
    expect(shape(rec1)).toEqual(shape(pts));
    expect(shape(def)).toEqual(shape(pts));
    expect(pts.sumR).toBeGreaterThan(0);
    expect(pts.sumR).toBeLessThan(pts.sumW);
    expect(pts.sumW).toBeLessThanOrEqual(4 * pts.sumR);
    // One read per record, against a point form's read per point and the one that ends a partial slot.
    const loads = (c: Checkpoint) => c.direct.reduce((s, d) => s + d.loads, 0);
    expect(loads(rec1)).toBeLessThan(loads(pts));
    expect(loads(def)).toBe(loads(rec1));
    // records 2, on its own trajectory: CentreRecord's count is read at its own stride.
    expect(rec2.totalPoints).toBe(rec2.direct.reduce((s, d) => s + d.points, 0) + rec2.tail.points);
    expect(rec2.sumR).toBeGreaterThan(0);
    expect(rec2.totalPoints).toBeGreaterThan(0.9 * pts.totalPoints);
    expect(rec2.totalPoints).toBeLessThan(1.1 * pts.totalPoints);
  });
});

describe('solver probe on another scenario', () => {
  it('P2 runs S15 (a Kapla tower in plank-width units) with scaled gravity and reports its pairs', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const params = { planks: 120, towers: 1, topple: false };
    const r = await call('runProbe', { ...TINY, sections: ['p2'], scenario: 'S15', params, gravityScale: 42.735, checkpoints: [4] });
    expect(r.errors).toEqual([]);
    expect(r.p2!.scenario).toBe('S15');
    expect(r.p2!.gravityScale).toBe(42.735);
    const c = r.p2!.checkpoints[0]!;
    expect(c.n).toBe(buildScenario('S15', params, 1).bodies.length);
    expect(r.p2!.N).toBe(c.n);
    // Every plank rests on another or on the floor; most rest on two or more.
    expect(c.contactPairs).toBeGreaterThan(c.n / 2);
    expect(c.pairsRequired).toBeGreaterThanOrEqual(c.contactPairs);
    expect(probeMarkdown(r, '## test')).toMatch(/S15 \{"planks":120.*gravity x42.735/);
  });

  it('with --engine too: the scenario flags, --pairs-per-body and --box-broadphase combine with the spec\'s params and options', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const params = { planks: 120, towers: 1, topple: false };
    // Two pair slots per plank are too few for the tower (the run above needs more): the flag reached the engine.
    const engine = probeEngine('avbd-gpu:iterations=3,dualFusion=true,colorTail=4', { pairsPerBody: 2, boxBroadphase: true });
    const r = await call('runProbe', { ...TINY, sections: ['p2'], scenario: 'S15', params, gravityScale: 42.735, pairsPerBody: 2, boxBroadphase: true, checkpoints: [4], engine });
    expect(r.errors).toEqual([]);
    const p2 = r.p2!;
    expect([p2.scenario, p2.gravityScale, p2.boxBroadphase, p2.N]).toEqual(['S15', 42.735, true, buildScenario('S15', params, 1).bodies.length]);
    expect([p2.engine, p2.iterations, p2.dualPasses, p2.dualFusion, p2.solveContactsRW]).toEqual([engine.spec, 3, 1, true, false]);
    const c = p2.checkpoints[0]!;
    expect(c.colorTail).toBe(4);
    expect(c.pairSlots).toBeLessThan(c.pairsRequired);
    expect(probeMarkdown(r, '## test')).toMatch(/S15 \{"planks":120.*gravity x42.735 box broadphase N=\d+ .*engine avbd-gpu:iterations=3,dualFusion=true,colorTail=4/);
  });
});

describe('solver probe (every section, tiny)', () => {
  it('runs, and its kernels agree with their references', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('runProbe', TINY);
    expect(r.errors).toEqual([]);
    if (isSoftwareAdapter(gpu.adapter)) expect(r.valid).toBe(false);

    // P1: the device asked for the adapter's limits and got them.
    for (const [k, v] of Object.entries(r.p1.limits)) expect(v.device, k).toBe(v.adapter);
    expect(r.p1.limits.maxComputeWorkgroupStorageSize!.device).toBeGreaterThanOrEqual(16384);

    // P2: the engine built the form asked for, every body is in exactly one colour, and each piece was timed.
    expect(r.p2!.hessian).toBe('array');
    expect(r.p2!.checkpoints).toHaveLength(2);
    for (const c of r.p2!.checkpoints) {
      expect(c.n).toBe(300);
      expect(c.direct.reduce((s, d) => s + d.bodies, 0) + c.tail.bodies + c.tail.serialBodies).toBe(c.n);
      expect(c.direct).toHaveLength(c.colorTail);
      expect(c.totalPoints).toBe(c.direct.reduce((s, d) => s + d.points, 0) + c.tail.points);
      expect(c.sumW).toBeGreaterThan(0);
      expect(c.pairsRequired).toBeGreaterThanOrEqual(c.pairSlots);
      expect(c.contactPairs).toBeGreaterThan(0);
      expect(c.contactPairs).toBeLessThanOrEqual(c.pairSlots);
      for (const d of c.direct) expect(d.t).not.toBeNull();
      expect(c.tail.t).not.toBeNull();
      expect(c.dual).not.toBeNull();
    }

    // P3: every variant computes the same step as the CPU reference, at every record size and order.
    const p3 = r.p3!;
    expect(p3.checks).toHaveLength(5 * 4 * 2);
    for (const c of p3.checks) expect(c.maxRelErr, JSON.stringify(c)).toBeLessThan(1e-4);
    expect(p3.rows).toHaveLength(5 * 4 * 2 * 2 * 2);
    expect(p3.slopes.length).toBeGreaterThan(0);

    // P4: barriers and the dispatch chain give the exact exchange; the grid barrier terminates.
    const p4 = r.p4;
    expect(p4.barrier!.map((b) => b.correct)).toEqual([true, true]);
    expect(p4.chain!.map((b) => b.correct)).toEqual([true, true]);
    expect(p4.grid!.length).toBe(3);
    expect(p4.grid![0]!.completed).toBe(true);
    for (const g of p4.grid!) expect(g.completed || g.timedOut || g.skipped).toBe(true);
    expect(p4.tile!.length).toBe(2);
    for (const t of p4.tile!) {
      expect(t.splitDiff).toBeLessThan(1e-5);
      if (t.tileErr !== null) expect(t.tileErr).toBeLessThan(1e-4);
    }
    expect(p4.tile!.some((t) => t.tileErr !== null)).toBe(true);

    const md = probeMarkdown(r, '## test');
    expect(md).toContain('## P4(d)');
    expect(md).toContain('hessian array');
    // Without --engine, P2's output is what it was before the option.
    expect(r.p2).not.toHaveProperty('engine');
    expect(r.p2).not.toHaveProperty('dualPasses');
    expect(r.options).not.toHaveProperty('engine');
    expect(md).not.toContain(', engine ');
    expect(md).toContain('+ I·t_dual');
    if (!r.valid) expect(md).toContain('Not a performance result');
  });
});

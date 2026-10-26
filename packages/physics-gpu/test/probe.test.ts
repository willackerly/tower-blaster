// The solver probe (pnpm bench:probe) under SwiftShader: every section runs
// in a tiny configuration, and its kernels compute what they claim (CPU
// references, exact barrier results). Timing from here is never a
// performance result; the probe marks it invalid.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { isSoftwareAdapter, loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { probeMarkdown, type ProbeOptions } from '../src/probe.ts';
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
  reps: 2, warmup: 1, N: 300, checkpoints: [4, 8], R: 2, solveSteps: 2,
  p3Sizes: [32, 64, 96, 128], p3Points: [4, 8], p3Threads: [64, 130], p3Inner: 1, p3Reps: 1,
  barrierRounds: 20, barrierThreads: [64, 256],
  gridGroups: [1, 2, 4], gridRounds: 10, maxPolls: 20_000,
  tileGroups: [2], tileThreads: [64], tileK: [4], tileIters: [1, 2], tilePoints: 4,
};

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

    // P2: every body is in exactly one colour, and each piece was timed.
    expect(r.p2!.checkpoints).toHaveLength(2);
    for (const c of r.p2!.checkpoints) {
      expect(c.n).toBe(300);
      expect(c.direct.reduce((s, d) => s + d.bodies, 0) + c.tail.bodies + c.tail.serialBodies).toBe(c.n);
      expect(c.direct).toHaveLength(c.colorTail);
      expect(c.totalPoints).toBe(c.direct.reduce((s, d) => s + d.points, 0) + c.tail.points);
      expect(c.sumW).toBeGreaterThan(0);
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
    if (!r.valid) expect(md).toContain('Not a performance result');
  });
});

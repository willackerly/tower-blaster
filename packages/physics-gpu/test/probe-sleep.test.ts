// The sleep probes (pnpm bench:probe --only p5,p6; roadmap E1) under SwiftShader: the stage hook leaves
// the trajectory alone, the island pass labels every graph as a CPU union-find does, and both sections
// run on a city and on a Kapla tower. Timing from here is never a performance result.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildScenario, type Params } from '@tb/scenarios';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { STEP_STAGES } from '../src/engine.ts';
import { DEFAULT_PROBE, probeMarkdown, type ProbeOptions, QUICK_PROBE } from '../src/probe.ts';
import { componentsCpu } from '../src/probe-sleep.ts';
import type * as Drivers from './probe-sleep-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./probe-sleep-page.ts', import.meta.url)), '__sleep');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __sleep: Record<string, (...x: unknown[]) => unknown> }).__sleep[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

/** A seeded graph: m random edges over n vertices (self-loops and repeats included). */
function randomGraph(n: number, m: number, seed: number): number[] {
  let s = seed >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s % n; };
  return Array.from({ length: 2 * m }, r);
}

describe('componentsCpu', () => {
  it('labels each vertex with its component\'s smallest id', () => {
    expect([...componentsCpu(6, Uint32Array.from([4, 2, 5, 4, 1, 0]))]).toEqual([0, 0, 2, 3, 2, 2]);
    expect([...componentsCpu(3, new Uint32Array())]).toEqual([0, 1, 2]);
    expect([...componentsCpu(4, Uint32Array.from([3, 3, 2, 1, 3, 1]))]).toEqual([0, 1, 1, 1]);
  });
});

describe('probe defaults', () => {
  it('P5 settles 300 steps and times 30 by default (60 and 10 with --quick)', () => {
    expect([DEFAULT_PROBE.p5Settle, DEFAULT_PROBE.p5Steps]).toEqual([300, 30]);
    expect([QUICK_PROBE.p5Settle, QUICK_PROBE.p5Steps]).toEqual([60, 10]);
    expect(DEFAULT_PROBE.sections).toEqual(expect.arrayContaining(['p5', 'p6']));
  });
});

describe('P5 stage hook', () => {
  it('probeStages() leaves the trajectory bit-identical to step(), and marks start and every stage in order, in the step\'s encoder', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('stagesHook', buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1), 6);
    expect(r.error).toBeNull();
    expect(r.b).toEqual(r.a);
    expect(r.stages).toEqual([...STEP_STAGES]);
    for (const m of r.marks) expect(m).toEqual(['start', ...STEP_STAGES]);
    expect(r.sameEncoder).toBe(true);
  });
});

describe('P6 island labelling', () => {
  it('matches a CPU union-find on a long chain (both directions), a star, random graphs and no edges', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const n = 3000;
    const chainUp = Array.from({ length: n - 1 }, (_, i) => [i, i + 1]).flat();
    const chainDown = Array.from({ length: n - 1 }, (_, i) => [n - 1 - i, n - 2 - i]).flat();
    const star = Array.from({ length: n - 1 }, (_, i) => [n - 1, i]).flat();
    const cases: Array<[string, number[], number]> = [
      ['chain up', chainUp, 1], ['chain down', chainDown, 1], ['star', star, 1], ['none', [], n],
      ['sparse', randomGraph(n, n / 2, 7), -1], ['dense', randomGraph(n, 3 * n, 11), -1],
    ];
    for (const [name, edges, islands] of cases) {
      const r = await call('islands', n, edges);
      expect(r.error, name).toBeNull();
      expect(r.correct, name).toBe(true);
      expect(r.edges, name).toBe(edges.length / 2);
      const cpu = componentsCpu(n, Uint32Array.from(edges));
      expect(r.islands, name).toBe(new Set(cpu).size);
      if (islands > 0) expect(r.islands, name).toBe(islands);
    }
  });

  it('reads the contact graph of a real step: edges join distinct bodies, and a city of separate towers makes at least one island per tower', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const scene = buildScenario('S14', { towers: 4, W: 2, D: 2, H: 5, street: 4 }, 1);
    const r = await call('edgesOf', scene, 30);
    expect(r.n).toBe(4 * 2 * 2 * 5);
    expect(r.edges.length).toBeGreaterThan(0);
    for (let k = 0; k < r.edges.length; k += 2) {
      expect(r.edges[k]).not.toBe(r.edges[k + 1]);
      expect(Math.max(r.edges[k]!, r.edges[k + 1]!)).toBeLessThan(r.n);
    }
    expect(new Set(componentsCpu(r.n, Uint32Array.from(r.edges))).size).toBeGreaterThanOrEqual(4);
  });
});

const TINY: Partial<ProbeOptions> = { reps: 2, warmup: 1, p5Settle: 20, p5Steps: 3 };

describe('P5 and P6 sections', () => {
  it('run on a city and on a Kapla tower: a stage split (with timestamps) that adds up to the step, and correct island labels', { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const runs: Array<Partial<ProbeOptions> & { scenario: string; params: Params }> = [
      { scenario: 'S14', params: { towers: 4, W: 3, D: 3, H: 6 } },
      { scenario: 'S15', params: { planks: 120, towers: 1, topple: false }, gravityScale: 42.735, pairsPerBody: 32, boxBroadphase: true },
    ];
    for (const run of runs) {
      const r = await call('runProbe', { ...TINY, ...run, sections: ['p5', 'p6'] });
      expect(r.errors, run.scenario).toEqual([]);
      expect(r.p2, run.scenario).toBeUndefined();
      const p5 = r.p5!, p6 = r.p6!;
      expect(p5.N).toBe(buildScenario(run.scenario, run.params, 1).bodies.length);
      expect([p5.scenario, p5.settle, p5.iterations]).toEqual([run.scenario, 20, expect.any(Number)]);
      expect(p5.step.samples).toBe(3);
      if (p5.timestamps) {
        const sum = STEP_STAGES.reduce((s, k) => s + p5.stages[k].median, 0);
        for (const k of STEP_STAGES) expect(p5.stages[k].samples).toBe(3);
        // Medians of parts need not sum to the median whole; within a few per cent on three samples.
        expect(sum).toBeGreaterThan(0);
        expect(Math.abs(sum - p5.step.median)).toBeLessThan(0.5 * p5.step.median + 0.01);
      }
      expect(p5.pairs).toBeGreaterThan(0);
      expect(p6.N).toBe(p5.N);
      expect(p6.correct).toBe(true);
      expect(p6.edges).toBeGreaterThan(0);
      expect(p6.islands).toBeGreaterThanOrEqual(1);
      expect(p6.largest).toBeLessThanOrEqual(p6.N);
      const md = probeMarkdown(r, '## test');
      expect(md).toContain('## P5 Stages of a step');
      expect(md).toContain('Labels match a CPU union-find: yes');
    }
  });
});

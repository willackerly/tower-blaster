// The quality protocol of pnpm bench:quality (quality.ts): the gates and the
// equivalence rule, on the f64 reference in Node and on the GPU through the
// CLI's own page entry (quality-entry.ts), with the fused dual on.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AvbdReferenceEngine, type AvbdParams } from '@tb/physics-ref';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type { GpuEngineOptions } from '../src/index.ts';
import { type CaseId, type CaseMetrics, caseScene, equivalent, evaluate, gates, QUALITY_CASES } from '../src/quality.ts';
import { simulateCase } from '../src/quality-run.ts';
import type * as Entry from '../src/quality-entry.ts';

const CASE = (id: CaseId) => QUALITY_CASES.find((c) => c.id === id)!;
const allTrue = (r: Record<string, boolean | null>) => Object.entries(r).filter(([, v]) => v === false).map(([k]) => k);

describe('quality protocol: gates and equivalence', () => {
  const q2: CaseMetrics = { id: 'Q2', nonFinite: 0, tipping: 2.86, upright: 2.0, uprightErr: -0.017, before: 2, farSide: 1.6, farRatio: 0.897, turned: true };
  it('applies the brief\'s gates at 20 iterations and the 10-iteration ones below', () => {
    expect(allTrue(gates(q2, 20))).toEqual([]);
    expect(allTrue(gates({ ...q2, farRatio: 0.84 }, 20))).toEqual(['farSide']);
    expect(allTrue(gates({ ...q2, farRatio: 0.84 }, 10))).toEqual([]);
    expect(allTrue(gates({ ...q2, uprightErr: 0.04 }, 20))).toEqual(['uprightTime']);
    expect(gates(q2, 4).uprightTime).toBeNull();
    const q1: CaseMetrics = { id: 'Q1', nonFinite: 0, topple: 3, toppleErr: 0.04, bend: 0.05 };
    expect(allTrue(gates(q1, 20))).toEqual(['toppleTime']);
    expect(allTrue(gates(q1, 10))).toEqual([]);
    expect(allTrue(gates({ ...q1, toppleErr: 0, bend: 0.11 }, 20))).toEqual(['bend']);
    expect(allTrue(gates({ ...q1, topple: null, toppleErr: null }, 20))).toEqual(['topples']);
  });
  it('equivalence: crossing times within 0.02 s, the far side within -0.07/+0.04 deg, Q5 no softer, and every gate the base passes', () => {
    expect(allTrue(equivalent(q2, { ...q2, upright: 2.019, farSide: 1.535 }, 20))).toEqual([]);
    expect(allTrue(equivalent(q2, { ...q2, upright: 2.021 }, 20))).toEqual(['uprightWithin002s']);
    expect(allTrue(equivalent(q2, { ...q2, farSide: 1.52 }, 20))).toEqual(['farSideWithinSpread']);
    expect(allTrue(equivalent(q2, { ...q2, farSide: 1.65, farRatio: 0.84 }, 20))).toEqual(['farSideWithinSpread', 'passesWhatBasePasses']);
    const q5: CaseMetrics = { id: 'Q5', nonFinite: 0, penetration: 7e-5, drift: 1e-5 };
    expect(allTrue(equivalent(q5, { ...q5, penetration: 1.2e-4, drift: 1e-4 }, 20))).toEqual([]);
    expect(allTrue(equivalent(q5, { ...q5, penetration: 2e-4 }, 20))).toEqual(['noSofter']);
    expect(allTrue(equivalent(q5, { ...q5, drift: 2e-4 }, 20))).toEqual(['noMoreDrift']);
    expect(allTrue(equivalent(q5, { ...q5, nonFinite: 3 }, 20))).toEqual(['passesWhatBasePasses']);
  });
  it('on the f64 reference with dualFusion at 20 iterations, Q1, Q2, Q4 and Q5 pass the brief\'s gates (fused = unfused: physics-ref/test/dualfusion.test.ts)', { timeout: 600_000 }, async () => {
    const run = async (id: CaseId, p: Partial<AvbdParams>) => {
      const c = CASE(id);
      return evaluate(c, await simulateCase(new AvbdReferenceEngine(p), caseScene(c), c.steps, c.every));
    };
    const fused = { iterations: 20, dualFusion: true };
    const m = { Q1: await run('Q1', fused), Q2: await run('Q2', fused), Q4: await run('Q4', fused), Q5: await run('Q5', fused) };
    for (const x of Object.values(m)) expect(allTrue(gates(x, 20)), x.id).toEqual([]);
    // The acceptance review's numbers (review-accept-1 §1): topple +0.59%, bend 0.041; upright -1.69%, far 0.897 of rigid.
    expect(m.Q1.toppleErr!).toBeCloseTo(0.0059, 3);
    expect(m.Q1.bend!).toBeCloseTo(0.041, 3);
    expect(m.Q2.uprightErr!).toBeCloseTo(-0.0169, 3);
    expect(m.Q2.farRatio!).toBeCloseTo(0.897, 3);
    expect(m.Q4.fallRatio!).toBeGreaterThan(0.99);
    expect(m.Q5.penetration!).toBeLessThan(1e-3);
    expect(m.Q5.drift!).toBeLessThan(1e-3);
    console.log(JSON.stringify(m));
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('../src/quality-entry.ts', import.meta.url)), '__quality');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

const runGpu = async (id: CaseId, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'> = {}) => {
  const c = CASE(id);
  const out = await gpu!.page.evaluate(([s, st, ev, p, o]) => (window as unknown as { __quality: typeof Entry }).__quality.runGpuCase(s, st, ev, p, o), [caseScene(c), c.steps, c.every, params, opts] as const);
  expect(out.error).toBeNull();
  return { run: out.run!, m: evaluate(c, out.run!) };
};

describe('quality protocol on the GPU (pnpm bench:quality\'s page entry), fused dual', () => {
  it('Q4 (S12): fused, in place and off give the same state bit for bit through the entry, and pass', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const off = await runGpu('Q4', { iterations: 20 });
    const fused = await runGpu('Q4', { iterations: 20, dualFusion: true });
    const inPlace = await runGpu('Q4', { iterations: 20, dualFusion: true }, { solveContactsRW: true });
    expect(fused.run.last).toEqual(off.run.last);
    expect(inPlace.run.last).toEqual(off.run.last);
    expect(allTrue(gates(fused.m, 20))).toEqual([]);
    expect(allTrue(equivalent(off.m, fused.m, 20))).toEqual([]);
  });
  // The brief's Q2 at 20 iterations and Q5, which the S12/S13 describe blocks of engine.test.ts do not gate on the GPU,
  // fused, against the brief's gates and against the f64 reference with dualFusion by the same equivalence rule.
  it.for(['Q2', 'Q5'] as const)('%s at 20 iterations, fused: the brief\'s gates, and equivalent to the f64 reference', { timeout: 600_000 }, async (id, ctx) => {
    if (!gpu) return ctx.skip();
    const p = { iterations: 20, dualFusion: true };
    const g = await runGpu(id, p);
    const c = CASE(id);
    const ref = evaluate(c, await simulateCase(new AvbdReferenceEngine(p), caseScene(c), c.steps, c.every));
    console.log(id, JSON.stringify({ gpu: g.m, ref }));
    expect(allTrue(gates(g.m, 20))).toEqual([]);
    expect(allTrue(equivalent(ref, g.m, 20))).toEqual([]);
  });
});

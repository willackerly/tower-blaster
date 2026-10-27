// The quality protocol of pnpm bench:quality (quality.ts): the gates and the
// equivalence rule, on the f64 reference in Node and on the GPU through the
// CLI's own page entry (quality-entry.ts; Q5 there: quality-q5.test.ts).
import { describe, expect, it } from 'vitest';
import { AvbdReferenceEngine, type AvbdParams } from '@tb/physics-ref';
import { type CaseId, type CaseMetrics, caseScene, equivalent, evaluate, gates } from '../src/quality.ts';
import { simulateCase } from '../src/quality-run.ts';
import { AGAINST_REF, againstRef, allTrue, CASE, gpu, runGpu } from './quality-case.ts';

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
  it('on the f64 reference at 20 iterations, Q1, Q2, Q4 and Q5 pass the brief\'s gates', { timeout: 600_000 }, async () => {
    const run = async (id: CaseId, p: Partial<AvbdParams>) => {
      const c = CASE(id);
      return evaluate(c, await simulateCase(new AvbdReferenceEngine(p), caseScene(c), c.steps, c.every));
    };
    const p = { iterations: 20 };
    const m = { Q1: await run('Q1', p), Q2: await run('Q2', p), Q4: await run('Q4', p), Q5: await run('Q5', p) };
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

describe('quality protocol on the GPU (pnpm bench:quality\'s page entry)', () => {
  it('Q4 (S12) through the entry passes the brief\'s gates', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const g = await runGpu('Q4', { iterations: 20 });
    expect(allTrue(gates(g.m, 20))).toEqual([]);
  });
  // The brief's Q2 at 20 iterations (and Q5, quality-q5.test.ts), which the S12/S13 describe blocks of engine.test.ts
  // do not gate on the GPU, against the brief's gates and against the f64 reference by the same equivalence rule.
  it(`Q2 ${AGAINST_REF}`, { timeout: 600_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    await againstRef('Q2');
  });
});

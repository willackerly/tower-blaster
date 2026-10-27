// The GPU side of the quality protocol tests (quality.test.ts, quality-q5.test.ts,
// apart so CI's shard planner can put them on different workers): one browser
// page per test file with pnpm bench:quality's page entry (quality-entry.ts),
// and a case on the GPU against the brief's gates and the f64 reference.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect } from 'vitest';
import { AvbdReferenceEngine, type AvbdParams } from '@tb/physics-ref';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type { GpuEngineOptions } from '../src/index.ts';
import { type CaseId, caseScene, equivalent, evaluate, gates, QUALITY_CASES } from '../src/quality.ts';
import { simulateCase } from '../src/quality-run.ts';
import type * as Entry from '../src/quality-entry.ts';

export const CASE = (id: CaseId) => QUALITY_CASES.find((c) => c.id === id)!;
/** The keys of a gates() or equivalent() result that are false. */
export const allTrue = (r: Record<string, boolean | null>) => Object.entries(r).filter(([, v]) => v === false).map(([k]) => k);

export let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('../src/quality-entry.ts', import.meta.url)), '__quality');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

export const runGpu = async (id: CaseId, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'> = {}) => {
  const c = CASE(id);
  const out = await gpu!.page.evaluate(([s, st, ev, p, o]) => (window as unknown as { __quality: typeof Entry }).__quality.runGpuCase(s, st, ev, p, o), [caseScene(c), c.steps, c.every, params, opts] as const);
  expect(out.error).toBeNull();
  return { run: out.run!, m: evaluate(c, out.run!) };
};

export const AGAINST_REF = 'at 20 iterations: the brief\'s gates, and equivalent to the f64 reference';

/** Case `id` at 20 iterations on the GPU, against the brief's gates and against the f64 reference by the equivalence rule. */
export async function againstRef(id: CaseId): Promise<void> {
  const p = { iterations: 20 };
  const g = await runGpu(id, p);
  const c = CASE(id);
  const ref = evaluate(c, await simulateCase(new AvbdReferenceEngine(p), caseScene(c), c.steps, c.every));
  console.log(id, JSON.stringify({ gpu: g.m, ref }));
  expect(allTrue(gates(g.m, 20))).toEqual([]);
  expect(allTrue(equivalent(ref, g.m, 20))).toEqual([]);
}

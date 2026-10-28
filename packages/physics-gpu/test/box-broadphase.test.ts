// The broadphase's box test (Kapla step K2.1): it may only drop pairs the
// narrowphase would find no contact for, so it never changes a step, only
// how many pair slots the step needs.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './box-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./box-page.ts', import.meta.url)), '__box');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __box: Record<string, (...x: unknown[]) => unknown> }).__box[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

describe('broadphase box test: drops no contact, keeps the sphere pairs\' order', () => {
  const cases: Array<[string, Drivers.BoxCase]> = [
    ['a jumble of planks and cubes, sweeps up to 0.3', { kind: 'cloud', n: 3000, side: 24, margin: 0.02, sweep: 0.3, seed: 1 }],
    ['planks, cubes and 20% spheres, no sweep', { kind: 'cloud', n: 3000, side: 24, spheres: 0.2, margin: 0.02, seed: 2 }],
    ['2000 box pairs on the narrowphase\'s contact boundary, with sweeps', { kind: 'boundary', n: 2000, margin: 0.02, sweep: 0.2, seed: 3 }],
    ['2000 box pairs on the boundary, margin 0', { kind: 'boundary', n: 2000, margin: 0, seed: 4 }],
    ['a standing Kapla tower (S15, 2000 planks)', { kind: 'scenario', scenario: 'S15', params: { planks: 2000, topple: 0 }, margin: 0.02 }],
  ];
  it.for(cases)('%s', async ([, c], ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('boxBroadphase', c, 2);
    expect(r.error).toBeNull();
    expect(r.lostContacts, JSON.stringify(r.examples)).toBe(0);
    expect(r).toMatchObject({ notSphere: 0, reordered: false, looseKeeps: 0, wrongDrops: 0, deterministic: true });
    expect(r.sphereRequired).toBe(r.spherePairs); // nothing overflowed, so every pair was compared
    expect(r.keptRequired).toBe(r.kept);
    expect(r.contacts).toBeGreaterThan(0.05 * r.spherePairs);
    // The pairs really are at the margin (the rest: where the SAT allows a contact the clipping finds no point for).
    if (c.kind === 'boundary') expect(r.nearMargin).toBeGreaterThan(0.8 * c.n!);
  });
});

// The pairs kept are the sphere pairs less ones with no contact, in the same
// order, so the solve sees the same contacts in the same order: the same state.
describe('GPU AVBD engine with the box test: the same state, bit for bit, in fewer pair slots', () => {
  it('a Kapla tower (S15, 600 planks) knocked down by its ball', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('boxEngine', 'S15', { planks: 600, towers: 1, toppleAt: 0.3, toppleHeight: 0.5 }, 150, 10);
    expect(r).toMatchObject({ firstDiff: -1, maxDiff: 0 });
    // Neither arm dropped a pair on any step, so the two really solve the same contacts.
    expect([r.off.pairsOverflowSteps, r.on.pairsOverflowSteps]).toEqual([0, 0]);
    expect(r.on.pairsRequired).toBeLessThan(0.6 * r.off.pairsRequired);
  });

  it('S5, a small city of cubes hit by a ball', { timeout: 300_000 }, async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('boxEngine', 'S5', { N: 600, F: 3, H: 6, fireStep: 5 }, 90, 10);
    expect(r).toMatchObject({ firstDiff: -1, maxDiff: 0 });
    expect([r.off.pairsOverflowSteps, r.on.pairsOverflowSteps]).toEqual([0, 0]);
    expect(r.on.pairsRequired).toBeLessThanOrEqual(r.off.pairsRequired);
  });
});

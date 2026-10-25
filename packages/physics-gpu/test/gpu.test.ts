import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
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

describe('GPU broadphase vs the double-precision oracle', () => {
  const cases: Array<[string, Drivers.BroadCase]> = [
    ['city of packed towers (touching faces)', { kind: 'scenario', scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, margin: 0.05 }],
    // Rain spawns in sparse layers; a wide margin makes neighbours count.
    ['loose rotated cubes (rain), wide margin', { kind: 'scenario', scenario: 'S6', params: { N: 3000 }, margin: 0.8 }],
    ['city plus a big ball (mixed radii)', { kind: 'scenario', scenario: 'S5', params: { N: 1000, F: 4, H: 8, fireStep: 0 }, margin: 0.05 }],
    ['random spheres around the origin (negative cells)', { kind: 'cloud', n: 5000, margin: 0, seed: 3 }],
    // 16 buckets for 5000 bodies: neighbour cells collide constantly, so the
    // own-cell check is what prevents duplicate and phantom pairs.
    ['tiny hash table (every bucket collides)', { kind: 'cloud', n: 5000, margin: 0, seed: 4, tableBits: 4 }],
    ['one body', { kind: 'cloud', n: 1, margin: 0 }],
    ['no bodies', { kind: 'cloud', n: 0, margin: 0 }],
  ];
  it.for(cases)('%s', async ([, c], ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('broadphase', c, 2);
    expect(r.error).toBeNull();
    expect(r).toMatchObject({ duplicates: 0, ordered: true, groupedByI: true, missing: 0, extra: 0, deterministic: true });
    expect(r.written).toBe(r.required);
    expect(r.indirectGroups).toBe(Math.ceil(r.written! / 64));
    if (c.kind === 'scenario') expect(r.oracle).toBeGreaterThan(r.n); // the cases are dense enough to mean something
  });

  it('reports the required count and writes only valid pairs when the buffer is too small', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('broadphase', { kind: 'pile', n: 300, margin: 0, maxPairs: 1000 });
    expect(r.error).toBeNull();
    expect(r.required).toBe(300 * 299 / 2);
    expect(r.written).toBe(1000);
    expect(r).toMatchObject({ duplicates: 0, ordered: true, extra: 0 });
  });
});

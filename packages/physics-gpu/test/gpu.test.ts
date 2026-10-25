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

describe('GPU narrowphase vs the double-precision manifolds', () => {
  // f32 rounding can flip a reduction near-tie: a different one of the
  // reference's candidate points is kept, with the same count, normal,
  // deepest depth and (within 1%) support area. Those are classified as ties
  // and allowed, but must stay rare; anything else must match exactly.
  it('4000 random box-box pairs', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('narrowphase', { kind: 'random', pairs: 4000, margin: 0.02, seed: 11 });
    expect(r.error).toBeNull();
    expect(r.contacts).toBeGreaterThan(1500);
    expect(r.pairMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.groundMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.pairTies + r.groundTies).toBeLessThan(0.005 * (r.contacts + r.groundContacts));
  });

  it('2000 random pairs mixing spheres and boxes in both orders', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('narrowphase', { kind: 'random', pairs: 2000, spheres: 0.5, margin: 0.02, seed: 12 });
    expect(r.error).toBeNull();
    expect(r.pairMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.groundMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.pairTies + r.groundTies).toBeLessThan(0.005 * (r.contacts + r.groundContacts));
  });

  it.for([
    ['packed city', 'S4', { N: 2000, F: 4, H: 12 }],
    ['gapped tower', 'S1', { F: 4, H: 10, gap: 0.02 }],
    ['ball resting in a city', 'S5', { N: 1000, F: 4, H: 8, fireStep: 0 }],
  ] as const)('%s: every manifold matches', async ([, scenario, params], ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('narrowphase', { kind: 'scenario', scenario, params: { ...params }, margin: 0.05 });
    expect(r.error).toBeNull();
    expect(r.contacts).toBeGreaterThan(0);
    expect(r.pairMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.groundMismatch).toBe(0);
    expect(r.groundContacts).toBeGreaterThan(0);
    expect(r.pairTies + r.groundTies).toBeLessThan(0.005 * (r.contacts + r.groundContacts));
  });
});

describe('GPU graph colouring vs the reference (Jones-Plassmann = greedy in priority order)', () => {
  const exact = (r: Awaited<ReturnType<D['coloring']>>) => {
    expect(r.error).toBeNull();
    expect(r.uncolored).toBe(0);
    expect(r.overflow).toBe(0);
    expect(r.colorsMatch, `first mismatch at ${r.firstMismatch}`).toBe(true);
    expect(r.colorsUsed).toBe(r.refColors);
    expect(r.orderMatch).toBe(true);
    expect(r.startMatch).toBe(true);
    expect(r.dispatchMatch).toBe(true);
  };
  it.for([
    ['sparse random graph, isolated nodes, empty slots', { kind: 'random', n: 3000, edges: 4000, seed: 1 }],
    ['dense random graph (degree ~20)', { kind: 'random', n: 2000, edges: 20000, seed: 2 }],
    ['no edges', { kind: 'random', n: 100, edges: 0, seed: 3 }],
    ['one node', { kind: 'random', n: 1, edges: 0, seed: 4 }],
  ] as const)('%s', async ([, c], ctx) => {
    if (!gpu) return ctx.skip();
    exact(await call('coloring', { ...c }));
  });

  it.for([
    ['packed city (edge and corner neighbours touch)', 'S4', { N: 2000, F: 4, H: 12 }, 0.05],
    // Loose cubes spawn apart; a wide speculative margin connects them.
    ['loose rotated cubes, wide margin', 'S6', { N: 2000 }, 0.8],
    ['ball resting in a city', 'S5', { N: 1000, F: 4, H: 8, fireStep: 0 }, 0.05],
  ] as const)('contact graph of a %s', async ([, scenario, params, margin], ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('coloring', { kind: 'scenario', scenario, params: { ...params }, margin });
    expect(r.edges).toBeGreaterThan(0);
    exact(r);
  });

  it('reports too few rounds instead of returning a wrong colouring', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('coloring', { kind: 'random', n: 2000, edges: 20000, seed: 2, rounds: 2 });
    expect(r.error).toBeNull();
    expect(r.uncolored).toBeGreaterThan(0);
  });
});

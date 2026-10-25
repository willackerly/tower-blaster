// GPU primitives, run for real in headless Chromium (SwiftShader without a
// GPU). Correctness only: timings from here are never performance results.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__gpu');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __gpu: Record<string, (...x: unknown[]) => unknown> }).__gpu[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

describe('GpuProfiler', () => {
  it('reports per-label pass times for every frame in flight', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('profiler', 3);
    expect(r.error).toBeNull();
    expect(r.extra).toEqual({});
    expect(r.supported).toBe(r.timestamps);
    if (!r.supported) {
      expect(r.results).toEqual([{}, {}, {}]);
      return;
    }
    expect(r.results).toHaveLength(3);
    for (const frame of r.results) {
      expect(Object.keys(frame).sort()).toEqual(['a', 'b']);
      for (const ms of Object.values(frame)) {
        expect(Number.isFinite(ms)).toBe(true);
        expect(ms).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('Scanner (exclusive u32 scan, in place)', () => {
  // Sizes straddle every block and level boundary: 512 = one block,
  // 512² = two full levels, 512² + 1 forces a third level.
  const sizes = [1, 2, 511, 512, 513, 1000, 262_143, 262_144, 262_145, 1_000_003];
  it.for(sizes)('n = %i matches the reference and leaves the tail alone', async (n, ctx) => {
    if (!gpu) return ctx.skip();
    const capacity = n + 37;
    const [r] = await call('scan', [{ n, capacity, fill: 'random', seed: n }]);
    expect(r).toMatchObject({ error: null, prefixDiff: -1, tailDiff: -1 });
  });

  it('wraps modulo 2^32 like the reference', async (ctx) => {
    if (!gpu) return ctx.skip();
    const [r] = await call('scan', [{ n: 70_000, capacity: 70_000, fill: 'max', seed: 1 }]);
    expect(r).toMatchObject({ error: null, prefixDiff: -1, tailDiff: -1 });
  });

  it('reuses one scanner across shrinking and growing n', async (ctx) => {
    if (!gpu) return ctx.skip();
    const capacity = 300_000;
    const rs = await call('scan', [300_000, 5, 0, 262_145, 513].map((n, i) => ({ n, capacity, fill: 'small' as const, seed: 100 + i })));
    for (const r of rs) expect(r).toMatchObject({ error: null, prefixDiff: -1, tailDiff: -1 });
  });
});

describe('Compactor', () => {
  const cases = [
    { n: 0, capacity: 10, density: 0.5 },
    { n: 1, capacity: 1, density: 1 },
    { n: 1000, capacity: 1000, density: 0 },
    { n: 1000, capacity: 1000, density: 1 },
    { n: 513, capacity: 600, density: 0.5 },
    { n: 100_000, capacity: 100_000, density: 0.03 },
    { n: 300_000, capacity: 400_000, density: 0.7 },
  ];
  it.for(cases)('n = $n, density $density: ordered indices, count and indirect args', async (c, ctx) => {
    if (!gpu) return ctx.skip();
    const [r] = await call('compact', [{ ...c, seed: c.n + 7 }]);
    expect(r!.error).toBeNull();
    const k = r!.expectedCount;
    expect(r!.count).toEqual([Math.ceil(k / 64), 1, 1, k]);
    expect(r!.listDiff).toBe(-1);
    expect(r!.untouchedAfter).toBe(true);
    expect(r!.marksDiff).toBe(-1);
  });
});

describe('RadixSorter (stable, keys + values)', () => {
  const cases = [
    { n: 0, keys: 'random', keyBits: 32 },
    { n: 1, keys: 'random', keyBits: 32 },
    { n: 2, keys: 'reversed', keyBits: 32 },
    { n: 255, keys: 'random', keyBits: 32 },
    { n: 256, keys: 'dupes', keyBits: 32 },
    { n: 257, keys: 'random', keyBits: 32 },
    { n: 10_000, keys: 'dupes', keyBits: 32 },
    { n: 10_000, keys: 'sorted', keyBits: 32 },
    { n: 10_000, keys: 'reversed', keyBits: 32 },
    { n: 10_000, keys: 'max', keyBits: 32 },
    { n: 65_537, keys: 'random', keyBits: 12 }, // odd pass count: result copied back
    { n: 100_000, keys: 'random', keyBits: 20 },
    { n: 1_000_000, keys: 'random', keyBits: 32 },
  ] as const;
  it.for(cases)('n = $n, $keys keys, $keyBits bits', async (c, ctx) => {
    if (!gpu) return ctx.skip();
    const [r] = await call('sort', [{ ...c, capacity: c.n + 300, seed: c.n + c.keyBits }]);
    expect(r).toMatchObject({ error: null, keyDiff: -1, valDiff: -1, tailDiff: -1 });
  });
});

describe('BandwidthProbe and bench:gpu', () => {
  it('the copy kernel copies every word, including a partial last workgroup', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('bandwidthCopy', 4 * 2 ** 20 + 48);
    expect(r).toEqual({ bytes: 4 * 2 ** 20 + 48, traffic: 2 * (4 * 2 ** 20 + 48), diff: -1 });
  });

  it('a quick bench run yields one finite, positive record per case', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('runGpuBench', { reps: 2, warmup: 1, copyBytes: 2 ** 20, scanSizes: [1000], compactSizes: [1000], sortSizes: [1000], dispatches: 10 });
    expect(r.cases.map((c) => c.name)).toEqual(['copy-1MiB', 'dispatch-x10', 'scan-1000', 'compact-1000-30pct', 'sort-1000-32bit', 'sort-1000-20bit']);
    for (const c of r.cases) {
      expect(Number.isFinite(c.medianMs) && c.medianMs >= 0).toBe(true);
      expect(c.p10Ms).toBeLessThanOrEqual(c.p90Ms);
    }
    expect(r.software).toBe(/swiftshader/i.test(gpu.adapter.architecture));
  });
});

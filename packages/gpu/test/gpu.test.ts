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

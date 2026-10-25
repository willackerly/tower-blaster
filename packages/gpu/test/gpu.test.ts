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

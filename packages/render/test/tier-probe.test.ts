// The measurements behind the quality tiers (tier-probe.ts, docs/game/quality-tiers.md) in headless
// Chromium: frames of an offscreen renderer drawing the bench's 'near' heap and chains of dependent
// dispatches run without a validation error and come back as wall times; a frame over stopAboveMs ends
// the timing. Correctness only: timings from SwiftShader are never performance results.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Page from './tier-probe-page.ts';
import { medianOf } from '../src/tier-probe.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./tier-probe-page.ts', import.meta.url)), '__tiers');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type P = typeof Page;
const call = <K extends keyof P>(name: K, ...args: Parameters<P[K]>) => gpu!.page.evaluate(
  ([n, a]) => (window as unknown as { __tiers: Record<string, (...x: unknown[]) => unknown> }).__tiers[n as string]!(...(a as unknown[])),
  [name, args] as const,
) as Promise<Awaited<ReturnType<P[K]>>>;

describe('tier probe', () => {
  it('medianOf: odd, even, empty', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
    expect(medianOf([])).toBeNaN();
  });

  it('frames at two sizes and toggle sets: timed, no validation error, the smaller one cheaper', async (ctx) => {
    if (!gpu) return ctx.skip();
    const high = await call('frames', 320, 200, {}, Infinity);
    const low = await call('frames', 160, 100, { ao: false, sparks: false }, Infinity);
    console.log(`probe frames (software: not a performance result): 320x200 all on ${high.frameMs.map((x) => x.toFixed(1))} ms, 160x100 low ${low.frameMs.map((x) => x.toFixed(1))} ms`);
    for (const f of [high, low]) {
      expect(f.error).toBeNull();
      expect(f.frameMs).toHaveLength(2);
      expect(f.warmupMs).toBeGreaterThan(0);
      for (const ms of f.frameMs) expect(ms).toBeGreaterThan(0);
    }
    // A sixteenth of the pixels and two passes fewer: on any adapter this is less work (a functional check of the toggles, not a timing result).
    expect(medianOf(low.frameMs)).toBeLessThan(medianOf(high.frameMs));
  }, 300_000);

  it('a frame over stopAboveMs ends the timing after it', async (ctx) => {
    if (!gpu) return ctx.skip();
    const f = await call('frames', 160, 100, {}, 0);
    expect(f.error).toBeNull();
    expect(f.frameMs).toHaveLength(1);
  }, 300_000);

  it('dependent dispatches: one warmup round and timed rounds, per-dispatch time positive', async (ctx) => {
    if (!gpu) return ctx.skip();
    const d = await call('dispatch');
    expect(d.error).toBeNull();
    expect(d).toMatchObject({ dispatches: 64, threads: 4096 });
    expect(d.roundMs).toHaveLength(2);
    expect(d.msPerDispatch).toBeGreaterThan(0);
    expect(d.msPerDispatch).toBeCloseTo(medianOf(d.roundMs) / 64, 9);
  }, 300_000);
});

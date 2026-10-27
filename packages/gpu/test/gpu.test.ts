// GPU primitives, run for real in headless Chromium (SwiftShader without a
// GPU). Correctness only: timings from here are never performance results.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { gpuBenchMarkdown } from '../src/bench.ts';
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

describe('sharedDevice', () => {
  it('gives one device per option set, drops scopes a failed caller left, and replaces a lost device', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sharedDevices');
    expect(r.same).toBe(true);
    expect(r.distinct).toBe(true);
    expect(r.uncaptured).not.toBeNull();
    expect(r.replaced).toBe(true);
    expect(r.replacedError).toBeNull();
    expect(r.sameAfter).toBe(true);
  });
});

describe('GpuProfiler', () => {
  it('reports per-label pass times and the frame span for every frame in flight', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('profiler', 3);
    expect(r.error).toBeNull();
    expect(r.extra).toEqual({});
    expect(r.supported).toBe(r.timestamps);
    if (!r.supported) {
      expect(r.results).toEqual([{}, {}, {}]);
      expect(r.spans).toEqual([null, null, null]);
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
    // The span holds every pass: at least the longest one ('a' is two passes).
    r.results.forEach((frame, i) => {
      const span = r.spans[i];
      if (span === null || span === undefined) return; // all timestamps zeroed (quantized away)
      expect(span).toBeGreaterThanOrEqual(Math.max(frame.b!, frame.a! / 2) - 1e-6);
    });
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
  // 180 s: on SwiftShader the 1M-key case takes most of the default 60 s once
  // other work shares the VM (it timed out at load 7-15 several times).
  it.for(cases)('n = $n, $keys keys, $keyBits bits', { timeout: 180_000 }, async (c, ctx) => {
    if (!gpu) return ctx.skip();
    const [r] = await call('sort', [{ ...c, capacity: c.n + 300, seed: c.n + c.keyBits }]);
    expect(r).toMatchObject({ error: null, keyDiff: -1, valDiff: -1, tailDiff: -1 });
  });
});

describe('Readback (pooled staging buffers)', () => {
  it('reads 4 B, 256 B, 1 MiB, the whole buffer by default and a range at an offset', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('readbackData', [{ size: 4 }, { size: 256 }, { size: 2 ** 20 }, { size: 2 ** 20 + 64, bytes: 4108, offset: 1000 }, { size: 512, bytes: 4, offset: 508 }]);
    expect(r.error).toBeNull();
    expect(r.cases.map((c) => [c.byteLength, c.diff])).toEqual([[4, -1], [256, -1], [2 ** 20, -1], [4108, -1], [4, -1]]);
    expect(r.bytesRead).toBe(4 + 256 + 2 ** 20 + 4108 + 4);
    // One 256 B buffer serves the 4 B, 256 B and last reads; the 4108 B read takes the free 1 MiB one.
    expect(r.created).toBe(2);
  });

  it('reuses, grows, never shares, keeps queue order, rejects bad ranges and failed copies, and cleans up', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('readbackRules');
    expect(r.error).toBeNull();
    // Sequential reads of one size: one 1 KiB buffer.
    expect(r.seq).toEqual([true, true, true]);
    expect(r.afterSequential).toEqual({ created: 1, free: [1024] });
    // A larger read adds one; a smaller one after it takes the smallest that fits.
    expect(r.largeOk).toBe(true);
    expect(r.afterLarge).toEqual({ created: 2, free: [1024, 2 ** 20] });
    expect(r.freeWhileSmallInFlight).toEqual([2 ** 20]);
    expect(r.smallAgainOk).toBe(true);
    expect(r.afterSmall).toEqual({ created: 2, free: [1024, 2 ** 20] });
    // Two reads in flight at once get a buffer each.
    expect(r.concurrent).toEqual({ created: 2, a: -1, b: -1 });
    // The copy is submitted by read() itself, so a later writeBuffer cannot leak into it.
    expect(r.order).toEqual({ before: [1, 2, 3, 4], after: [5, 6, 7, 8] });
    expect(r.misaligned.bytes).toMatch(/bytes \(6\) and offset \(0\) must be non-negative multiples of 4/);
    expect(r.misaligned.offset).toMatch(/bytes \(4\) and offset \(2\) must be non-negative multiples of 4/);
    expect(r.misaligned.negative).toMatch(/must be non-negative multiples of 4/);
    expect(r.misaligned.range).toMatch(/8 bytes at 12 is past the end of a 16-byte buffer/);
    expect(r.badSource).toEqual({ usage: 'Readback: the source buffer has no COPY_SRC usage', mapped: 'Readback: the source buffer is mapped' });
    expect(r.empty).toBe(0);
    expect(r.idle).toEqual({ submits: 0, created: 0, bytesRead: 0 });
    expect(r.submitsPerRead).toBe(1);
    expect(r.maps).toEqual([[0, 4]]);
    // A dropped copy is an error, not the staging buffer's old bytes.
    expect(r.staleCopy).toMatch(/^Readback: the copy failed: .*destroyed/s);
    expect(r.afterStale).toEqual({ created: 0, bytesRead: 0, free: [1024, 2 ** 20] });
    expect(r.afterStaleRead).toEqual([5, 6, 7, 8]);
    expect(r.clamped).toEqual({ ok: true, free: [1000] });
    expect(r.failedMap).toMatch(/unmapped/i);
    expect(r.victimGone).toBe(true);
    expect(r.victimDestroyed).toBe(true);
    expect(r.recovered).toBe(true);
    expect(r.recoveredCreated).toBe(2);
    expect(r.destroyedInFlight).toBe('Readback: destroyed during a read');
    expect(r.buffers).toBe(2);
    expect(r.allDestroyed).toBe(true);
    expect(r.readAfterDestroy).toBe('Readback: destroyed');
    expect(r.destroyedAfterMap).toBe('Readback: destroyed during a read');
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
    // readbackSizes left at its default: the 2 KB and 6.4 MB round trips.
    const { result: r, staging } = await call('runGpuBench', { reps: 2, warmup: 1, copyBytes: 2 ** 20, scanSizes: [1000], compactSizes: [1000], sortSizes: [1000], dispatches: 10 });
    expect(r.cases.map((c) => c.name)).toEqual([
      'copy-1MiB', 'dispatch-x10', 'scan-1000', 'compact-1000-30pct', 'sort-1000-32bit', 'sort-1000-20bit',
      'readback-2048-fresh', 'readback-2048-pooled', 'readback-6400000-fresh', 'readback-6400000-pooled',
    ]);
    for (const c of r.cases) {
      expect(Number.isFinite(c.medianMs) && c.medianMs >= 0).toBe(true);
      expect(c.p10Ms).toBeLessThanOrEqual(c.p90Ms);
    }
    // The warmup rep is run but not timed.
    expect(r.cases.map((c) => c.samples)).toEqual(r.cases.map(() => 2));
    expect(r.software).toBe(/swiftshader/i.test(gpu.adapter.architecture));
    // Readback cases are wall-clock host round trips: marked, and no "% of copy" in the table.
    expect(r.cases.filter((c) => c.hostRoundTrip).map((c) => [c.name, c.n, c.traffic, c.source])).toEqual(
      [2048, 6_400_000].flatMap((b) => ['fresh', 'pooled'].map((k) => [`readback-${b}-${k}`, b, b, 'wall'])),
    );
    const md = gpuBenchMarkdown(r, '## test');
    const row = (name: string) => md.split('\n').find((l) => l.startsWith(`| ${name} |`))!.split('|').map((x) => x.trim());
    expect(row('copy-1MiB').at(-2)).toBe('100%');
    expect(row('readback-2048-pooled').at(-2)).toBe('');
    expect(row('readback-6400000-fresh').at(-2)).toBe('');
    expect(md).toMatch(/readback cases are wall-clock host round trips/);
    // Pooled makes one staging buffer per size (a power of two) and reuses it;
    // fresh makes one per round trip, its warmup included.
    expect(staging.filter((b) => b.label === 'readback staging').map((b) => b.size)).toEqual([2048, 2 ** 23]);
    expect(staging.filter((b) => b.label === '' && (b.size === 2048 || b.size === 6_400_000)).map((b) => b.size)).toEqual([2048, 2048, 2048, 6_400_000, 6_400_000, 6_400_000]);
  });
});

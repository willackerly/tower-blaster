// bench:render's cases, first group (bench-cases.ts; the second is in render-bench-real.test.ts).
import { describe, expect, it } from 'vitest';
import { DEFAULT_RENDER_BENCH } from '../src/bench.ts';
import { benchCases, BENCH_GROUPS } from './bench-cases.ts';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('the two files between them run every bench:render variant once', () => {
    expect(BENCH_GROUPS.flat().sort()).toEqual([...DEFAULT_RENDER_BENCH.variants].sort());
    expect(new Set(BENCH_GROUPS.flat()).size).toBe(DEFAULT_RENDER_BENCH.variants.length);
  });

  it('bench:render completes and reports every case of the first group (numbers discarded)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await benchCases(BENCH_GROUPS[0]!);
    expect(await call('renderBenchMarkdown', r, 'h')).toMatch(/Without heat glow/);
  }, 300_000); // most of it the first frame of each renderer on a software adapter; the whole bench (56 cases) took ~140 s locally and 324 s on a busy shard runner before the split
});

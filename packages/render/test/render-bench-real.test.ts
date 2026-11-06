// bench:render's cases, second group: the rest of the real look's (bench-cases.ts; the first group is in render-bench.test.ts).
import { describe, it } from 'vitest';
import { benchCases, BENCH_GROUPS } from './bench-cases.ts';
import { gpu } from './harness.ts';

describe('drawing (real look)', () => {
  it('bench:render completes and reports every case of the second group (numbers discarded)', async (ctx) => {
    if (!gpu) return ctx.skip();
    await benchCases(BENCH_GROUPS[1]!);
  }, 300_000);
});

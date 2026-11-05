// bench:render's every case, split between two test files so each stays well
// under the 300 s a CI shard runner allows a file: render-bench.test.ts runs
// the stylized variants and the first half of the real look's (BENCH_GROUPS[0]),
// render-bench-real.test.ts the rest (the real look's cases cost the most). Each runs
// its cases once at a tiny size (SwiftShader without a GPU): they only have
// to complete and report; the numbers are discarded.
import { expect } from 'vitest';
import { DEFAULT_RENDER_BENCH, type VariantName } from '../src/bench.ts';
import { isSoftwareAdapter } from '@tb/testkit';
import { gpu, call } from './harness.ts';

const REAL_VARIANTS = DEFAULT_RENDER_BENCH.variants.filter((v) => v.startsWith('real'));
const STYLIZED_VARIANTS = DEFAULT_RENDER_BENCH.variants.filter((v) => !v.startsWith('real'));
const HALF = Math.ceil(REAL_VARIANTS.length / 2);
export const BENCH_GROUPS: VariantName[][] = [[...STYLIZED_VARIANTS, ...REAL_VARIANTS.slice(0, HALF)], REAL_VARIANTS.slice(HALF)];

export async function benchCases(variants: VariantName[]) {
  const r = await call('runRenderBench', { width: 160, height: 90, counts: [800], warmup: 1, batches: 2, batchFrames: 1, profiledFrames: 1, sparkPool: 1024, dustWarmup: 40, variants });
  expect(r.cases.map((c) => `${c.world}:${c.variant}`)).toEqual(['near', 'far'].flatMap((w) => variants.map((v) => `${w}:${v}`)));
  for (const c of r.cases) {
    expect(c.bodies).toBe(800);
    expect(c.frameMs).toBeGreaterThan(0);
    expect(c.batches).toHaveLength(2);
    expect(c.drawn.boxes + c.drawn.farBoxes).toBeGreaterThan(0);
    expect(c.drawn.boxes + c.drawn.farBoxes).toBeLessThanOrEqual(800);
    if (!c.variant.startsWith('real') || c.variant === 'real-no-lod') expect(c.drawn.farBoxes, c.variant).toBe(0);
    // Still worlds: no particle lives, except in real-dust and real-plain-dust, whose showers fill both rings of a 1024 pool in their 40 extra warmup frames (341 + 683; the full pool's rings hold more than the budgets' steady count).
    expect(c.particles, c.variant).toBe(c.variant === 'real-dust' || c.variant === 'real-plain-dust' ? 1024 : 0);
    if (r.timestamps) expect(Object.keys(c.passes)).toEqual(expect.arrayContaining(['cull', 'scene', ...(c.variant === 'no-shadow' ? [] : ['shadow']), ...(c.variant === 'no-post' ? [] : ['bloom', 'composite'])]));
  }
  expect(r.software).toBe(isSoftwareAdapter(gpu!.adapter));
  return r;
}

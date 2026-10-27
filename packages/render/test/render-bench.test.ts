// bench:render's every case, run once at a tiny size (SwiftShader without a
// GPU): it only has to complete and report; the numbers are discarded.
import { describe, expect, it } from 'vitest';
import { isSoftwareAdapter } from '@tb/testkit';
import { gpu, call } from './harness.ts';

describe('drawing', () => {
  it('bench:render completes and reports every case (numbers discarded)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('runRenderBench', { width: 160, height: 90, counts: [800], warmup: 1, batches: 2, batchFrames: 1, profiledFrames: 1, sparkPool: 1024, dustWarmup: 40 });
    expect(r.cases.map((c) => `${c.world}:${c.variant}`)).toEqual(['near', 'far'].flatMap((w) => ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube', 'real', 'real-no-stone', 'real-stone-off', 'real-step1', 'real-no-lod', 'real-no-floor-sky', 'real-flat-ground', 'real-no-pcss', 'real-4096', 'real-dust'].map((v) => `${w}:${v}`)));
    for (const c of r.cases) {
      expect(c.bodies).toBe(800);
      expect(c.frameMs).toBeGreaterThan(0);
      expect(c.batches).toHaveLength(2);
      expect(c.drawn.boxes + c.drawn.farBoxes).toBeGreaterThan(0);
      expect(c.drawn.boxes + c.drawn.farBoxes).toBeLessThanOrEqual(800);
      if (!c.variant.startsWith('real') || c.variant === 'real-no-lod') expect(c.drawn.farBoxes, c.variant).toBe(0);
      // Still worlds: no particle lives, except in real-dust, whose shower fills both rings of a 1024 pool in its 40 extra warmup frames (341 + 683; the full pool's rings hold more than the budgets' steady count).
      expect(c.particles, c.variant).toBe(c.variant === 'real-dust' ? 1024 : 0);
      if (r.timestamps) expect(Object.keys(c.passes)).toEqual(expect.arrayContaining(['cull', 'scene', ...(c.variant === 'no-shadow' ? [] : ['shadow']), ...(c.variant === 'no-post' ? [] : ['bloom', 'composite'])]));
    }
    expect(r.software).toBe(isSoftwareAdapter(gpu.adapter));
    expect(await call('renderBenchMarkdown', r, 'h')).toMatch(/Without heat glow/);
  }, 180_000); // 42 cases on a software adapter, most of it the first frame of each renderer; 40 s timed out on CI beside the GPU physics and game tests (main, 8b5dd54), and 120 s when every case built its own renderer (b6bf9a2)
});

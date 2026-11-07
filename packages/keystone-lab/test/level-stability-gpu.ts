// The GPU solver's load-stability suite (the agent playtest's PT11), shared by level-stability-gpu.test.ts (every
// level on a real GPU; the doorway T-X4 on CI) and level-stability-gpu-X3B.test.ts (T-X3B on CI), so each CI file
// holds one SwiftShader level under the 300 s a file may take. On the game's cast page exactly as the game builds
// the level, its pre-settle moves no body half a cell from where the level put it, and the steps after move none
// 0.1 m, with no engine limit hit. SwiftShader takes about 70 ms a step on a small level and a slow runner 3.5x
// that (T-X3B 237 s, T-X4 380 s for 300 steps after the pre-settle), so CI rests CI_STEPS after the pre-settle, where
// the old arch broke, and a real GPU (TB_CHANNEL=chrome on Metal) or PHYSICS_GPU_SLOW=1 rests the full STEPS.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, SERIES } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { REST_BOUND_M } from '../src/index.ts';

const MINUTES = 60_000;
export const channel = process.env.TB_CHANNEL;
/** Every level runs: on a real GPU, or on SwiftShader when asked (up to SWIFT_SLOW_MAX bodies there). */
export const ALL = Boolean(channel) || process.env.PHYSICS_GPU_SLOW === '1';
/**
 * The most bodies a level the GPU solver's slow tests load on SwiftShader (the nightly, PHYSICS_GPU_SLOW=1). There
 * B2 (5,184) rested 25 min and B3 (10,000) passed 30 min with no result, losing the page for every level after it
 * (nightly run 42394058839); B1 (1,000) took 313 s. Bigger levels run on a real GPU: the Mac run, TB_CHANNEL=chrome
 * (docs/ci/nightly.md).
 */
export const SWIFT_SLOW_MAX = 2000;
/** The most bodies a level loaded here may have: every level on a real GPU. */
export const LOAD_MAX = channel ? Infinity : SWIFT_SLOW_MAX;
export const STEPS = 300, CI_STEPS = 100;
export const LEVELS_ALL = SERIES.flat().map((def) => ({ def, c: compileLevel(def) }));
/** Every level is dealt over PARTS files (largest first, in turn), so no file holds the whole sweep on one worker. */
export const PARTS = 3;

/** Part `part` (1..PARTS) of every level up to LOAD_MAX bodies, largest first, in turn. */
export function levelsPart(part: number): typeof LEVELS_ALL {
  return LEVELS_ALL.filter((l) => l.c.meta.n <= LOAD_MAX).sort((a, b) => b.c.meta.n - a.c.meta.n || (a.def.id < b.def.id ? -1 : 1)).filter((_, i) => i % PARTS === part - 1);
}

/** The suite on the levels named, or on part `part` of every level when `ids` is null. */
export function gpuStabilitySuite(ids: readonly string[] | null, extra?: () => void, part = 1): void {
  const steps = ALL ? STEPS : CI_STEPS;
  const levels: Array<{ def: LevelDef; c: ReturnType<typeof compileLevel> }> = ids ? LEVELS_ALL.filter((l) => ids.includes(l.def.id)) : levelsPart(part);
  if (ids && levels.length !== ids.length) throw new Error(`unknown level among ${ids.join(', ')}`);
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    try {
      player = await openBrowserCastPlayer({ ...(channel ? { channel } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe('every level stands at load on the GPU solver', () => {
    for (const { def, c } of levels) it(`${def.id} (${c.meta.n} bodies)`, async (ctx) => {
      if (!player) return ctx.skip();
      const r = await player.rest(def, steps), h = c.frame.unit;
      console.log(`${def.id} at load on ${player.adapter}: pre-settle max ${(r.settle.maxMove * h).toFixed(3)} m (${r.settle.fell} fell), then ${(r.maxMove * h).toFixed(4)} m over ${steps} steps, ${(r.ms / 1000).toFixed(0)} s`);
      expect(r.limits).toEqual([]);
      expect(r.settle.fell, `bodies that fell in the pre-settle (most moved ${(r.settle.maxMove * h).toFixed(3)} m)`).toBe(0);
      expect(r.maxMove * h).toBeLessThan(REST_BOUND_M);
    }, 30 * MINUTES);
    extra?.();
  });
}

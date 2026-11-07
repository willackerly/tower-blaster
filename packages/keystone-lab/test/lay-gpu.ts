// Wavefront's Lay levels on the GPU solver (M6, docs/game/wavefront.md), through the game's cast page (the game's own
// engine and settings): every authored solution (lay-solutions.ts) rings every bell, nothing built rings none, and
// the pinned ramp and wall end exactly where they were authored (f32). SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LevelDef } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { build } from '../src/rube.ts';
import { steps } from '../src/lay.ts';
import { LAY_SOLUTIONS } from '../src/lay-solutions.ts';
import { SLOW } from './wave-gpu.ts';

const MINUTES = 60_000;

export interface LayGpuOpts {
  /** How many of each level's authored solutions to play (all by default). */
  solutions?: number;
  /**
   * Stop each run here and judge it on its bells alone (every one rung by then), not on the session's clear: W6 rings
   * its last bell at about 2,100 steps on SwiftShader but its fallen field does not come quiet before the 60 s window
   * (3,600 steps), and the whole window costs CI over 6 minutes.
   */
  maxSteps?: number;
  /** Also play the level with nothing built (default true; the Rapier tests have it, so a file short of time skips it). */
  bare?: boolean;
  /** Only with SLOW (wave-gpu.ts): a real GPU or PHYSICS_GPU_SLOW=1. On a PR the file is registered skipped. */
  slow?: boolean;
}

/** Registers the GPU test of Lay levels `defs` (lay-solutions.ts). */
export function layGpuSuite(defs: readonly LevelDef[], opts: LayGpuOpts = {}): void {
  const { solutions = Infinity, maxSteps, bare = true } = opts;
  describe.skipIf(opts.slow === true && !SLOW)('Wavefront Lay levels on the GPU solver', () => {
    let player: BrowserCastPlayer | null = null;
    beforeAll(async () => {
      try {
        player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
      } catch (e) {
        if (requireWebGPU()) throw e;
      }
    }, 3 * MINUTES);
    afterAll(async () => { await player?.close(); });

    it.for(defs.map((d) => d.id))('%s: the authored solutions ring every bell, nothing built rings none, pins hold', { timeout: 15 * MINUTES }, async (id, ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      const def = defs.find((d) => d.id === id)!;
      if (bare) {
        const r = await player.rube(def, maxSteps);
        expect(r.rung, 'nothing built').toBe(0);
        expect(r.pinnedMove, r.pinnedAt).toBe(0);
      }
      for (const s of LAY_SOLUTIONS[id]!.slice(0, solutions)) {
        const b = build(def, steps(s))!;
        const r = await player.rube(b.def, maxSteps);
        console.log(`${id} ${s.label} on ${player.adapter}: ${r.cleared ? 'clear' : maxSteps !== undefined && r.rung === r.bells ? 'rung (capped)' : 'FAIL'}, ${r.rung}/${r.bells} bells, rung at ${r.rungAt} of ${r.steps} steps, ${b.spent} laid, ${(r.ms / 1000).toFixed(1)} s`);
        if (maxSteps === undefined) expect(r.cleared, `${s.label} clears`).toBe(true);
        else expect(r.rung, `${s.label} rings every bell by step ${maxSteps}`).toBe(r.bells);
        expect(r.pinnedMove, `${s.label}: pins move (${r.pinnedAt})`).toBe(0);
      }
    });
  });
}

// Rube Lab on the GPU solver (M10, docs/game/rube-lab.md), one level per test file
// (rube-gpu-RL*.test.ts, so each file stays well under CI's per-file budget on SwiftShader),
// through the game's cast page (the game's own engine and settings): each gate puzzle's
// recorded solutions clear and its bare level fails, as on the reference (rube.test.ts), and
// every pinned body (the shelves, the authored ramps, the bin's ramp and bumper) ends exactly
// where it was authored, as the GPU stores it (f32). SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LevelDef, RUBE_END_AFTER } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { build } from '../src/rube.ts';
import { RUBE_SOLUTIONS } from '../src/rube-solutions.ts';

const MINUTES = 60_000;

/** Registers the GPU test of one gate level: its bare level fails, its recorded solutions clear, its pins hold. */
export function rubeGpuSuite(def: LevelDef): void {
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    try {
      player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe('Rube Lab on the GPU solver', () => {
    it(`${def.id} ${def.name}: the recorded solutions clear, the bare level fails, pins hold`, async (ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      const bare = await player.rube(def);
      expect(bare.cleared, 'the bare level').toBe(false);
      expect(bare.pinnedMove, bare.pinnedAt).toBe(0);
      for (const sol of RUBE_SOLUTIONS[def.id]!) {
        const b = build(def, sol.steps)!;
        const r = await player.rube(b.def);
        console.log(`${def.id} ${sol.family} on ${player.adapter}: ${r.cleared ? 'clear' : 'FAIL'}, rung at ${r.rungAt} of ${r.steps} steps, pins ${r.pinnedMove}, ${(r.ms / 1000).toFixed(1)} s`);
        expect(r.cleared, `${sol.label} clears`).toBe(true);
        expect(r.steps - r.rungAt, `${sol.label}: steps from the ring to the end (PT32)`).toBe(RUBE_END_AFTER * 60);
        expect(r.pinnedMove, `${sol.label}: pins move (${r.pinnedAt})`).toBe(0);
      }
    }, 10 * MINUTES);
  });
}

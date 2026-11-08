// Fuse & Fold's domino-fuse levels on the GPU solver (M5b, docs/game/fuse-and-fold.md, "Domino fuses"), one level per
// test file (fuse-gpu-F*.test.ts), through the game's cast page (the game's own engine and settings): the order gate's
// naive build (every lane straight) misses the objective and its best build folds the frame into its lot, by the gate's
// tenth, on a nudged build (three with TB_CHANNEL or PHYSICS_GPU_SLOW=1), as on the reference (fuse-ref.ts). SwiftShader in
// CI; Metal with TB_CHANNEL=chrome.
//
// The objective itself is asserted as the gate asserts it, on most builds rather than every one: a fold within the
// lot's 5% spill is a knife edge of a piece or two of the building, and on the GPU solver F8's gated best (+3) spills
// 5.4% on build 1 and clears the other 7 of 8 (its +2 likewise misses only build 5, at 6.4%; both clear all 8 on the
// reference). Every build must still fold, keep the heritage whole and land within twice the spill allowance.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUSE_DOMINO_LEVELS } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { built, firing, sweepBuilds } from '../src/fuse-gate.ts';
import { DOMINO_BEST } from '../src/fuse-domino-best.ts';

const MINUTES = 60_000;

/** A fold sample's spill, from its metric (fold = collapse x (1 - spill), outcome.ts foldValue). */
export const sampleSpill = (z: { collapse: number; fold?: number }): number => (z.collapse > 0 ? 1 - (z.fold ?? 0) / z.collapse : 0);

/** Builds of n the best build must clear: every one of 1 or 2, two of 3 (the gate asks 80% of 8; a 7-in-8 build passes 2 of 3). */
export const metNeeded = (n: number): number => (n <= 2 ? n : Math.ceil((2 * n) / 3));

/** Registers the GPU test of one domino-fuse level. */
export function fuseGpuSuite(id: string): void {
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    try {
      player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe('domino fuses on the GPU solver', () => {
    it(`${id}: the straight build misses the fold, the gate's best build meets it`, async (ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      const lvl = FUSE_DOMINO_LEVELS.find((l) => l.id === id)!, b = DOMINO_BEST[id]!, builds = sweepBuilds(b.site, b.order);
      const naive = builds[0]!, best = builds.find((x) => x.name === b.best)!;
      expect(best, b.best).toBeDefined();
      // One nudged build on SwiftShader (two plays, about 2 min: the file stays inside CI's budget); three on a real GPU or nightly.
      const nudges = process.env.TB_CHANNEL || process.env.PHYSICS_GPU_SLOW === '1' ? [1, 2, 3] : [1];
      const obj = lvl.objective;
      if (obj.kind !== 'fold') throw new Error(`${id} is not a fold level`);
      let met = 0;
      for (const n of nudges) {
        const [p] = await player.play(built(lvl, naive), [[firing(lvl)]], [n]), [q] = await player.play(built(lvl, best), [[firing(lvl)]], [n]);
        const a = p!.samples.at(-1)!, z = q!.samples.at(-1)!;
        console.log(`${id} on ${player.adapter}, build ${n}: straight fold ${a.fold?.toFixed(3)} met ${a.met}; ${b.best} fold ${z.fold?.toFixed(3)} met ${z.met}; ${player.playMs.slice(-2).map((ms) => (ms / 1000).toFixed(1)).join(', ')} s`);
        for (const r of [p!, q!]) { expect(r.complete).toBe(true); expect(r.limits).toEqual([]); }
        expect(a.met).toBe(false);
        expect(z.heritage).toBe(0);
        expect(z.collapse).toBeGreaterThanOrEqual(obj.min);
        expect(sampleSpill(z), 'spill').toBeLessThanOrEqual(2 * obj.spillMax);
        expect(z.fold! - a.fold!).toBeGreaterThanOrEqual(0.1);
        if (z.met) met++;
      }
      expect(met, `${b.best} met on ${met} of ${nudges.length} builds`).toBeGreaterThanOrEqual(metNeeded(nudges.length));
    }, 20 * MINUTES);
  });
}

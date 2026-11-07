// Fuse & Fold's domino-fuse levels on the GPU solver (M5b, docs/game/fuse-and-fold.md, "Domino fuses"), one level per
// test file (fuse-gpu-F*.test.ts), through the game's cast page (the game's own engine and settings): the order gate's
// naive build (every lane straight) misses the objective and its best build meets it, by the gate's tenth, on a nudged
// build (two with TB_CHANNEL or PHYSICS_GPU_SLOW=1), as on the reference (fuse-ref.ts). SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FUSE_DOMINO_LEVELS } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { built, firing, sweepBuilds } from '../src/fuse-gate.ts';
import { DOMINO_BEST } from '../src/fuse-domino-best.ts';

const MINUTES = 60_000;

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
      // One nudged build on SwiftShader (two plays, about 2 min: the file stays inside CI's budget); two on a real GPU or nightly.
      const nudges = process.env.TB_CHANNEL || process.env.PHYSICS_GPU_SLOW === '1' ? [1, 2] : [1];
      for (const n of nudges) {
        const [p] = await player.play(built(lvl, naive), [[firing(lvl)]], [n]), [q] = await player.play(built(lvl, best), [[firing(lvl)]], [n]);
        const a = p!.samples.at(-1)!, z = q!.samples.at(-1)!;
        console.log(`${id} on ${player.adapter}, build ${n}: straight fold ${a.fold?.toFixed(3)} met ${a.met}; ${b.best} fold ${z.fold?.toFixed(3)} met ${z.met}; ${player.playMs.slice(-2).map((ms) => (ms / 1000).toFixed(1)).join(', ')} s`);
        for (const r of [p!, q!]) { expect(r.complete).toBe(true); expect(r.limits).toEqual([]); }
        expect(a.met).toBe(false);
        expect(z.met).toBe(true);
        expect(z.heritage).toBe(0);
        expect(z.fold! - a.fold!).toBeGreaterThanOrEqual(0.1);
      }
    }, 20 * MINUTES);
  });
}

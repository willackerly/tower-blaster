// Mason's Trial's judge on the GPU solver (M8, docs/game/masons-trial.md), one level per
// test file (mason-gpu-MT*.test.ts), through the game's cast page (the game's engine,
// sized for the judge's islands: engines.ts makeMasonEngine): the 3-star author's build
// passes in the judge's first 16 worlds at once about as on the reference (the stars keep
// MASON_STAR_SHARE of slack for this), the bare level fails, no island leaks, and the
// engine hits no limit. SwiftShader runs on the CPU, so its cost grows with the worlds'
// bodies: CI judges 16 worlds. With PHYSICS_GPU_SLOW=1 both authors run in all 64 worlds
// (SwiftShader, 2026-11-07: every author within 1 world of the reference; MT2's bare level
// 20/64 against 19), and the judge's verify runs on the GPU too: the knife-edge build in
// 16 islands against the same 16 worlds alone. SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type LevelDef, MASON_CLEAR, MASON_WORLDS } from '@tb/keystone';
import { channelOf, requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { MASON_KNIFE, MASON_SOLUTIONS, MASON_STAR_SHARE, masonBuild } from '../src/mason-solutions.ts';
import { fisherExact } from '../src/mason-stats.ts';

const MINUTES = 60_000, SLOW = process.env.PHYSICS_GPU_SLOW === '1';
const range = (n: number) => Array.from({ length: n }, (_, k) => k);
const builtDef = (def: LevelDef, steps: Parameters<typeof masonBuild>[1]) => {
  const r = masonBuild(def, steps);
  if ('refused' in r) throw new Error(`${def.id}: refused (${r.refused})`);
  return r.def;
};

/**
 * Registers the GPU tests of one Mason level. CI (O5) runs them for one representative level
 * (`representative`, MT4: mason-gpu-MT4.test.ts) and for MT5, the only level whose test is a quake (field events
 * through the islands on the GPU); the rest run with PHYSICS_GPU_SLOW=1 (nightly).
 */
export function masonGpuSuite(def: LevelDef, representative = false): void {
  const RUN = representative || SLOW;
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    if (!RUN) return;
    try {
      const channel = channelOf();
      player = await openBrowserCastPlayer(channel ? { channel } : {});
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe("Mason's Trial on the GPU solver", () => {
    it.runIf(RUN)(`${def.id} ${def.name}: the authors pass in ${SLOW ? 64 : 16} islands, the bare level fails`, async (ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      // A channel asks for the real GPU (TB_CHANNEL=chrome on the Mac): a software adapter under it is not that run (#234, S5).
      if (channelOf()) expect(player.software, `channel ${channelOf()} gave a software adapter (${player.adapter})`).toBe(false);
      const K = SLOW ? MASON_WORLDS : 16, worlds = range(K);
      const bare = await player.mason(def, worlds);
      console.log(`${def.id} bare on ${player.adapter}: ${bare.passes}/${K}, ${(bare.ms / 1000).toFixed(1)} s`);
      expect(bare.passes).toBeLessThan(K * MASON_CLEAR);
      expect(bare.leaks).toBe(0);
      for (const b of MASON_SOLUTIONS[def.id]!.filter((x) => SLOW || x.tier === 3)) {
        const v = await player.mason(builtDef(def, b.steps), worlds);
        console.log(`${def.id} T${b.tier} ${b.label} on ${player.adapter}: ${v.passes}/${K} (reference ${b.measured!.passes}), ${(v.ms / 1000).toFixed(1)} s`);
        expect(v.limits).toEqual([]);
        expect(v.leaks).toBe(0);
        expect(v.passes, b.label).toBeGreaterThanOrEqual(Math.floor((MASON_STAR_SHARE * K * b.measured!.passes) / MASON_WORLDS));
      }
    }, (SLOW ? 30 : 8) * MINUTES);

    it.runIf(SLOW)(`${def.id}: the judge's verify on the GPU (the knife in 16 islands against 16 solo runs)`, async (ctx) => {
      if (!player) return ctx.skip();
      const K = 16, d = builtDef(def, MASON_KNIFE[def.id]!.steps), v = await player.mason(d, range(K));
      let solo = 0, agree = 0;
      for (let k = 0; k < K; k++) {
        const s = (await player.mason(d, [k])).pass[0]!;
        solo += s ? 1 : 0;
        agree += s === v.pass[k] ? 1 : 0;
      }
      const p = fisherExact(v.passes, K - v.passes, solo, K - solo);
      console.log(`${def.id} knife on ${player.adapter}: islands ${v.passes}/${K}, solo ${solo}/${K}, same verdict in ${agree}, Fisher p ${p.toFixed(3)}`);
      expect(p).toBeGreaterThan(0.05);
    }, 60 * MINUTES);
  });
}

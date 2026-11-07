// Aftershock's retrofits on the GPU solver (M7b, docs/game/aftershock.md "Retrofit"), one shipped level per test file
// (retrofit-gpu-A*.test.ts, so each file stays well under CI's per-file budget on SwiftShader), through the game's
// cast page (the game's own engine and settings): the bare level loses a protected tower to the level's quake, each
// recorded bracing (retrofit-solutions.ts) keeps every one standing, and the wrong builds do not, as on the reference
// (retrofit-ref.ts). One un-nudged play each: the nudged robustness is the reference's. SwiftShader in CI; Metal with
// TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LevelDef } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { fixedQuake } from '../src/retrofit-search.ts';
import { RETROFIT_SOLUTIONS, RETROFIT_WRONG, retrofitBuild } from '../src/retrofit-solutions.ts';

const MINUTES = 60_000;

export function retrofitGpuSuite(def: LevelDef): void {
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    try {
      player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe('Aftershock retrofits on the GPU solver', () => {
    it(`${def.id} ${def.name}: the bare level and the wrong builds lose a tower, the recorded bracings save them all`, async (ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      const quake = [fixedQuake(def)];
      const plays = [
        { label: 'nothing placed', def, met: false },
        ...RETROFIT_SOLUTIONS[def.id]!.map((s) => ({ label: s.label, def: retrofitBuild(def, s).def, met: true })),
        ...RETROFIT_WRONG[def.id]!.slice(1).map((w) => ({ label: w.label, def: retrofitBuild(def, w).def, met: false })),
      ];
      for (const p of plays) {
        const [r] = await player.play(p.def, [quake]), end = r!.samples.at(-1)!;
        console.log(`${def.id} ${p.label} on ${player.adapter}: ${r!.steps} steps, heritage ${end.heritage}, met ${end.met}; ${(player.playMs.at(-1)! / 1000).toFixed(1)} s`);
        expect(r!.complete, p.label).toBe(true);
        expect(r!.limits, p.label).toEqual([]);
        expect(end.met, p.label).toBe(p.met);
        if (p.met) expect(end.heritage, p.label).toBe(0);
      }
    }, 12 * MINUTES);
  });
}

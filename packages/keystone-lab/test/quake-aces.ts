// Aftershock's shipped levels on the GPU solver (M7, docs/game/aftershock.md), the suite quake-aces-gpu.test.ts and
// quake-aces-gpu-2.test.ts share: each level's ace, the quake its three stars were cast from on the reference engine
// (keystone-lab quake-search.ts quakeStars), clears the level as shipped (its own pre-settle) through the game's cast
// page, with no heritage broken and within the third star's energy. So a player on the game's engine can earn what
// the stars promise. Two files, since a file runs on one CI worker and five plays on SwiftShader near its budget.
// SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, quakeEnergy, type QuakeShot } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;

export function acesSuite(levels: readonly LevelDef[]): void {
  let player: BrowserCastPlayer | null = null;
  beforeAll(async () => {
    try {
      player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 3 * MINUTES);
  afterAll(async () => { await player?.close(); });

  describe('the shipped Aftershock levels on the GPU solver', () => {
    for (const level of levels) {
      it(`${level.id} ${level.name}: the ace clears it, heritage whole, inside the third star`, async (ctx) => {
        if (!player) return ctx.skip();
        const ace = level.solutions!.ace!, [r] = await player.play(level, [ace]);
        const end = r!.samples.at(-1)!;
        console.log(`${level.id} on ${player.adapter}: ${r!.steps} steps, crowns ${end.crowns}, heritage ${end.heritage}, met ${end.met}; ${(player.playMs.at(-1)! / 1000).toFixed(1)} s`);
        expect(r!.complete).toBe(true);
        expect(r!.limits).toEqual([]);
        expect(end.met).toBe(true);
        expect(end.heritage).toBe(0);
        expect(quakeEnergy(compileLevel(level), ace[0] as QuakeShot)).toBeLessThanOrEqual(level.stars!.t3);
      }, 6 * MINUTES);
    }
  });
}

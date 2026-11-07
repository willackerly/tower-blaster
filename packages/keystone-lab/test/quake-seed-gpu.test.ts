// Aftershock's seeded dials on the GPU solver (PT25, docs/game/aftershock.md "The dial's starting quake"): on the
// game's engine, pressing Start on a seeded level scores above 0 (a condemned tower down, fewer protected broken) and
// does not clear it (the levers are still the player's). This is the agent playtest's novice run on Big Brother (A2),
// which scored 0 on the old start, through the game's cast page. SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AFTERSHOCK_LEVELS, quakeRulesOf, type QuakeShot } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
const SEEDED = AFTERSHOCK_LEVELS.filter((l) => quakeRulesOf(l).start);

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('the seeded dials on the GPU solver', () => {
  it('Big Brother (A2) is seeded: the agent playtest\'s novice run scored 0 there', () => {
    expect(SEEDED.map((l) => l.id)).toContain('A2');
  });

  for (const level of SEEDED) {
    it(`${level.id} ${level.name}: Start on the seeded dial scores above 0 and leaves the level to clear`, async (ctx) => {
      if (!player) return ctx.skip();
      const seed: QuakeShot = { ammo: 'quake', ...quakeRulesOf(level).start! }, [r] = await player.play(level, [[seed]]);
      const end = r!.samples.at(-1)!;
      console.log(`${level.id} seed ${JSON.stringify(seed)} on ${player.adapter}: crowns ${end.crowns}, heritage ${end.heritage}, score ${end.score}, met ${end.met}`);
      expect(r!.complete).toBe(true);
      expect(end.score).toBeGreaterThan(0);
      expect(end.met).toBe(false);
    }, 6 * MINUTES);
  }
});

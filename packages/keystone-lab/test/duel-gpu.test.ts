// PT5's balance on the GPU solver (agent playtest round 2): the cast page plays a novice Siege Table duel
// (game duel-bot.ts) on the game's own engine for the table, as `pnpm duel:bot --engine gpu` does for the balance
// table. One seeded duel per table here (SwiftShader takes about two minutes a duel): it ends decided after at least
// two turns, as the Rapier test asks, with no click on the bot's own blocks on Two Keeps. The 40-60% win-rate
// check is the CLI's table (docs/game/agent-playtest-2.md), not a CI test: it needs tens of duels.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1, D2 } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('novice duels on the GPU solver (cast page)', () => {
  for (const [id, def] of [['D1', D1], ['D2', D2]] as const) it(`${id}: a seeded novice duel ends decided after at least two turns`, async (ctx) => {
    if (!player) return ctx.skip();
    const r = await player.duel(id, 0, 5000, 1.6);
    console.log(`${id} on ${player.adapter}: ${JSON.stringify(r)}`);
    expect(r.over, JSON.stringify(r)).toBe(true);
    expect(r.turns).toBeGreaterThanOrEqual(2);
    if (def.ruleset === 'keeps') expect(r.own).toBe(0);
  }, 15 * MINUTES);
});

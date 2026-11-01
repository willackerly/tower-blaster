// The game's per-round check of the GPU engine's limits (play.ts checkRound):
// a round that drops broadphase pairs is reported once it is over, and the
// level's later rounds are built with the room the engine names (roomAfter).
// Every level holds every pair of its bodies (gpuOptions), so the test starts
// L1 at 2 pairs per body (?pairsPerBody=2), which the pre-settle overflows.
import { describe, expect, it } from 'vitest';
import { limitsHit } from '@tb/engine-api';
import { compileLevel, L1 } from '@tb/keystone';
import { gpuOptions } from '../src/engines.ts';
import { gamePage } from './page.ts';

const MINUTES = 60_000;

describe('game: a round that drops pairs', () => {
  const game = gamePage();
  it('is reported when it ends, and the level\'s next round gets the room the engine names', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=gpu&pairsPerBody=2', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    const read = () => page.evaluate(async () => ({ pairsPerBody: window.__game.pairsPerBody, limitsHit: window.__game.limitsHit, health: await window.__game.health(), step: window.__game.state().step }));
    const first = await read();
    expect(first.pairsPerBody).toBe(2);
    const hit = limitsHit(first.health);
    expect(hit.map((l) => l.id)).toEqual(['pairs']);
    const fix = hit[0]!.fix!.value as number;
    const { capacity, pairsPerBody: every } = gpuOptions(compileLevel(L1));
    expect(fix * capacity).toBeGreaterThanOrEqual(1.25 * hit[0]!.peak);
    // Not reported while the round is still open.
    expect(first.limitsHit).toEqual([]);
    console.log(`L1 at 2 pairs per body: ${hit[0]!.message}; next round ${fix} per body (every pair is ${every})`);

    // Retry ends the round: it is checked, reported, and the new round is built with the fix.
    await page.evaluate(() => window.__game.retry());
    const second = await read();
    expect(second.pairsPerBody).toBe(fix);
    expect(second.limitsHit).toEqual([hit[0]!.message]);
    expect(await page.locator('#banner').textContent()).toBe('Physics limit hit: next round gets more room');
    // The new round's pre-settle dropped nothing.
    expect(limitsHit(second.health)).toEqual([]);
    expect(second.health!.steps).toBe(second.step);

    // A clean round changes nothing: the level keeps its room, and the last report stands.
    await page.evaluate(() => window.__game.retry());
    const third = await read();
    expect(third.pairsPerBody).toBe(fix);
    expect(third.limitsHit).toEqual([hit[0]!.message]);
    expect(limitsHit(third.health)).toEqual([]);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});

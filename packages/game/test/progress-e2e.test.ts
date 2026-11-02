// Progress on the game page (roadmap G7): a finished round is recorded in the
// browser and survives a reload; a custom run (a URL override) is not recorded;
// ?progress=off records for this visit only. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, type Shot, writeShots } from '@tb/keystone';
import { PROGRESS_KEY } from '../src/progress.ts';
import { gamePage } from './page.ts';

const game = gamePage();
const line = writeShots(L1.solutions!.par as Shot[]);
const hash = compileLevel(L1).hash;
const ended = { timeout: 120_000, polling: 100 };

describe('game page progress', () => {
  it('records the round at its end and reads it back after a reload', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&keystone.shots=${line}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, ended);
    const stars = await page.evaluate(() => window.__game.result!.stars);
    expect(stars).toBeGreaterThan(0);
    const stored = await page.evaluate((k) => JSON.parse(localStorage.getItem(k)!), PROGRESS_KEY);
    expect(stored.levels.L1).toMatchObject({ hash, plays: 1, stars });

    await page.goto(game.url('/?level=L1&engine=rapier&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'running', undefined, ended);
    expect(await page.evaluate((h) => window.__progress.best('L1', h), hash)).toMatchObject({ plays: 1, stars });
    expect(errors).toEqual([]);
    await page.close();
  });
  it('does not record a custom run, nor anything under ?progress=off', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const extra of ['keystone.iterations=41', 'progress=off']) {
      const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&${extra}&keystone.shots=${line}`);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await page.evaluate(() => { window.__game.fast = true; });
      await page.waitForFunction(() => window.__game.result !== null, undefined, ended);
      expect(await page.evaluate((k) => localStorage.getItem(k), PROGRESS_KEY), extra).toBeNull();
      expect(errors).toEqual([]);
      await page.close();
    }
  });
});

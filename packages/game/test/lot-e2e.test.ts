// The Lot Sheet on the game page (docs/game/lot-sheets.md): L1's goals show in the HUD, are judged on
// the round as the page plays it to the same verdicts as headless facts of the same line on the same
// engine, show on the result card, and the met ones are kept in progress. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, goalMet, L1, lotSheetOf, roundFacts, runSession, selectGroups, type Shot, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage } from './page.ts';

const game = gamePage();

describe('game page, Lot Sheet', () => {
  it("shows L1's goals, judges them as headless facts do, lists them on the result card and records the met ones", async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const sheet = lotSheetOf('L1')!, line = L1.solutions!.par as Shot[];
    const o = await game.open(`/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.shots=${writeShots(line)}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });

    const c = compileLevel(L1), r = await runSession(new RapierEngine(), c, line, driverOptions('rapier'));
    const f = roundFacts(c, r.session, r.snapshot, selectGroups(c, sheet.groups ?? {}));
    const want = sheet.goals.map((g) => ({ id: g.id, text: g.text, met: goalMet(g.when, f), before: false }));
    expect(await page.evaluate(() => window.__game.goals)).toEqual(want);
    const met = want.filter((g) => g.met).length;
    expect(met, 'the par line meets some goal, so the check is not vacuous').toBeGreaterThan(0);
    expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).toMatch(/Lot sheet/);
    expect(await page.evaluate(() => document.querySelector('.kg-result')!.textContent)).toContain(`${met} / ${want.length}`);
    // A long sheet never pushes the card's buttons off a short screen (640 x 400 here): the card scrolls.
    expect(await page.evaluate(() => { const r = document.querySelector('.kg-result')!.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
    expect(await page.evaluate(() => window.__progress.progress.levels.L1?.goals ?? [])).toEqual(want.filter((g) => g.met).map((g) => g.id));
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});

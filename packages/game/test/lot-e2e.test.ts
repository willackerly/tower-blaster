// The Lot Sheet on the game page (docs/game/lot-sheets.md): L1's goals show in the HUD, are judged on
// the round as the page plays it to the same verdicts as headless facts of the same line on the same
// engine, show on the result card, and the met ones are kept in progress. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, goalMet, L1, lotSheetOf, roundFacts, runSession, selectGroups, type Shot, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

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

  it('PT18: on the desktop the HUD keeps the sheet to its count line until the first clear; the line opens and closes it; keystone.sheet=open lists it', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const desk = { viewport: { width: 1280, height: 800 } };
    const hud = (page: import('playwright').Page) => page.evaluate(() => ({ h: document.querySelector('.kg-hud')!.getBoundingClientRect().height, items: document.querySelectorAll('.kg-hud .goals li').length, closed: !!document.querySelector('.kg-hud .goals.closed') }));
    const line = L1.solutions!.par as Shot[];
    // A first visit (no progress): the count line only, until the round's clear.
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&progress=off&door=0', undefined, desk);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 120_000);
    const shut = await hud(page);
    expect(shut).toMatchObject({ items: 0, closed: true });
    await page.locator('.kg-hud .goals-head').click();
    const open = await hud(page);
    expect(open.items).toBe(lotSheetOf('L1')!.goals.length);
    console.log(`L1 desktop HUD: ${shut.h.toFixed(0)} px with the sheet closed, ${open.h.toFixed(0)} px open`);
    expect(open.h - shut.h).toBeGreaterThan(40);
    await page.locator('.kg-hud .goals-head').click();
    expect(await hud(page)).toMatchObject({ items: 0, closed: true });
    // The clear opens it by itself: L1's par line, shot by shot.
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [k, shot] of line.entries()) {
      await ready(page, 120_000);
      expect(await page.evaluate((x) => window.__game.fire(x), shot)).toBe(true);
      await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), k + 1, { timeout: 120_000, polling: 100 });
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    expect((await hud(page)).closed).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
    const o2 = await game.open('/?level=L1&engine=rapier&offscreen=1&progress=off&door=0&keystone.sheet=open', undefined, desk);
    if (!o2) return ctx.skip();
    await ready(o2.page, 120_000);
    expect(await hud(o2.page)).toMatchObject({ items: lotSheetOf('L1')!.goals.length, closed: false });
    expect(o2.errors).toEqual([]);
    await o2.page.close();
  }, 300_000);
});

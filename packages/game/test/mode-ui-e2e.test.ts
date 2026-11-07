// Each new mode's own HUD on the game page (mode-ui.ts; agent playtest round 2, PT23's verify): Fuse & Fold,
// Aftershock and Rube Lab show no Power or Height row, no rack chip and no "fire" help, before the shot and after
// it; Aftershock's aim view has one start (the quake's Start, no opener); Rube Lab has one Run control at a time,
// and the Build panel's Run plays the build and releases the ball by itself. Rapier, for speed.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();

/** What the page shows of the projectile controls and the start verbs (visible elements only). */
const look = (page: Page) => page.evaluate(() => {
  const shown = (e: Element) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== 'hidden'; };
  const hud = document.querySelector('.kg-hud') as HTMLElement;
  const help = document.getElementById('help') as HTMLElement | null;
  const starts = [...document.querySelectorAll('.kg-hud .opener, .kg-hud .quake-go, .kg-build button[data-a="play"], .kg-fuse button.plunge, .kg-fuse [data-act="plunger"]')].filter(shown).map((b) => (b.textContent ?? '').replace(/\s+/g, ' ').trim());
  return {
    aimRows: /Power|Height/.test(hud.innerText),
    chips: [...hud.querySelectorAll('[data-act="ammo"]')].filter(shown).length,
    // The help's fire words are in .h-fire spans the mode hides (their own display, whether or not the help is shown
    // on this page), and no visible text in the HUD's touch hint names firing.
    fireHelp: [...document.querySelectorAll('.h-fire')].some((e) => getComputedStyle(e).display !== 'none')
      || /fire/.test((hud.querySelector('.tch-hint') as HTMLElement | null)?.textContent ?? '') || /fire/.test(help?.querySelector('.h-look')?.textContent ?? ''),
    starts,
  };
});

describe("each new mode's HUD on the page (PT23)", () => {
  it('Aftershock A1: no projectile rows, chips or fire help, before or after the quake; one start, the quake\'s', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=A1&engine=rapier&offscreen=1&door=0&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.waitForSelector('.kg-hud .quake-panel', { timeout: 30_000 });
    const before = await look(page);
    expect(before).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    expect(before.starts).toHaveLength(1);
    expect(before.starts[0]).toMatch(/Start/);
    // F, the opener's key, plays nothing: the quake's ace is no longer offered as an opener.
    await page.keyboard.press('f');
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 30_000, polling: 50 });
    expect(await look(page)).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('Fuse & Fold F1: no projectile rows, Plunger chip or fire help; the Timeline\'s Plunger is the start', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=F1&engine=rapier&offscreen=1&door=0&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await look(page)).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 30_000, polling: 50 });
    expect(await look(page)).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    // keystone.modeui=0 is the projectile HUD again: the Plunger chip is back.
    const old = await game.open('/?level=F1&engine=rapier&offscreen=1&door=0&progress=off&keystone.modeui=0');
    if (old) {
      await ready(old.page);
      expect(await look(old.page)).toMatchObject({ chips: 1, fireHelp: true });
      await old.page.close();
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('Rube Lab RL1: one Run at a time (the Build panel\'s while building, the HUD\'s after), and Run releases the ball', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=RL1&engine=rapier&offscreen=1&door=0&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit?.on === true, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const building = await look(page);
    expect(building).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    expect(building.starts).toEqual([expect.stringMatching(/^Run/)]);
    // Run: the level as built loads, grows in and the ball goes, with no second button.
    await page.click('.kg-build button[data-a="play"]');
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 2 * MINUTES, polling: 50 });
    expect(await look(page)).toMatchObject({ aimRows: false, chips: 0, fireHelp: false });
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 4 * MINUTES, polling: 250 });
    // Retry opens without the build phase: the HUD's Run is then the one start.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 0, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const again = await look(page);
    expect(again.starts).toEqual([expect.stringMatching(/Run: release the ball/)]);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});

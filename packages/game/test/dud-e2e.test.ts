// The dud note on the game page (PT31, agent playtest 2, J1 #6): a shot that moved nothing floats one line saying
// so and what to try; a shot that brings blocks down does not; keystone.dudnote=0 keeps it quiet; a retry clears it.
// After a dud the round's leverage drops, and the card says why (the peak and the shot that pulled it down).
// Rapier, headless Chromium; the note's pure parts are dud.test.ts.
import { describe, expect, it } from 'vitest';
import type { Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
/** A marble well wide of L2's lintel: it moves nothing (a zero-collapse shot). */
const wide: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot;
type Page = import('playwright').Page;
const note = (page: Page) => page.evaluate(() => {
  const el = document.querySelector<HTMLElement>('.kg-note');
  return { text: window.__game.shotNote, shown: el?.classList.contains('show') ?? false, html: el?.textContent ?? null };
});
async function fireWide(page: Page, strokes: number) {
  expect(await page.evaluate((s) => window.__game.fire(s), wide)).toBe(true);
  await page.waitForFunction((k) => window.__game.ready && window.__game.strokes === k, strokes, { timeout: 2 * MINUTES, polling: 100 });
}

describe('the dud note on the game page (PT31)', () => {
  it('L2: a marble that moved nothing says so and names the cannonball; a retry clears it', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L2&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await note(page)).toEqual({ text: '', shown: false, html: null });
    await page.evaluate(() => { window.__game.fast = true; });
    await fireWide(page, 1);
    expect(await note(page)).toEqual({ text: 'Nothing moved: try the cannonball', shown: true, html: 'Nothing moved: try the cannonball' });
    await page.evaluate(() => window.__game.retry());
    await ready(page);
    expect((await note(page)).text).toBe('');
    expect((await note(page)).shown).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('B1: the opener, then a bomb wide of the wall, then Bank: the card names the leverage peak and the shot that pulled it down', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=B1&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate(() => window.__game.fireOpener())).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate((s) => window.__game.fire(s), { ...wide, ammo: 'w-bomb' } as Shot)).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 2, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect((await note(page)).text).toMatch(/^Nothing moved: /);
    expect(await page.evaluate(() => window.__game.bank())).toBe(true);
    await page.waitForFunction(() => window.__game.result !== null && document.querySelector('.kg-result')?.textContent?.includes('leverage'), undefined, { timeout: 2 * MINUTES, polling: 100 });
    const card = (await page.evaluate(() => document.querySelector('.kg-result')!.textContent!)).replace(/\s+/g, ' ');
    // The opener's leverage, halved by a bomb's energy that brought nothing down: the card says so.
    expect(card).toMatch(/leverage ×(\d+\.\d\d) · ×(\d+\.\d\d) until shot 2 added energy but almost nothing fell/);
    const [, now, was] = card.match(/leverage ×(\d+\.\d\d) · ×(\d+\.\d\d)/)!;
    expect(Number(now)).toBeLessThan(0.9 * Number(was));
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('keystone.dudnote=0: the same shot floats nothing', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L2&engine=rapier&look=candy&offscreen=1&progress=off&keystone.dudnote=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    await fireWide(page, 1);
    expect(await note(page)).toEqual({ text: '', shown: false, html: null });
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

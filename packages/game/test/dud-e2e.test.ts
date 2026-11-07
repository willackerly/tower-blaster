// The dud note on the game page (PT31, agent playtest 2, J1 #6): a shot that moved nothing floats one line saying
// so and what to try; a shot that brings blocks down does not; keystone.dudnote=0 keeps it quiet; a retry clears it.
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

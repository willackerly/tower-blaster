// Chorus on the game page (M9, docs/game/chorus.md): CH1 loads as 64 worlds with the panel showing, the one
// shot plays into all of them, the round ends with the worlds' score (the card reads "c of 64 worlds
// cleared", stars from the count), and the panel's count and tile states match the engine's judgement.
// keystone.chorusview=strip and =off change only the panel. Rapier (6.4k bodies run in seconds there),
// headless Chromium; the islands' physics is keystone-lab's chorus tests.
import { describe, expect, it } from 'vitest';
import { CH1, chorusLine, chorusOf } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;

describe('a Chorus level on the game page', () => {
  it('CH1: the panel shows 64 worlds, the shot plays into all of them, and the card scores the worlds cleared', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=CH1&engine=rapier&look=candy&offscreen=1&progress=off', 3 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 3 * MINUTES);
    const before = await page.evaluate(() => ({ hidden: window.__chorus.el.hidden, mode: window.__chorus.el.dataset.mode, text: window.__chorus.el.textContent, w: window.__chorus.el.querySelector('canvas')!.style.width }));
    expect(before).toEqual({ hidden: false, mode: 'grid', text: '64 worlds: one shot fires into all of them', w: `${8 * 33 - 3}px` });
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), chorusLine('CH1', 'obvious')[0]!)).toBe(true);
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 4 * MINUTES, polling: 200 });
    const after = await page.evaluate(() => ({ score: window.__game.result!, j: window.__chorus.judgement!, text: window.__chorus.el.querySelector('.count')!.textContent, card: document.querySelector('.kg-result')?.textContent ?? '' }));
    expect(after.j.worlds).toBe(64);
    expect(after.j.leaks).toBe(0);
    expect(after.score.worlds).toEqual({ cleared: after.j.clears, of: 64, thresholds: chorusOf(CH1)!.stars });
    expect(after.score.stamp).toBe(`${after.j.clears}/64 CLEAR`);
    expect(after.text).toBe(`${after.j.clears} of 64 clear`);
    expect(after.card).toContain(`${after.j.clears} of 64 worlds cleared`);
    // The round's end reads the engine (limits, the save): a Chorus engine over Rapier must not fail it.
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => ({ s: window.__game.status, e: window.__game.error }))).toEqual({ s: 'running', e: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 8 * MINUTES);

  it('keystone.chorusview=strip draws the heat strip, =off only the count; a level without Chorus hides the panel', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const [mode, width] of [['strip', `${64 * 7 - 1}px`], ['off', null]] as const) {
      const o = await game.open(`/?level=CH1&engine=rapier&look=candy&offscreen=1&progress=off&keystone.chorusview=${mode}`, 3 * MINUTES);
      if (!o) return ctx.skip();
      await ready(o.page, 3 * MINUTES);
      const got = await o.page.evaluate(() => { const cv = window.__chorus.el.querySelector('canvas')!; return { mode: window.__chorus.el.dataset.mode, shown: getComputedStyle(cv).display !== 'none', w: cv.style.width }; });
      expect(got.mode).toBe(mode);
      expect(got.shown).toBe(width !== null);
      if (width) expect(got.w).toBe(width);
      expect(o.errors).toEqual([]);
      await o.page.close();
    }
    const plain = await game.open('/?level=L1&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!plain) return ctx.skip();
    await ready(plain.page);
    expect(await plain.page.evaluate(() => window.__chorus.el.hidden)).toBe(true);
    await plain.page.close();
  }, 8 * MINUTES);
});

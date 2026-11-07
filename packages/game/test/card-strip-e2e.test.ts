// The phone result strip (layout.ts card strip, docs/game/phone-hud.md; agent playtest round 2, PT30): on every phone
// result frame the card covered what the shot destroyed, and the camera may not move on its own to show it. The
// opening view framed the structure inside the band the docked HUD leaves free (PT3b), and the camera has not moved
// since, so a card kept to the HUD's own band (the tray's upright, the rail's sideways) covers none of the scene the
// view framed. Checked at 390x844 and 844x390, on a cleared round with a lot sheet (L1) and a failed one (L5, a miss):
//   - the strip lies inside the HUD's opening band, and the view is the opening view;
//   - nothing in the strip is cut off (no scroll, no overflowing name), and every button is on screen and on top;
//   - Details opens the whole card with the lot sheet, all of it in view without scrolling (the round-2 frames had it
//     clipped behind the button bar); Less folds it again.
// Rapier, for speed.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { L1, type Shot } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const PHONES = [
  ['upright', { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
  ['sideways', { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true }],
] as const;
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };

/** The card's box, whether it scrolls, its name's overflow, and each visible button: on screen and the topmost element at its centre. */
const cardLook = (page: Page) => page.evaluate(() => {
  const card = document.querySelector('.kg-result.show') as HTMLElement;
  const r = card.getBoundingClientRect(), name = card.querySelector('.name') as HTMLElement;
  const visible = (e: Element) => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const buttons = [...card.querySelectorAll<HTMLElement>('button')].filter(visible).map((b) => {
    const q = b.getBoundingClientRect(), cx = q.left + q.width / 2, cy = q.top + q.height / 2;
    return { act: b.dataset.act, inside: q.left >= 0 && q.top >= 0 && q.right <= innerWidth && q.bottom <= innerHeight, onTop: document.elementFromPoint(cx, cy)?.closest('button') === b };
  });
  return {
    box: { l: r.left, t: r.top, r: r.right, b: r.bottom }, vw: innerWidth, vh: innerHeight,
    scrolls: card.scrollHeight > card.clientHeight + 1, nameCut: name.scrollWidth > name.clientWidth + 1,
    full: card.classList.contains('full'), strip: card.classList.contains('strip'),
    shown: { stamp: visible(card.querySelector('.stamp')!), stars: visible(card.querySelector('.stars')!), reason: card.querySelector('.reason') ? visible(card.querySelector('.reason')!) : null, lot: card.querySelector('.lot') ? visible(card.querySelector('.lot')!) : null, total: card.querySelector('.total') ? visible(card.querySelector('.total')!) : null },
    hudShown: [...document.querySelectorAll('.kg-hud > .st, .kg-hud > .tray')].map((e) => getComputedStyle(e).visibility !== 'hidden'),
    buttons,
  };
});

const viewOf = (page: Page) => page.evaluate(() => { const v = window.__game.view; return { target: v.target, distance: v.distance, yaw: v.yaw, pitch: v.pitch }; });

describe('the phone result strip (PT30)', () => {
  for (const [name, phone] of PHONES) it(`${name}: in the HUD's band, nothing cut off, Details opens the whole card in view`, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const [level, shots, failed] of [['L1', L1.solutions!.par as Shot[], false], ['L5', [miss], true]] as const) {
      const o = await game.open(`/?level=${level}&engine=rapier&offscreen=1&door=0&progress=off${failed ? '&keystone.rack=marble' : ''}`, 2 * MINUTES, phone);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 2 * MINUTES);
      const band = (await page.evaluate(() => window.__game.openingHud))!;
      expect(band, 'the docked HUD measured its band').not.toBeNull();
      const opening = await viewOf(page);
      await playShots(page, [...shots], 2 * MINUTES);
      await page.waitForFunction(() => window.__game.card.shownMs !== null && window.__game.result !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
      expect(await page.evaluate(() => window.__game.card.place)).toBe('strip');
      // The stamp and stars fade in within half a second in the strip; let them.
      await page.waitForTimeout(800);
      const s = await cardLook(page);
      const what = `${level} ${name}`;
      expect(s, what).toMatchObject({ strip: true, full: false, scrolls: false, nameCut: false, shown: { stamp: true, stars: true, total: false } });
      if (failed) expect(s.shown.reason, `${what}: the reason shows in the strip`).toBe(true);
      // In the HUD's band: the bottom one upright (below the tray's top), the left rail sideways.
      if (name === 'upright') expect(s.box.t, `${what}: strip top ${s.box.t} vs band from ${(1 - band.bottom) * s.vh}`).toBeGreaterThanOrEqual((1 - band.bottom) * s.vh - 0.5);
      else expect(s.box.r, `${what}: strip right ${s.box.r} vs rail to ${band.left * s.vw}`).toBeLessThanOrEqual(band.left * s.vw + 0.5);
      expect(s.box.b).toBeLessThanOrEqual(s.vh);
      // The camera moves only on player input: the view the band was measured for is the view at the result.
      expect(await viewOf(page)).toEqual(opening);
      // The HUD under the strip is hidden, not drawn through it: the tray upright, the rail sideways.
      expect(s.hudShown, what).toEqual(name === 'upright' ? [true, false] : [false, false]);
      expect(s.buttons.map((b) => b.act)[0]).toBe('card');
      for (const b of s.buttons) expect(b, `${what}: ${b.act}`).toMatchObject({ inside: true, onTop: true });
      await page.screenshot({ path: `${process.env.TB_SHOTS ?? '/tmp'}/pt30-${level}-${name}-strip.png` }).catch(() => {});

      // Details: the whole card, its lot sheet (L1) and total, nothing scrolled behind the buttons.
      await page.locator('.kg-result [data-act="card"]').click();
      await page.waitForTimeout(2500);
      const f = await cardLook(page);
      await page.screenshot({ path: `${process.env.TB_SHOTS ?? '/tmp'}/pt30-${level}-${name}-full.png` }).catch(() => {});
      expect(f, `${what} full`).toMatchObject({ full: true, scrolls: false, shown: { stamp: true, stars: true } });
      if (!failed) expect(f.shown, `${what} full`).toMatchObject({ lot: true, total: true });
      for (const b of f.buttons) expect(b, `${what} full: ${b.act}`).toMatchObject({ inside: true, onTop: true });
      await page.locator('.kg-result [data-act="card"]').click();
      expect(await page.evaluate(() => document.querySelector('.kg-result')!.classList.contains('full'))).toBe(false);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 8 * MINUTES);
});

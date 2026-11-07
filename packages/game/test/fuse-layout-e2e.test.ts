// Fuse & Fold's Timeline panel against the screen (agent playtest round 2, PT21; docs/game/fuse-and-fold.md, Panel
// layout). The panel never covers the result card or the Plunger:
//   - F4 (12 charges) at 1280 x 800, a phone upright (390 x 844) and on its side (844 x 390): at load the Plunger is
//     inside the screen and on top at its centre; at the result the panel is gone and every card button (Next
//     among them) is inside the screen and on top at its centre.
//   - F2, F4 and F5 upright: the Plunger is on screen with the rows folded and unfolded, the panel stands on the
//     docked HUD's tray (not over it) and clear of its strip, at most FUSE_PANEL_SHARE of the height, and the
//     opening view's measured band holds it.
// The layout does not depend on the solver: Rapier keeps the rounds short.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { FUSE_PANEL_SHARE } from '../src/view.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const DESKTOP = { viewport: { width: 1280, height: 800 } };
const UPRIGHT = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const SIDEWAYS = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };

const open = (id: string, ctx: typeof DESKTOP | typeof UPRIGHT) => {
  const { width: W, height: H } = ctx.viewport;
  return game.open(`/?level=${id}&engine=rapier&offscreen=${W}x${H}&door=0&progress=off`, 2 * MINUTES, ctx);
};

/** A box inside the screen and the topmost element at its centre (not scrolled away, clipped or covered). */
const shown = (page: Page, sel: string) => page.evaluate((s) => {
  const e = document.querySelector<HTMLElement>(s);
  if (!e || !e.getClientRects().length) return null;
  const r = e.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return { x: r.left, y: r.top, w: r.width, h: r.height, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: hit === e || (hit !== null && e.contains(hit)) };
}, sel);

/** Every visible button on the shown card, as `shown` sees it (a phone strip's Details is not drawn on a wide screen). */
const cardButtons = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kg-result.show button')].filter((b) => b.getClientRects().length > 0).map((b) => {
  const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  return { act: b.dataset.act, inside: r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight, onTop: document.elementFromPoint(cx, cy)?.closest('button') === b };
}));

describe('the Timeline panel never covers the result card or the Plunger (PT21)', () => {
  for (const [name, ctx] of [['desktop 1280 x 800', DESKTOP], ['upright 390 x 844', UPRIGHT], ['sideways 844 x 390', SIDEWAYS]] as const) it(`F4 ${name}: the Plunger on screen at load; at the result no panel, and Next on top`, async (t) => {
    if (!game.browser()) return t.skip();
    const o = await open('F4', ctx);
    if (!o) return t.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    expect(await page.locator('.kg-fuse.show .r').count()).toBe(12);
    const plunger = await shown(page, '.kg-fuse.show button.plunger');
    expect(plunger, 'the Plunger at load').toMatchObject({ inside: true, onTop: true });
    await page.evaluate(() => { window.__game.fast = true; });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelector('.kg-result.show') !== null, undefined, { timeout: 3 * MINUTES, polling: 100 });
    // The card's entrance animation runs 0.3 s: measure where it lands.
    await page.waitForTimeout(500);
    expect(await page.locator('.kg-fuse').isVisible(), 'the panel at the result').toBe(false);
    const buttons = await cardButtons(page);
    expect(buttons.map((b) => b.act)).toContain('next');
    for (const b of buttons) expect(b, `${b.act}`).toMatchObject({ inside: true, onTop: true });
    // Retry takes the card away and brings the panel back.
    await page.evaluate(() => window.__game.retry());
    await ready(page, 2 * MINUTES);
    expect(await shown(page, '.kg-fuse.show button.plunger'), 'the Plunger after Retry').toMatchObject({ inside: true, onTop: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 6 * MINUTES);

  for (const id of ['F2', 'F4', 'F5']) it(`${id} upright: the Plunger on screen folded and unfolded, the panel on the tray and in the opening band`, async (t) => {
    if (!game.browser()) return t.skip();
    const o = await open(id, UPRIGHT);
    if (!o) return t.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    const { width: W, height: H } = UPRIGHT.viewport;
    // Folded at load: the rows hidden behind Delays, the directions, the Sweep and the Plunger in sight.
    expect(await page.locator('.kg-fuse.show .rows').isVisible()).toBe(false);
    for (const sel of ['.kg-fuse .needle', '.kg-fuse button[data-dir="W"]', '.kg-fuse button[data-act="sp+"]', '.kg-fuse button.fold', '.kg-fuse button.plunger']) {
      expect(await shown(page, sel), `${id}: ${sel} at load`).toMatchObject({ inside: true, onTop: true });
    }
    const boxes = await page.evaluate(() => {
      const box = (s: string) => { const e = document.querySelector(s); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
      return { panel: box('.kg-fuse.show')!, st: box('.kg-hud .st'), tray: box('.kg-hud .tray'), hud: window.__game.openingHud };
    });
    expect(boxes.st && boxes.tray, 'a docked HUD').toBeTruthy();
    expect(boxes.panel.y, `${id}: the panel below the strip`).toBeGreaterThanOrEqual(boxes.st!.y + boxes.st!.h);
    expect(boxes.panel.y + boxes.panel.h, `${id}: the panel on the tray`).toBeLessThanOrEqual(boxes.tray!.y);
    expect(boxes.panel.h, `${id}: the panel's height`).toBeLessThanOrEqual(FUSE_PANEL_SHARE * H + 1);
    // The opening view kept clear of it: the measured band reaches the panel's top.
    expect(boxes.hud, `${id}: the opening view's band`).not.toBeNull();
    expect(boxes.hud!.bottom).toBeGreaterThanOrEqual((H - boxes.panel.y) / H - 1e-9);
    expect(boxes.panel.w).toBeLessThanOrEqual(W);
    // Unfolded: every row there to scroll to, the panel still capped, the Plunger still in sight.
    await page.locator('.kg-fuse button.fold').click();
    expect(await page.locator('.kg-fuse.show .rows').isVisible()).toBe(true);
    const panel = await shown(page, '.kg-fuse.show');
    expect(panel!.h, `${id}: unfolded height`).toBeLessThanOrEqual(FUSE_PANEL_SHARE * H + 1);
    expect(await shown(page, '.kg-fuse button.plunger'), `${id}: the Plunger unfolded`).toMatchObject({ inside: true, onTop: true });
    // The last row scrolls into the rows' own box, the Plunger stays put.
    const last = page.locator('.kg-fuse .r').last();
    await last.scrollIntoViewIfNeeded();
    expect(await last.isVisible()).toBe(true);
    expect(await shown(page, '.kg-fuse button.plunger'), `${id}: the Plunger after scrolling the rows`).toMatchObject({ inside: true, onTop: true });
    expect(errors).toEqual([]);
    await page.close();
  }, 4 * MINUTES);

  it('F4 sideways: the panel down the right side, inside the opening view\'s band', async (t) => {
    if (!game.browser()) return t.skip();
    const o = await open('F4', SIDEWAYS);
    if (!o) return t.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    const { width: W } = SIDEWAYS.viewport;
    const got = await page.evaluate(() => {
      const r = document.querySelector('.kg-fuse.show')!.getBoundingClientRect();
      return { x: r.left, w: r.width, hud: window.__game.openingHud };
    });
    expect(got.x).toBeGreaterThan(W / 2);
    expect(got.hud).not.toBeNull();
    expect(got.hud!.right).toBeGreaterThanOrEqual((W - got.x) / W - 1e-9);
    expect(errors).toEqual([]);
    await page.close();
  }, 4 * MINUTES);
});

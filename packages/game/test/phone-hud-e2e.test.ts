// The phone HUD and the result card in the browser (docs/game/phone-hud.md; agent playtest PT3 and PT4):
// a phone upright (390 x 844) and sideways (844 x 390), and the 640 x 400 desktop page.
//   PT3: the docked HUD covers at most 30% of the screen (upright: the strip and tray's heights; sideways:
//        the rail's width), and has the same boxes before and after the first shot; the touch hint goes.
//   PT4: no card until Layout.cardDelay of wall time after the settle (the tallying banner meanwhile), the
//        card docked aside, never centred; every card button inside the screen and on top, unscrolled;
//        a failed round's primary button is Retry; the last chamber level leads on to Undercut.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const UPRIGHT = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const SIDEWAYS = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const PHONES = [['upright', UPRIGHT], ['sideways', SIDEWAYS]] as const;
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par! as Shot[];
/** One of L1's base blocks (home centre half an h up): a plain block a pull may take (pull-e2e.test.ts). */
const PULL_BASE = (() => { const c = compileLevel(L1); return [...Array(c.meta.n).keys()].find((i) => Math.abs(c.meta.home[3 * i + 1]! - 0.25) < 1e-6)!; })();

type Box = { x: number; y: number; w: number; h: number };
/** The docked HUD's two boxes, the hint's, and the viewport. */
const hudBoxes = (page: Page) => page.evaluate(() => {
  const box = (sel: string) => { const e = document.querySelector(sel); if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  return { st: box('.kg-hud .st'), tray: box('.kg-hud .tray'), hint: box('.kg-hud .tch-hint'), help: box('#help'), vw: innerWidth, vh: innerHeight, dock: document.querySelector('.kg-hud')!.classList.contains('kg-dock') };
});

/** The share of the screen the docked HUD covers: upright, its boxes' heights over the screen's; sideways, the rail's width over the screen's. */
function hudShare(b: Awaited<ReturnType<typeof hudBoxes>>, sideways: boolean): number {
  const st = b.st!, tray = b.tray!;
  return sideways ? Math.max(st.x + st.w, tray.x + tray.w) / b.vw : (st.h + tray.h) / b.vh;
}

const fireAndSettle = async (page: Page, shot: Shot, n: number) => {
  await ready(page, 2 * MINUTES);
  expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
  await page.waitForFunction((k) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === k), n, { timeout: 2 * MINUTES, polling: 100 });
};

/** Every button on the shown card: inside the screen and the topmost element at its centre (so not scrolled away or covered). */
const cardButtons = (page: Page) => page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.kg-result.show button')].map((b) => {
  const r = b.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const inside = r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
  return { act: b.dataset.act, inside, onTop: document.elementFromPoint(cx, cy)?.closest('button') === b, primary: b.classList.contains('primary') };
}));

describe('the docked phone HUD (PT3)', () => {
  for (const [what, url, ammo] of [
    ['B1 (outcome: the Down bar, the opener, Bank)', '/?level=B1&engine=rapier&offscreen=1&door=0', 'w-bomb'],
    ['L2 (par: crowns, heritage, a lot sheet)', '/?level=L2&engine=rapier&offscreen=1&door=0', 'marble'],
    ['B1 with Bullet Time (freezes too)', '/?level=B1&keystone.freeze=3&engine=rapier&offscreen=1&door=0', 'w-bomb'],
    ['L1 racked with pulls (no power or height)', '/?level=L1&keystone.rack=pull,pull&engine=rapier&offscreen=1&door=0', 'pull'],
  ] as const) it(`${what}: at most 30% of the screen upright and sideways, the same before and after the first shot`, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const [name, phone] of PHONES) {
      const o = await game.open(url, 2 * MINUTES, phone);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 2 * MINUTES);
      await page.evaluate(() => { window.__game.fast = true; });
      const before = await hudBoxes(page);
      expect(before.dock, name).toBe(true);
      const share = hudShare(before, name === 'sideways');
      console.log(`${url} ${name}: the HUD covers ${(100 * share).toFixed(1)}% (strip/status ${JSON.stringify(before.st)}, tray ${JSON.stringify(before.tray)})`);
      expect(share, `${name}: the HUD's share of the screen`).toBeLessThanOrEqual(0.3);
      // Inside the screen, and the status and the tray apart.
      for (const b of [before.st!, before.tray!]) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.y).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(before.vw + 0.5);
        expect(b.y + b.h).toBeLessThanOrEqual(before.vh + 0.5);
      }
      expect(before.st!.y + before.st!.h).toBeLessThanOrEqual(before.tray!.y);
      // The touch hint before the first shot, just outside the tray; the page's own help line hidden while docked.
      expect(before.hint).not.toBeNull();
      expect(before.help).toBeNull();
      await fireAndSettle(page, ammo === 'pull' ? { ammo, body: PULL_BASE } : { ...miss, ammo }, 1);
      const after = await hudBoxes(page);
      expect(after.st, `${name}: the status's box after shot 1`).toEqual(before.st);
      expect(after.tray, `${name}: the tray's box after shot 1`).toEqual(before.tray);
      expect(after.hint).toBeNull();
      // Undo and Restart: tap targets (44 px), live now.
      for (const act of ['undo', 'restart']) {
        const b = page.locator(`.kg-hud button[data-act="${act}"]`);
        expect(await b.isEnabled()).toBe(true);
        const bb = (await b.boundingBox())!;
        expect(Math.min(bb.width, bb.height)).toBeGreaterThanOrEqual(44);
      }
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 10 * MINUTES);

  it('Layout classic (keystone.hud=panel): the one panel at the top left, and the touch hint line until the first shot', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0&keystone.hud=panel', 2 * MINUTES, UPRIGHT);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    const b = await hudBoxes(page);
    expect(b.dock).toBe(false);
    const panel = await page.evaluate(() => { const r = document.querySelector('.kg-hud')!.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    expect(panel).toEqual({ x: 12, y: 12 });
    expect(b.help).not.toBeNull();
    await page.evaluate(() => { window.__game.fast = true; });
    await fireAndSettle(page, miss, 1);
    expect((await hudBoxes(page)).help).toBeNull();
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

describe('the result card (PT4)', () => {
  for (const [name, phone] of [
    ['desktop', { viewport: { width: 1280, height: 800 } }],
    ['upright', UPRIGHT],
    ['sideways', SIDEWAYS],
  ] as const) it(`${name}: the tallying banner first, the card 1.2 s after the settle, docked aside, every button on screen`, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0', 2 * MINUTES, phone);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    await page.evaluate(() => { window.__game.fast = true; });
    // Sample what shows from the shot until the card: the tally never alongside the card, the card never before its time.
    await page.evaluate(() => {
      const w = window as unknown as { __seen: Array<{ t: number; tally: boolean; card: boolean; ended: number | null }> };
      w.__seen = [];
      const id = setInterval(() => {
        const card = document.querySelector('.kg-result.show') !== null;
        w.__seen.push({ t: performance.now(), tally: document.querySelector('.kg-tally.show') !== null, card, ended: window.__game.card.endedMs });
        if (card) clearInterval(id);
      }, 20);
    });
    expect(await page.evaluate((s) => window.__game.fire(s), par[0]!)).toBe(true);
    await page.waitForFunction(() => window.__game.card.shownMs !== null, undefined, { timeout: 2 * MINUTES, polling: 50 });
    const card = await page.evaluate(() => window.__game.card);
    const seen = await page.evaluate(() => (window as unknown as { __seen: Array<{ t: number; tally: boolean; card: boolean; ended: number | null }> }).__seen);
    expect(card.place).toBe('dock');
    expect(card.shownMs! - card.endedMs!, 'wall time from the settle to the card').toBeGreaterThanOrEqual(1200 - 5);
    expect(seen.some((s) => s.tally && !s.card), 'the tallying banner showed before the card').toBe(true);
    expect(seen.filter((s) => s.card && s.ended !== null).every((s) => s.t - s.ended! >= 1200 - 25)).toBe(true);
    expect(seen.some((s) => s.tally && s.card)).toBe(false);
    // Docked, not centred: aside on the right (desktop), along the bottom (upright), down the right (sideways).
    const r = await page.evaluate(() => { const b = document.querySelector('.kg-result')!.getBoundingClientRect(); return { l: b.left, t: b.top, r: b.right, b: b.bottom, vw: innerWidth, vh: innerHeight }; });
    if (name === 'upright') expect(r.vh - r.b).toBeLessThanOrEqual(8.5);
    else expect(r.vw - r.r).toBeLessThanOrEqual(12.5);
    if (name !== 'upright') expect(r.l).toBeGreaterThan(r.vw / 4);
    // Let the lines slam in, then every button: on screen and on top, without scrolling the card.
    await page.waitForTimeout(2500);
    const buttons = await cardButtons(page);
    expect(buttons.map((b) => b.act)).toEqual(['undo', 'retry', 'save', 'next']);
    for (const b of buttons) expect(b, `${name}: ${b.act}`).toMatchObject({ inside: true, onTop: true });
    expect(buttons.find((b) => b.primary)?.act).toBe('next');
    await page.screenshot({ path: `${process.env.TB_SHOTS ?? '/tmp'}/pt4-${name}.png` }).catch(() => {});
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('a failed round puts Retry first; the last chamber level leads on to Undercut, and its button opens U1', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L5&engine=rapier&offscreen=1&door=0&keystone.rack=marble&keystone.carddelay=0', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    await page.evaluate(() => { window.__game.fast = true; });
    await fireAndSettle(page, miss, 1);
    await page.waitForFunction(() => window.__game.card.shownMs !== null, undefined, { timeout: MINUTES, polling: 50 });
    expect(await page.evaluate(() => window.__game.result!.stamp)).toBe('INCOMPLETE');
    const buttons = await cardButtons(page);
    expect(buttons.filter((b) => b.primary).map((b) => b.act)).toEqual(['retry']);
    expect(await page.locator('.kg-result [data-act="series"]').innerText()).toMatch(/Next: Undercut/);
    await page.locator('.kg-result [data-act="series"]').click();
    await page.waitForFunction(() => window.__game.level === 'U1' && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('Layout classic (keystone.card=center, carddelay 0): the card at once, in the middle, tallying until the score', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0&keystone.card=center&keystone.carddelay=0', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 2 * MINUTES);
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), par[0]!)).toBe(true);
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const card = await page.evaluate(() => window.__game.card);
    expect(card.place).toBe('center');
    expect(card.shownMs! - card.endedMs!).toBeLessThan(1200);
    const r = await page.evaluate(() => { const b = document.querySelector('.kg-result')!.getBoundingClientRect(); return Math.abs((b.left + b.right) / 2 - innerWidth / 2); });
    expect(r).toBeLessThan(2);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

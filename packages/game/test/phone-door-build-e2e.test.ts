// PT18 in the browser (docs/game/agent-playtest-1.md; docs/game/phone-hud.md, "The Build panel"), Rapier in headless
// Chromium on a phone upright (390 x 844) and sideways (844 x 390):
//   - the door held sideways shows at least two whole level cards on its first screen, unscrolled;
//   - C9's Build panel (trial T-W1 Domino Workshop) inside the docked HUD: while building, every box of it inside the
//     screen and clear of the status strip (upright) or the rail (sideways) and of the Menu button, the aim tray put
//     away (nothing fires until Play), Play and Cancel on top, and a tap in the free band still places a piece; after
//     Play, its Build button inside the screen and clear of the strip, the tray, the rail and Menu, and the tray back.
import { describe, expect, it } from 'vitest';
import type { CDPSession, Page } from 'playwright';
import { gamePage } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const UPRIGHT = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const SIDEWAYS = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true };
const PHONES = [['upright', UPRIGHT], ['sideways', SIDEWAYS]] as const;

type Box = { x: number; y: number; w: number; h: number };
const inside = (b: Box, vw: number, vh: number) => b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= vw + 0.5 && b.y + b.h <= vh + 0.5;
const apart = (a: Box, b: Box) => a.x + a.w <= b.x + 0.5 || b.x + b.w <= a.x + 0.5 || a.y + a.h <= b.y + 0.5 || b.y + b.h <= a.y + 0.5;

/** The docked HUD's boxes (null when not shown), the Build panel's and its buttons', Menu's, and the viewport. */
const boxes = (page: Page) => page.evaluate(() => {
  const box = (e: Element | null) => {
    if (!e || !e.getClientRects().length || getComputedStyle(e).visibility === 'hidden') return null;
    const r = e.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const panel = document.querySelector('.kg-build');
  return {
    st: box(document.querySelector('.kg-hud .st')), tray: box(document.querySelector('.kg-hud .tray')), menu: box(document.querySelector('.kg-menu')),
    panel: box(panel), buttons: [...(panel?.querySelectorAll('button') ?? [])].map((b) => ({ a: (b as HTMLElement).dataset.a ?? '', box: box(b) })),
    vw: innerWidth, vh: innerHeight, dock: document.querySelector('.kg-hud')!.classList.contains('kg-dock'),
  };
});

/** Whether the element at a button's centre is that button (it is on top, not covered or scrolled away). */
const onTop = (page: Page, sel: string) => page.evaluate((s) => {
  const b = document.querySelector(s);
  if (!b) return false;
  const r = b.getBoundingClientRect();
  return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button') === b;
}, sel);

/** One finger through the browser's touch input (CDP, as build-e2e.test.ts). */
const finger = (cdp: CDPSession) => {
  const send = (type: 'touchStart' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
  return { tap: async (x: number, y: number) => { await send('touchStart', x, y); await send('touchEnd', 0, 0); } };
};

describe('the door held sideways (PT18)', () => {
  it('shows two whole cards on its first screen', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?engine=rapier&offscreen=1&progress=off', 2 * MINUTES, SIDEWAYS);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__door?.open === true, undefined, { timeout: MINUTES, polling: 100 });
    const cards = await page.evaluate(() => [...document.querySelectorAll('.kg-door .card')].map((c) => {
      const r = c.getBoundingClientRect();
      return { id: (c as HTMLElement).dataset.id ?? c.getAttribute('aria-label'), whole: r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth };
    }));
    const whole = cards.filter((c) => c.whole).map((c) => c.id);
    console.log(`sideways door: whole cards on the first screen: ${whole.join(', ')}`);
    expect(whole.length).toBeGreaterThanOrEqual(2);
    // Play is on that screen too, and the door is not scrolled.
    expect(await page.evaluate(() => document.querySelector('.kg-door')!.scrollTop)).toBe(0);
    expect(await onTop(page, '.kg-door .play')).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 3 * MINUTES);
});

describe('the Build panel in the docked phone HUD (PT18, C9)', () => {
  for (const [name, phone] of PHONES) it(`${name}: inside the screen and clear of the strip, tray, rail and Menu, building and after Play`, async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=T-W1&engine=rapier&offscreen=1&progress=off&door=0', 2 * MINUTES, phone);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });

    // Building: the panel open, the tray put away.
    const b = await boxes(page);
    expect(b.dock, 'the HUD docks').toBe(true);
    expect(b.panel, 'the Build panel shows').not.toBeNull();
    expect(b.tray, 'the aim tray is put away while building').toBeNull();
    console.log(`T-W1 ${name}, building: panel ${JSON.stringify(b.panel)}, strip/rail ${JSON.stringify(b.st)}, menu ${JSON.stringify(b.menu)}`);
    expect(inside(b.panel!, b.vw, b.vh), 'the panel inside the screen').toBe(true);
    expect(apart(b.panel!, b.st!), 'the panel clear of the status strip or rail').toBe(true);
    expect(apart(b.panel!, b.menu!), 'the panel clear of Menu').toBe(true);
    // Every button the panel shows unscrolled is inside the screen; Play and Cancel are on top (the rest may need the panel scrolled).
    for (const x of b.buttons) if (x.box && x.box.y + x.box.h <= b.panel!.y + b.panel!.h) expect(inside(x.box, b.vw, b.vh), `button ${x.a}`).toBe(true);
    expect(await onTop(page, '.kg-build button[data-a=play]')).toBe(true);
    expect(await onTop(page, '.kg-build button[data-a=cancel]')).toBe(true);
    // Upright the panel takes no more than the bottom half; sideways no more than half the width.
    if (name === 'upright') expect(b.panel!.h / b.vh).toBeLessThanOrEqual(0.5);
    else expect(b.panel!.w / b.vw).toBeLessThanOrEqual(0.5);

    // The scene is still there to build on: a tap in the free band (between the strip and the panel upright, right of
    // the rail and left of the panel sideways) places a piece.
    const n0 = (await page.evaluate(() => window.__game.edit.def()))!.parts.length;
    const [x, y] = name === 'upright'
      ? [b.vw / 2, (b.st!.y + b.st!.h + b.panel!.y) / 2]
      : [(b.st!.x + b.st!.w + b.panel!.x) / 2, b.vh / 2];
    await finger(await page.context().newCDPSession(page)).tap(x, y);
    await page.waitForFunction((n) => window.__game.edit.def()!.parts.length === n + 1, n0, { timeout: 10_000, polling: 50 });

    // Play: the level as built loads; the tray comes back and the panel holds only its Build button.
    await page.locator('.kg-build button[data-a=play]').tap();
    await page.waitForFunction(() => !window.__game.edit.on && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const a = await boxes(page);
    console.log(`T-W1 ${name}, after Play: panel ${JSON.stringify(a.panel)}, strip/rail ${JSON.stringify(a.st)}, tray ${JSON.stringify(a.tray)}`);
    expect(a.tray, 'the tray is back').not.toBeNull();
    expect(a.panel, 'the Build button stays offered before the first shot').not.toBeNull();
    expect(inside(a.panel!, a.vw, a.vh)).toBe(true);
    for (const [what, other] of [['strip or rail', a.st], ['tray', a.tray], ['Menu', a.menu]] as const) expect(apart(a.panel!, other!), `the Build button clear of the ${what}`).toBe(true);
    expect(a.buttons.map((x) => x.a)).toEqual(['enter']);
    expect(await onTop(page, '.kg-build button[data-a=enter]')).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 4 * MINUTES);
});

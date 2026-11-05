// Touch controls (roadmap U4) on the game page, in headless Chromium with an
// emulated phone: real touch input through the browser (CDP
// Input.dispatchTouchEvent, so pointer events arrive as a phone's do, several
// fingers at once). A finger aims as hover would and fires where it lifts; two
// fingers orbit and pinch-zoom; a second finger calls a shot off; the camera
// moves only on these gestures (the camera rule, #169). The desktop page keeps
// its mouse controls. Rapier and offscreen, so it is quick on a CPU.
import { describe, expect, it } from 'vitest';
import type { CDPSession, Page } from 'playwright';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
const URL_L1 = '/?level=L1&offscreen=1&engine=rapier';

type Finger = [x: number, y: number, id: number];
const fingers = (cdp: CDPSession) => {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd' | 'touchCancel', pts: Finger[]) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map(([x, y, id]) => ({ x, y, id, radiusX: 4, radiusY: 4, force: 1 })) });
  return { start: (p: Finger[]) => send('touchStart', p), move: (p: Finger[]) => send('touchMove', p), end: (p: Finger[]) => send('touchEnd', p) };
};
const view = (page: Page) => page.evaluate(() => ({ ...window.__game.view }));
const input = (page: Page) => page.evaluate(() => ({ ...window.__game.input }));
const settle = (page: Page) => page.evaluate(() => new Promise((r) => setTimeout(r, 600)));
/** The camera itself, without the jolt and follow flags (which are 0 and false here). */
const cam = (v: { target: number[]; distance: number; yaw: number; pitch: number }) => ({ target: v.target, distance: v.distance, yaw: v.yaw, pitch: v.pitch });

describe('touch controls', () => {
  it('on a phone: a finger aims and fires where it lifts, two fingers orbit and pinch, the camera moves only on input', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL_L1, 60_000, PHONE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const cdp = await page.context().newCDPSession(page);
    const t = fingers(cdp);
    // A phone's primary pointer is coarse: the page shows its touch face from the start.
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    expect((await input(page)).touch).toBe(true);
    expect(await page.evaluate(() => document.body.classList.contains('kg-touch'))).toBe(true);
    await expect.poll(() => page.locator('#help').innerText()).toMatch(/drag: aim · lift: fire/);
    expect(await page.locator('#help').innerText()).not.toMatch(/hover/);
    const v0 = cam(await view(page));

    // Two fingers move right together 60 px: the view turns as a 60 px mouse drag does (orbitDrag: 0.005 rad/px), and fires nothing.
    await t.start([[150, 500, 1]]);
    await t.start([[150, 500, 1], [250, 500, 2]]);
    await page.waitForFunction(() => window.__game.input.gesture === 'camera' && window.__game.input.fingers === 2, undefined, { timeout: 10_000, polling: 50 });
    expect((await input(page)).aimed).toBeNull();
    for (let k = 1; k <= 6; k++) await t.move([[150 + 10 * k, 500, 1], [250 + 10 * k, 500, 2]]);
    await settle(page);
    const v1 = cam(await view(page));
    expect(v1.yaw).toBeCloseTo(v0.yaw - 0.3, 9);
    expect(v1.pitch).toBeCloseTo(v0.pitch, 9);
    expect(v1.distance).toBeCloseTo(v0.distance, 9);
    expect(v1.target).toEqual(v0.target);
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    await t.end([[310, 500, 2]]);
    expect((await input(page)).gesture).toBe('spent');
    await t.end([]);
    await page.waitForFunction(() => window.__game.input.gesture === 'idle', undefined, { timeout: 10_000, polling: 50 });

    // A pinch from 100 px to 200 px apart about a fixed midpoint halves the distance, and turns nothing.
    await t.start([[145, 500, 3]]);
    await t.start([[145, 500, 3], [245, 500, 4]]);
    for (let k = 1; k <= 5; k++) await t.move([[145 - 10 * k, 500, 3], [245 + 10 * k, 500, 4]]);
    await t.end([]);
    await settle(page);
    const v2 = cam(await view(page));
    expect(v2.distance).toBeCloseTo(v1.distance / 2, 9);
    expect(v2.yaw).toBeCloseTo(v1.yaw, 9);
    expect(v2.pitch).toBeCloseTo(v1.pitch, 9);

    // A second finger calls off the shot being aimed: nothing fires as the two lift.
    await t.start([[205, 422, 5]]);
    await page.waitForFunction(() => window.__game.input.aimed !== null, undefined, { timeout: 10_000, polling: 50 });
    await t.start([[205, 422, 5], [300, 600, 6]]);
    await page.waitForFunction(() => window.__game.input.gesture === 'camera' && window.__game.input.aimed === null, undefined, { timeout: 10_000, polling: 50 });
    await t.end([[205, 422, 5]]);
    await t.end([]);
    await settle(page);
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    expect((await input(page)).gesture).toBe('idle');

    // With no input the camera stays where the player left it.
    const still = cam(await view(page));
    await settle(page);
    await settle(page);
    expect(cam(await view(page))).toEqual(still);

    // The HUD's tap targets: the power buttons (keys Q and E) and the rack's chips (keys 1, 2).
    await expect.poll(() => page.locator('.kg-hud button.pw[data-arg="-10"]').isVisible()).toBe(true);
    await page.locator('.kg-hud button.pw[data-arg="-10"]').tap();
    await page.locator('.kg-hud button.pw[data-arg="-10"]').tap();
    expect((await input(page)).power).toBe(80);
    await page.locator('.kg-hud button.pw[data-arg="10"]').tap();
    expect((await input(page)).power).toBe(90);
    await page.locator('.kg-hud button.chip[data-arg="2"]').tap();
    await expect.poll(() => page.locator('.kg-hud button.chip.on').innerText()).toMatch(/Marble/);
    // One finger down on the tower: aimed, with no camera motion. (Last, since this shot may clear L1 and its card would cover the canvas.)
    const vAim = cam(await view(page));
    const ndc = (x: number, y: number) => [(x / 390) * 2 - 1, 1 - (y / 844) * 2] as const;
    await t.start([[205, 422, 1]]);
    await page.waitForFunction(() => window.__game.input.gesture === 'aim' && window.__game.input.aimed !== null, undefined, { timeout: 10_000, polling: 50 });
    const a1 = (await input(page)).aimed!;
    // Dragging moves the aim with the finger.
    await t.move([[200, 400, 1]]);
    await page.waitForFunction((a) => JSON.stringify(window.__game.input.aimed) !== JSON.stringify(a), a1, { timeout: 10_000, polling: 50 });
    const a2 = (await input(page)).aimed!;
    expect(a2).not.toEqual(a1);
    // The finger aims exactly as hovering the same spot would (GameHandle.aim, the mouse's path).
    expect((await page.evaluate(([x, y]) => window.__game.aim(x, y), ndc(200, 400)))?.shot).toEqual(a2);
    expect(cam(await view(page))).toEqual(vAim);
    // Lifting fires that shot.
    await t.end([]);
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 10_000, polling: 50 });
    expect(await page.evaluate(() => window.__game.line())).toEqual([a2]);
    await page.waitForFunction(() => window.__game.input.gesture === 'idle' && window.__game.input.aimed === null, undefined, { timeout: 10_000, polling: 50 });
    await page.evaluate(() => { window.__game.fast = true; });
    await ready(page, 120_000);
    // Through the whole shot, nothing moved the camera (Camera: Still, the default), and nothing does after it.
    expect(cam(await view(page))).toEqual(vAim);
    await settle(page);
    expect(cam(await view(page))).toEqual(vAim);

    // Key hints are hidden on the touch face.
    expect(await page.locator('.kg-hud kbd').first().isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('on a desktop: the mouse keeps hover aim, click fire, drag orbit and wheel zoom, with no touch face', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL_L1);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect((await input(page)).touch).toBe(false);
    expect(await page.evaluate(() => document.body.classList.contains('kg-touch'))).toBe(false);
    expect(await page.locator('#help').innerText()).toMatch(/hover: aim · click: fire/);
    expect(await page.locator('.kg-hud button.pw').first().isVisible()).toBe(false);
    expect(await page.locator('.kg-hud kbd').first().isVisible()).toBe(true);
    const v0 = cam(await view(page));
    // Hover aims, and the camera holds.
    await page.mouse.move(336, 200);
    await page.waitForFunction(() => window.__game.input.aimed !== null, undefined, { timeout: 10_000, polling: 50 });
    expect((await input(page)).gesture).toBe('idle');
    // A drag of 60 px orbits, as before, and fires nothing.
    await page.mouse.down();
    await page.mouse.move(396, 200, { steps: 6 });
    await page.mouse.up();
    await settle(page);
    const v1 = cam(await view(page));
    expect(v1.yaw).toBeCloseTo(v0.yaw - 0.3, 9);
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    // The wheel zooms by exp(deltaY / 1000).
    await page.mouse.wheel(0, -200);
    await settle(page);
    expect((await view(page)).distance).toBeCloseTo(v1.distance * Math.exp(-0.2), 9);
    // A click fires.
    await page.mouse.click(336, 200);
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 10_000, polling: 50 });
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);

  it('a phone without WebGPU gets the card that says what to use', async (ctx) => {
    const b = game.browser();
    if (!b) return ctx.skip();
    const page = await b.newPage(PHONE);
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }); delete (Navigator.prototype as { gpu?: unknown }).gpu; });
    await page.goto(game.url(URL_L1));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    const text = await page.locator('#error').innerText();
    expect(text).toContain("This browser can't run Keystone");
    expect(text).toMatch(/Chrome on Android/);
    expect(await page.locator('#error').isVisible()).toBe(true);
    await page.close();
  });
});

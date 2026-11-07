// The build phase on the game page (C9, docs/game/placement.md), Rapier in
// headless Chromium: T-W1 opens building (time stopped, nothing fires, the
// Build panel up); a mouse click places a domino; the brush lays a run along
// each quarter circle; the panel's Play loads exactly the level as built (the
// hash compileLevel gives it, its bodies) and play goes on from there; Retry
// keeps the build; B builds on it again before the first shot, and Esc leaves
// without the edits (and does not open the menu). keystone.build=0 plays the
// level as authored. That the built level topples crown to crown is
// keystone-lab's brush-physics test.
import { describe, expect, it } from 'vitest';
import { compileLevel, findLevel, type LevelDef, WORKSHOP_ANGLES, WORKSHOP_RADIUS } from '@tb/keystone';
import type { CDPSession, Page } from 'playwright';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
type V3 = [number, number, number];
const H = compileLevel(findLevel('T-W1')!).frame.unit;
const DOWN: V3 = [0, -1, 0];

/** A brush stroke along the workshop's circle from crown k to crown k + 1, as world rays straight down. */
async function strokeArc(page: Page, k: number) {
  const a0 = (WORKSHOP_ANGLES[k]! * Math.PI) / 180, a1 = (WORKSHOP_ANGLES[k + 1]! * Math.PI) / 180;
  const at = (t: number): V3 => { const a = a0 + (a1 - a0) * t; return [WORKSHOP_RADIUS * H * Math.cos(a), 20, WORKSHOP_RADIUS * H * Math.sin(a)]; };
  await page.evaluate(([o, d]) => window.__game.edit.ray('down', o, d), [at(0), DOWN] as const);
  for (let i = 1; i <= 50; i++) await page.evaluate(([o, d]) => window.__game.edit.ray('move', o, d), [at(i / 50), DOWN] as const);
  expect(await page.evaluate(() => window.__game.edit.status())).toMatch(/dominoes/);
  await page.evaluate(([o, d]) => window.__game.edit.ray('up', o, d), [at(1), DOWN] as const);
}

/** One finger through the browser's touch input (CDP, as touch-e2e.test.ts): pointer events arrive as a tablet's do. */
const finger = (cdp: CDPSession) => {
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', x: number, y: number) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1, radiusX: 4, radiusY: 4, force: 1 }] });
  return { start: (x: number, y: number) => send('touchStart', x, y), move: (x: number, y: number) => send('touchMove', x, y), end: () => send('touchEnd', 0, 0) };
};

describe('the build phase on the game page', () => {
  it('T-W1: opens building, places by click, lays two runs, Play loads exactly the level as built, Retry keeps it, B and Esc', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    // A desktop window (the panel sits top right; under 640 px it docks at the bottom), at the offscreen view's 1.6 aspect.
    const o = await game.open('/?level=T-W1&engine=rapier&offscreen=1&progress=off&door=0', undefined, { viewport: { width: 1024, height: 640 } });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const authored = findLevel('T-W1')!;
    // Time is stopped and nothing fires while building; the Build panel is up with Play.
    expect(await page.evaluate(() => ({ ready: window.__game.ready, building: document.body.classList.contains('kg-building') }))).toEqual({ ready: false, building: true });
    expect(await page.evaluate(() => window.__game.fire({ ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 50 } as never))).toBe(false);
    expect(await page.locator('.kg-build').isVisible()).toBe(true);
    expect(await page.locator('.kg-build button[data-a=play]').isVisible()).toBe(true);

    // The mouse: a click at the middle of the view places a domino (the place tool holds the domino, the only piece offered).
    await page.mouse.click(512, 320);
    let def = await page.evaluate(() => window.__game.edit.def()) as LevelDef;
    expect(def.parts.length).toBe(authored.parts.length + 1);
    expect(def.parts.at(-1)).toMatchObject({ kind: 'piece', placed: true });
    expect(await page.evaluate(() => window.__game.edit.key('z'))).toBe(true); // undo it
    expect((await page.evaluate(() => window.__game.edit.def()))!.parts.length).toBe(authored.parts.length);

    // The brush: a run along each quarter circle, crown to crown.
    expect(await page.evaluate(() => window.__game.edit.key('b'))).toBe(true);
    await strokeArc(page, 0);
    await strokeArc(page, 1);
    def = await page.evaluate(() => window.__game.edit.def()) as LevelDef;
    expect(def.parts.slice(-2).map((p) => p.kind)).toEqual(['run', 'run']);
    const want = compileLevel(def);
    expect(want.meta.n).toBeGreaterThan(12);
    expect(await page.evaluate(() => window.__game.edit.status())).toMatch(new RegExp(`${30 - (want.meta.n - 3)} of 30 left`));

    // Play (the panel's button): the level as built, exactly, and play goes on from it.
    await page.locator('.kg-build button[data-a=play]').click();
    await page.waitForFunction(() => !window.__game.edit.on && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => ({ played: window.__game.edit.played, bodies: window.__game.bodies, level: window.__game.level, building: document.body.classList.contains('kg-building') })))
      .toEqual({ played: want.hash, bodies: want.meta.n, level: 'T-W1', building: false });

    // Retry keeps the build (the level as played), and stays out of the build phase.
    await page.evaluate(() => window.__game.retry());
    await ready(page);
    expect(await page.evaluate(() => ({ on: window.__game.edit.on, bodies: window.__game.bodies }))).toEqual({ on: false, bodies: want.meta.n });

    // B before the first shot builds on it again; Esc leaves without the edits and leaves the menu shut.
    await page.keyboard.press('b');
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: MINUTES, polling: 100 });
    expect(JSON.stringify(await page.evaluate(() => window.__game.edit.def()))).toBe(JSON.stringify(def));
    await page.evaluate(() => window.__game.edit.key('x')); // erase, so a stray click would take a domino back
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__game.edit.on && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    expect(await page.evaluate(() => ({ bodies: window.__game.bodies, door: window.__door?.open ?? false }))).toEqual({ bodies: want.meta.n, door: false });
    expect(errors).toEqual([]);
    await page.close();
  }, 6 * MINUTES);

  it('keystone.build=0 plays T-W1 as authored: no build phase, no panel', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=T-W1&engine=rapier&offscreen=1&progress=off&door=0&keystone.build=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => ({ on: window.__game.edit.on, enter: window.__game.edit.enter(), bodies: window.__game.bodies }))).toEqual({ on: false, enter: false, bodies: 3 });
    expect(await page.locator('.kg-build').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 3 * MINUTES);

  it('on a touch screen: a tap places, a finger dragged with the brush lays a run, no key hints', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=T-W1&engine=rapier&offscreen=1&progress=off&door=0', undefined, { viewport: { width: 1024, height: 640 }, isMobile: true, hasTouch: true });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.input.touch)).toBe(true);
    expect(await page.locator('.kg-build .key').first().isVisible()).toBe(false);
    const n0 = findLevel('T-W1')!.parts.length, t = finger(await page.context().newCDPSession(page));
    const parts = async () => (await page.evaluate(() => window.__game.edit.def()))!.parts;
    // A tap in the middle of the view: the ghost where the finger rests, placed where it lifts.
    await t.start(512, 320);
    await t.end();
    await page.waitForFunction((n) => window.__game.edit.def()!.parts.length === n + 1, n0, { timeout: 10_000, polling: 50 });
    expect((await parts()).at(-1)).toMatchObject({ kind: 'piece', placed: true });
    // The brush: a finger dragged 240 px across the ground lays a run where it lifts.
    expect(await page.evaluate(() => window.__game.edit.key('b'))).toBe(true);
    await t.start(400, 380);
    for (let k = 1; k <= 24; k++) await t.move(400 + 10 * k, 380);
    expect(await page.evaluate(() => window.__game.edit.status())).toMatch(/dominoes/);
    await t.end();
    await page.waitForFunction((n) => window.__game.edit.def()!.parts.length === n + 2, n0, { timeout: 10_000, polling: 50 });
    const run = (await parts()).at(-1)!;
    expect(run.kind).toBe('run');
    expect(compileLevel(await page.evaluate(() => window.__game.edit.def()) as LevelDef).meta.n).toBeGreaterThanOrEqual(3 + 1 + 3);
    expect(errors).toEqual([]);
    await page.close();
  }, 3 * MINUTES);
});

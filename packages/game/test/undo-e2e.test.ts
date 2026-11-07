// Undo last shot (key U, Ctrl/Cmd+Z, the result card's Undo) and restart (key R)
// on the game page (roadmap U6). Undo restores the checkpoint taken as the last
// shot went in, or with no checkpoint (keystone.undo=0, or past the undo memory)
// rebuilds the level and replays the attempt's shots but the last, headless
// (docs/game/undo.md). Either way, after N shots the state is exactly a fresh
// replay of shots 1..N-1 on this device, which handle.replay and a headless
// Rapier session both check here, and the same shot fired again gives the state
// it gave before; restart is the level's start state again. A rapid-fire (cut)
// shot's checkpoint is mid-flight: the shot it cut plays on to the settle the
// replay reaches. Both ways run every case here. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, playShots, Driver, type Shot, snapshotHash } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { PORTRAIT_HUD_SHARE } from '../src/view.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const BASE = '/?level=L1&engine=rapier&look=candy&offscreen=1';
const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true };
/** A marble well wide of the tower: it changes nothing but the step count and the rack. */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const par = L1.solutions!.par! as Shot[];

/** L1's state after `line`, played to its settle and left aiming (not banked), as the page builds its Rapier driver. */
async function headless(line: Shot[]) {
  const d = new Driver(new RapierEngine(), compileLevel(L1), driverOptions('rapier'));
  await d.reset();
  const r = await playShots(d, line, 0, { bank: false });
  return { step: r.steps, phase: r.session.phase, strokes: r.session.strokes, heritageBroken: r.session.heritageBroken.reduce((a, x) => a + x, 0), hash: snapshotHash(r.snapshot) };
}

const state = (page: Page) => page.evaluate(() => window.__game.state());
const settled = (page: Page, strokes: number) => page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), strokes, { timeout: 2 * MINUTES, polling: 100 });

describe.each([['checkpoint', ''], ['replay', '&keystone.undo=0']] as const)('undo and restart on the game page (%s)', (mode, extra) => {
  it('U after N shots is a fresh replay of shots 1..N-1; R is the level start', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE + extra);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const start = await state(page);
    expect(start.strokes).toBe(0);
    // Nothing to undo yet.
    expect(await page.evaluate(() => window.__game.undo())).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    const line: Shot[] = [miss, miss, par[0]!];
    for (const [i, s] of line.entries()) {
      await ready(page);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await settled(page, i + 1);
    }
    const three = await state(page);
    expect(three.strokes).toBe(3);

    // U (the key, as a player presses it): back to shots 1..2, settled and aiming.
    await page.keyboard.press('u');
    await page.waitForFunction(() => window.__game.strokes === 2 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const two = await state(page);
    expect(two.hash).not.toBe(three.hash);
    // What the undo cost here (software: not a performance result), and which way it went.
    const undone = await page.evaluate(() => window.__game.undone);
    expect(undone?.mode).toBe(mode);
    console.log(`undo to 2 shots on L1 (Rapier, ${mode}): ${undone!.ms.toFixed(0)} ms, at step ${two.step}`);
    // Checkpoints held: one per shot kept (none with keystone.undo=0).
    expect(await page.evaluate(() => window.__game.undoMemory().marks)).toBe(mode === 'checkpoint' ? 2 : 0);
    const want = await headless(line.slice(0, 2));
    expect(two).toEqual(want);
    // The page's own fresh replay of the same shots (its engine, built as the live one) agrees on the poses and the step.
    const replayed = await page.evaluate((l) => window.__game.replay(l), line.slice(0, 2));
    expect({ step: replayed.step, hash: replayed.hash }).toEqual({ step: two.step, hash: two.hash });
    expect(await page.evaluate(() => window.__game.line())).toEqual(line.slice(0, 2));
    expect(await page.evaluate(() => window.__game.counts.undo)).toBe(1);

    // Play on from there: the attempt is the undone line plus the new shot, and replays exactly; the
    // same third shot gives exactly the state it gave before the undo.
    expect(await page.evaluate((x) => window.__game.fire(x), par[0]!)).toBe(true);
    await settled(page, 3);
    expect(await state(page)).toEqual(await headless([miss, miss, par[0]!]));
    expect(await state(page)).toEqual(three);

    // Ctrl+Z undoes too; twice more brings the attempt back to one shot.
    await page.keyboard.press('Control+z');
    await page.waitForFunction(() => window.__game.strokes === 2 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    await page.keyboard.press('u');
    await page.waitForFunction(() => window.__game.strokes === 1 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await state(page)).toEqual(await headless([miss]));

    // R: the level's start, exactly.
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await state(page)).toEqual(start);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

  it('a rapid-fire shot that cut the one before undoes to that one played out; undo works from the result card', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE + extra);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(true);
    // The miss, then the par shot while the miss still runs: the par shot cuts it.
    const at = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, at + 10, { timeout: MINUTES, polling: 50 });
    expect(await page.evaluate(() => window.__game.phase)).toBe('running');
    expect(await page.evaluate((s) => window.__game.fire(s), par[0]!)).toBe(true);
    await page.waitForFunction(() => window.__game.strokes === 2, undefined, { timeout: MINUTES, polling: 50 });
    expect(await page.evaluate(() => window.__game.counts.cut)).toBe(1);
    // Undo while the cutting shot is still running: back to the miss alone. From the checkpoint that is the
    // moment the par shot went in, the miss still in flight, and it plays on; the replay plays it out out of
    // sight. Both settle at the state a session of the miss alone settles at.
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    expect(await page.evaluate(() => window.__game.undone!.mode)).toBe(mode);
    if (mode === 'checkpoint') expect(await page.evaluate(() => [window.__game.phase, window.__game.strokes])).toEqual(['running', 1]);
    await page.waitForFunction(() => window.__game.strokes === 1 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await state(page)).toEqual(await headless([miss]));
    expect(await page.evaluate(() => window.__game.line())).toEqual([miss]);

    // Finish the level, then undo its last shot from the result card.
    await page.evaluate(() => { window.__game.fast = true; });
    for (const s of par) {
      await page.waitForFunction(() => window.__game.ready || window.__game.result !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
      if (await page.evaluate(() => window.__game.result !== null)) break;
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
    }
    await page.waitForFunction(() => window.__game.result !== null && document.querySelector('.kg-result [data-act="undo"]') !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const done = await page.evaluate(() => window.__game.line());
    await page.locator('.kg-result [data-act="undo"]').click();
    await page.waitForFunction((n) => window.__game.result === null && window.__game.ready && window.__game.strokes === n, done.length - 1, { timeout: 2 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => document.querySelector('.kg-result')!.classList.contains('show'))).toBe(false);
    expect(await state(page)).toEqual(await headless(done.slice(0, -1)));
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

});

describe('undo and restart on a phone', () => {
  it('on a phone: the HUD\'s Undo and Restart icons come alive after the first shot, tapped as a player would', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE, MINUTES, PHONE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const start = await state(page);
    const undoBtn = page.locator('.kg-hud button[data-act="undo"]');
    const restartBtn = page.locator('.kg-hud button[data-act="restart"]');
    // There all along (the docked HUD keeps one size, docs/game/phone-hud.md), disabled before a shot.
    expect(await undoBtn.isDisabled()).toBe(true);
    expect(await restartBtn.isDisabled()).toBe(true);
    await page.evaluate(() => { window.__game.fast = true; });
    for (const [i, s] of [miss, miss].entries()) {
      await ready(page);
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
      await settled(page, i + 1);
    }
    await expect.poll(() => undoBtn.isEnabled()).toBe(true);
    // Tap targets as tall as the power buttons (44 px), and the HUD's status strip within the top band the portrait camera keeps clear.
    for (const b of [undoBtn, restartBtn]) expect((await b.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    const hudBottom = await page.evaluate(() => document.querySelector('.kg-hud .st')!.getBoundingClientRect().bottom);
    expect(hudBottom).toBeLessThanOrEqual(844 * PORTRAIT_HUD_SHARE);
    await undoBtn.tap();
    await page.waitForFunction(() => window.__game.strokes === 1 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await state(page)).toEqual(await headless([miss]));
    await restartBtn.tap();
    await page.waitForFunction(() => window.__game.strokes === 0 && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    expect(await state(page)).toEqual(start);
    expect(await undoBtn.isDisabled()).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

  it('on a desktop the touch buttons stay hidden', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(BASE);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((x) => window.__game.fire(x), miss)).toBe(true);
    await settled(page, 1);
    expect(await page.locator('.kg-hud button[data-act="undo"]').count()).toBe(1);
    expect(await page.locator('.kg-hud button[data-act="undo"]').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});

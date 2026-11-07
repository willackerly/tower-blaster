// Aftershock's quake designer on the game page (M7, docs/game/aftershock.md; quake-panel.ts): on A1 the Quake chip
// is selected and its panel stands in the tray in place of power and height; the dial keys and the panel's buttons
// move the dial; a click on the towers fires nothing; Enter starts the quake the dial shows; the camera does not move
// while the ground shakes; and the page ends where runSession ends the same line headless and where its own replay
// ends it (a quake replays bit for bit). Rapier, for speed: the shipped levels' physics on the GPU solver is
// keystone-lab quake-aces-gpu.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { A1, compileLevel, runSession, type Shot, snapshotHash } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();

describe('the quake designer on the game page', () => {
  it('Rapier: keys and buttons set the dial, Enter starts it, the camera stays put, and the page replays the quake', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=A1&engine=rapier&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.dial())).toEqual({ peak: 30, hz: 10, sec: 30, axis: 0 });
    await page.waitForSelector('.kg-hud .quake-panel', { timeout: 30_000 });
    expect(await page.evaluate(() => /Power|Height/.test(document.querySelector('.kg-hud')!.textContent ?? ''))).toBe(false);
    // Keys: E twice (strength up), D (frequency up a stop), X (longer), V (the axis on a step).
    for (const k of ['e', 'e', 'd', 'x', 'v']) await page.keyboard.press(k);
    expect(await page.evaluate(() => window.__game.dial())).toEqual({ peak: 40, hz: 12, sec: 40, axis: 15 });
    // The panel's minus button for frequency, as a tap would press it, and the value the panel shows.
    await page.click('.kg-hud button.qd[data-arg="hz:-1"]');
    expect(await page.evaluate(() => window.__game.dial())).toEqual({ peak: 40, hz: 10, sec: 40, axis: 15 });
    await page.waitForFunction(() => document.querySelector('.kg-hud .qv[data-q="hz"]')?.textContent === '1.0 Hz', undefined, { timeout: 10_000, polling: 50 });
    // A click on the towers aims nothing with the Quake chip selected.
    expect(await page.evaluate(() => window.__game.aim(0, 0))).toBeNull();
    const view = await page.evaluate(() => ({ ...window.__game.view }));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 30_000, polling: 50 });
    const line: Shot[] = [{ ammo: 'quake', peak: 40, hz: 10, sec: 40, axis: 15 }];
    expect(await page.evaluate(() => window.__game.line())).toEqual(line);
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 4 * MINUTES, polling: 250 });
    const after = await page.evaluate(() => ({ ...window.__game.view }));
    expect({ target: after.target, distance: after.distance, yaw: after.yaw, pitch: after.pitch }).toEqual({ target: view.target, distance: view.distance, yaw: view.yaw, pitch: view.pitch });
    const live = await page.evaluate(() => window.__game.state());
    const r = await runSession(new RapierEngine(), compileLevel(A1), line, driverOptions('rapier'));
    expect(live).toEqual({ step: r.steps, phase: r.session.phase, strokes: 1, heritageBroken: r.session.heritageBroken.reduce((a, x) => a + x, 0), hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate((s) => window.__game.replay(s), line)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

  it('on a phone, upright and sideways: every dial button and Start on screen, the tray not wider than the screen or its rail', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const phone = { deviceScaleFactor: 1, isMobile: true, hasTouch: true };
    for (const [name, viewport] of [['upright', { width: 390, height: 844 }], ['sideways', { width: 844, height: 390 }]] as const) {
      const o = await game.open('/?level=A3&engine=rapier&offscreen=1&door=0', 2 * MINUTES, { ...phone, viewport });
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page, 2 * MINUTES);
      await page.waitForSelector('.kg-hud .quake-panel');
      const m = await page.evaluate(() => {
        const r = (e: Element) => e.getBoundingClientRect(), tray = r(document.querySelector('.kg-hud .tray')!), st = r(document.querySelector('.kg-hud .st')!);
        const buttons = [...document.querySelectorAll('.kg-hud .quake-panel button')].map((b) => { const x = r(b); return { arg: (b as HTMLElement).dataset.arg ?? 'start', inTray: x.left >= tray.left - 0.5 && x.right <= tray.right + 0.5 && x.top >= 0 && x.bottom <= innerHeight + 0.5, h: x.height }; });
        return { buttons, share: (st.height + tray.height) / innerHeight, trayRight: tray.right, vw: innerWidth };
      });
      console.log(`A3 ${name}: the docked HUD covers ${(100 * m.share).toFixed(1)}%`);
      expect(m.buttons).toHaveLength(9);
      for (const b of m.buttons) expect(b.inTray, `${name}: ${b.arg}`).toBe(true);
      expect(m.trayRight).toBeLessThanOrEqual(m.vw);
      // Upright, the designer is the tray while the quake is set (the brief's dial and meter): about a third of the
      // screen, against 30% for a launcher's tray (phone-hud-e2e); it goes once the quake has been fired.
      if (name === 'upright') expect(m.share).toBeLessThanOrEqual(0.36);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 10 * MINUTES);
});

// Skip (agent playtest PT6): during a settle, K or the HUD's Skip button runs the rest of the shot at
// SKIP_SCALE times real time. Pacing only: the shot settles at the same step, in the same state, as
// the headless session of the same line. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot, snapshotHash } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { SKIP_SCALE } from '../src/pacing.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const par = L1.solutions!.par![0] as Shot;

describe('Skip on the game page', () => {
  it('a running shot skips to its settle: the button shows, K runs it at SKIP_SCALE, and it ends where the headless line does', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&look=candy&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.skip())).toBe(false); // aiming: nothing to skip
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(true);
    await page.waitForFunction((at) => window.__game.stepIndex >= at, start + 5, { timeout: 60_000, polling: 20 });
    await page.waitForSelector('.kg-hud button[data-act="skip"]', { timeout: 10_000 });
    await page.keyboard.press('k');
    await page.waitForFunction((k) => window.__game.phase !== 'running' || window.__game.pace.timeScale === k, SKIP_SCALE, { timeout: 10_000, polling: 10 });
    expect(await page.evaluate(() => window.__game.skip())).toBe(false); // already skipping (or settled)
    await page.waitForFunction(() => window.__game.result !== null || window.__game.phase !== 'running', undefined, { timeout: 120_000, polling: 50 });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 50 });
    expect(await page.$('.kg-hud button[data-act="skip"]')).toBeNull();
    const r = await runSession(new RapierEngine(), compileLevel(L1), [par], driverOptions('rapier'));
    expect(await page.evaluate(() => window.__game.state())).toEqual({ step: r.steps, phase: r.session.phase, strokes: 1, heritageBroken: r.session.heritageBroken.reduce((a, x) => a + x, 0), hash: snapshotHash(r.snapshot) });
    expect(errors).toEqual([]);
  }, 180_000);
  it('hold (the agent playtest\'s capture hook, PT12): no step runs while frames draw, and the HUD reads the held step', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=T-X1&engine=rapier&look=candy&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const shot: Shot = { ammo: 'marble', az: 108, y: 16, yaw: 0, pitch: 26, power: 100 };
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    await page.waitForFunction((at) => window.__game.stepIndex >= at, start + 10, { timeout: 60_000, polling: 10 });
    const held = await page.evaluate(() => { window.__game.hold = true; return { step: window.__game.stepIndex, frames: window.__game.frames }; });
    await page.waitForTimeout(400);
    const after = await page.evaluate(() => ({ step: window.__game.stepIndex, frames: window.__game.frames, phase: window.__game.phase, d: window.__game.collapse }));
    // A step already submitted when hold went up may still land; none after it.
    expect(after.step - held.step).toBeLessThanOrEqual(1);
    expect(after.frames).toBeGreaterThan(held.frames);
    expect(after.phase).toBe('running');
    expect(await page.locator('.kg-hud b.down').first().innerText()).toBe(`${Math.floor(100 * after.d)}%`);
    await page.evaluate(() => { window.__game.hold = false; });
    await page.waitForFunction((at) => window.__game.stepIndex > at + 5, after.step, { timeout: 30_000, polling: 20 });
    expect(errors).toEqual([]);
  }, 180_000);
});

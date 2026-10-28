// The viewer's Bounce toggle (restitution on the GPU engine) in headless
// Chromium, SwiftShader in CI. In a file of its own: it builds the GPU engine
// three times and reloads the page, which took 31-40 s on a loaded 4-core VM
// and over 60 s on a CI runner (2026-10-27), and e2e.test.ts is near the
// 300 s per file that CI's shards allow.
import type { SpawnEvent } from '@tb/engine-api';
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { requireWebGPU } from '@tb/testkit';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

// Larger than the other e2e cases' 640x400. At 640 px the presets move to the
// bottom right (index.html's narrow layout), and with the HUD showing
// 'avbd-gpu:restitution=true' the left column reached under them on CI's
// fonts, covering the Bounce box (2026-10-27).
const WIDE = { width: 800, height: 600 };
/** The Scene panel open: it starts open on a window over 640 px wide (controls.ts), where a click on its summary closes it. */
const openPanel = (page: Page) => page.locator('#controls').evaluate((d) => { (d as HTMLDetailsElement).open = true; });

describe('viewer: Bounce', () => {
  it('the panel\'s Bounce turns the GPU engine\'s restitution on, scaled for the world, gives what a click fires its e, and the URL keeps both', { timeout: 240_000 }, async (ctx) => {
    if (!browser) return ctx.skip();
    // Quarter-metre cubes: the engine's threshold (1 m/s) must reach it scaled by sqrt(4) (froudeParams).
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&engine=avbd-gpu&scale=0.25', WIDE);
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    const variant = () => page.evaluate(() => window.__viewer.variant);
    expect(await variant()).not.toHaveProperty('restitution');
    await openPanel(page);
    const scene = page.locator('#scene-form');
    const box = scene.locator('input[name=bounce]');
    expect(await box.isChecked()).toBe(false);
    expect(await box.isDisabled()).toBe(false);
    expect(await scene.locator('.bounce').isHidden()).toBe(true);
    await box.check();
    expect(await scene.locator('.bounce').isVisible()).toBe(true);
    expect(await scene.locator('input[name=bounceE]').inputValue()).toBe('0.5');
    // Any e in [0, 1] passes the browser's own form check, or submit would do nothing.
    const valid = () => scene.locator('input[name=bounceE]').evaluate((el) => (el as HTMLInputElement).validity.valid);
    await scene.locator('input[name=bounceE]').fill('0.33');
    expect(await valid()).toBe(true);
    await scene.locator('input[name=bounceE]').fill('0.7');
    expect(await valid()).toBe(true);
    expect(await scene.locator('.out').innerText()).toBe('54 bodies, 4 g in cube units, 2x as fast, 2x physics cost, bouncing at e 0.7');
    await scene.locator('button').click();
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }))).toEqual({ s: 'running', e: undefined });
    expect(await variant()).toMatchObject({ restitution: true, restitutionThreshold: 2, restitutionRounds: 8 });
    const url = new URL(page.url());
    expect(url.searchParams.get('engine')).toBe('avbd-gpu:restitution=true');
    expect(url.searchParams.get('bounce.e')).toBe('0.7');
    // What a click fires bounces at e too.
    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 55, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => (window.__viewer.inputs[0] as SpawnEvent).body.restitution)).toBe(0.7);
    // The pass runs with the ball in the tower, and the GPU reports no error (one would stop the viewer).
    const fired = await page.evaluate(() => window.__viewer.stepIndex);
    await page.waitForFunction((n) => window.__viewer.status !== 'running' || window.__viewer.stepIndex > n + 30, fired, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }))).toEqual({ s: 'running', e: undefined });
    expect(await page.locator('#hud').innerText()).toContain('avbd-gpu:restitution=true');
    expect(errors).toEqual([]);
    await page.close();

    // The URL alone brings it back; off again removes the engine option and keeps the e.
    const again = await open(url.pathname + url.search, WIDE);
    expect(await again.page.evaluate(() => ({ s: window.__viewer.status, v: window.__viewer.variant.restitution }))).toEqual({ s: 'running', v: true });
    await openPanel(again.page);
    const s2 = again.page.locator('#scene-form');
    expect(await s2.locator('input[name=bounce]').isChecked()).toBe(true);
    expect(await s2.locator('input[name=bounceE]').inputValue()).toBe('0.7');
    await s2.locator('input[name=bounce]').uncheck();
    expect(await s2.locator('.out').innerText()).toBe('54 bodies, 4 g in cube units, 2x as fast, 2x physics cost');
    await s2.locator('button').click();
    await again.page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.stepIndex > 5), undefined, { timeout: 60_000 });
    expect(await again.page.evaluate(() => window.__viewer.status)).toBe('running');
    expect(await again.page.evaluate(() => window.__viewer.variant)).not.toHaveProperty('restitution');
    const off = new URL(again.page.url());
    expect(off.searchParams.get('engine')).toBe('avbd-gpu');
    expect(off.searchParams.get('bounce.e')).toBe('0.7');
    expect(again.errors).toEqual([]);
    await again.page.close();
  });

});

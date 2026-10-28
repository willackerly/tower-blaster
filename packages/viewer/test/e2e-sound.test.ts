// The viewer's collision sound in headless Chromium: the worklet loads, a
// click (the browser's user gesture) starts it, a shot's impacts reach
// the audio thread and it plays them; the panel switches it off and on live.
import { describe, expect, it } from 'vitest';
import { requireWebGPU } from '@tb/testkit';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

describe('viewer: sound', () => {
  it('snd=1 waits for a click, then plays the shot\'s impacts; the panel turns it off and on', { timeout: 240_000 }, async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1&snd=1&snd.mat=pine', { width: 800, height: 600 });
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    const sound = () => page.evaluate(() => window.__viewer.sound());
    // The worklet loads; the context then waits for a gesture (headless Chromium needs none).
    await page.waitForFunction(() => ['waiting', 'on', 'error'].includes(window.__viewer.sound().status), undefined, { timeout: 30_000 });
    expect((await sound()).error).toBe('');
    // A click anywhere on the page is the gesture; the ball is fired through the centre by the handle, as the
    // panel (open at this width) may cover the canvas's centre with CI's fonts.
    await page.mouse.click(5, 595);
    await page.evaluate(() => window.__viewer.fire(0, 0));
    // Until the shot's impacts have played (cumulative counts: a poll between rings still sees them), or 120 s; then
    // the state is what the expectations below read, so a failure says where it stopped.
    const played = () => page.evaluate(() => { const s = window.__viewer.sound(); return s.status === 'error' || (s.status === 'on' && (s.stats?.impacts ?? 0) > 0 && (s.stats?.loudest ?? 0) > 0); });
    for (const t0 = Date.now(); !(await played()) && Date.now() - t0 < 120_000;) await page.waitForTimeout(250);
    const on = await sound();
    const where = JSON.stringify({ ...on, step: await page.evaluate(() => window.__viewer.stepIndex), bodies: await page.evaluate(() => window.__viewer.bodies) });
    expect(on, where).toMatchObject({ status: 'on', error: '' });
    expect(on.stats?.impacts ?? 0, where).toBeGreaterThan(0);
    expect(on.stats?.loudest ?? 0, where).toBeGreaterThan(0);
    expect(on.posted).toBeGreaterThan(10);
    expect(on.stats!.frames).toBeGreaterThan(10);
    expect(on.stats!.overflow).toBe(0);
    expect(on.stats!.loudest).toBeLessThanOrEqual(0.9 + 1e-6); // the limiter's ceiling
    // The panel: off is live and leaves the URL; on again needs no new click.
    await page.locator('#controls').evaluate((d) => { (d as HTMLDetailsElement).open = true; });
    const toggle = page.locator('#sound-form input[name=on]');
    expect(await toggle.isChecked()).toBe(true);
    expect(await page.locator('#sound-form select[name=material]').inputValue()).toBe('pine');
    await toggle.uncheck();
    expect((await sound()).status).toBe('off');
    expect(new URL(page.url()).searchParams.get('snd')).toBeNull();
    await toggle.check();
    await page.waitForFunction(() => window.__viewer.sound().status === 'on', undefined, { timeout: 10_000 });
    expect(new URL(page.url()).searchParams.get('snd')).toBe('1');
    expect(errors).toEqual([]);
    await page.close();
  });

  it('is off by default: no audio context, nothing posted', { timeout: 120_000 }, async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.stepIndex > 60, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__viewer.sound())).toEqual({ status: 'off', error: '', posted: 0, stats: null });
    expect(errors).toEqual([]);
    await page.close();
  });
});

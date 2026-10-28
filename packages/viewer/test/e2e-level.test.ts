// A Keystone level as a viewer scene (level=L1) in headless Chromium: it
// loads the game's bodies after the presettle, draws them with the game's
// role tints, and a fired ball knocks them about. SwiftShader in CI.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1 } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

describe('viewer with a level', () => {
  const n = compileLevel(L1).scene.bodies.length;

  it.for(['avbd-gpu', 'rapier'] as const)('loads L1 settled and tinted, and a fired ball moves it, on %s', async (engine, ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(`/?level=L1&presettle=30&offscreen=1&look=hazy&engine=${engine}`);
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 5, undefined, { timeout: 60_000 });
    const h = await page.evaluate(() => ({ bodies: window.__viewer.bodies, tinted: window.__viewer.tinted, step: window.__viewer.stepIndex }));
    expect(h.bodies).toBe(n);
    expect(h.tinted).toBe(n);
    // The presettle ran before the scene showed.
    expect(h.step).toBeGreaterThanOrEqual(30);
    expect(await page.locator('#hud').innerText()).toContain(`L1 ${L1.name}`);

    // The crowns' gold shows: pixels clearly warmer than the hazy look's pale plaster and sky.
    const stats = await page.evaluate(() => window.__viewer.capture(true));
    const px = stats!.pixels!;
    let warm = 0;
    for (let y = 0; y < stats!.height; y++) for (let x = 0; x < stats!.width; x++) {
      const i = y * px.bytesPerRow + 4 * x;
      if (px.data[i]! - px.data[i + 2]! > 60) warm++;
    }
    expect(warm).toBeGreaterThan(20);

    await page.evaluate(() => window.__viewer.fire(0, 0.1));
    await page.waitForFunction((m) => window.__viewer.bodies === m + 1, n, { timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the panel lists the levels and switches a scenario to one and back', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=2&param.H=3&offscreen=1&engine=rapier');
    if (await page.evaluate(() => window.__viewer.status) === 'error' && !requireWebGPU()) return ctx.skip();
    await page.evaluate(() => { (document.getElementById('controls') as HTMLDetailsElement).open = true; });
    const scenario = page.locator('#scene-form select[name=scenario]');
    await scenario.selectOption('level:L1');
    expect(await page.locator('#scene-form input[name=presettle]').inputValue()).toBe('300');
    await page.locator('#scene-form input[name=presettle]').fill('10');
    await page.locator('#scene-form button[type=submit]').click();
    await page.waitForFunction((m) => window.__viewer.resets === 2 && window.__viewer.bodies === m, n, { timeout: 60_000 });
    expect(new URL(page.url()).search).toBe('?level=L1&engine=rapier&presettle=10&offscreen=1');
    await scenario.selectOption('S1');
    await page.locator('#scene-form button[type=submit]').click();
    await page.waitForFunction(() => window.__viewer.resets === 3 && window.__viewer.tinted === 0, undefined, { timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get('scenario')).toBe('S1');
    expect(errors).toEqual([]);
    await page.close();
  });
});

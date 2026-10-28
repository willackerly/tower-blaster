// The viewer's engine limits (health.ts, PhysicsEngine.health) in headless
// Chromium, SwiftShader in CI: a GPU pair buffer too small for the scene shows
// on the HUD within a moment, in red with what happened, and the HUD's button
// rebuilds the engine with the room it suggests, even on a press held across
// the HUD's redraws. In a file of its own: it builds the GPU engine twice.
import { describe, expect, it } from 'vitest';
import { requireWebGPU } from '@tb/testkit';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

describe('viewer: engine limits', () => {
  it('names a pair buffer too small for the scene, and its button rebuilds the engine with room, which the URL keeps', { timeout: 240_000 }, async (ctx) => {
    if (!browser) return ctx.skip();
    // 96 touching cubes; 1 pair per body, over the 96 bodies and the viewer's 256 spare slots, holds 352 pairs.
    const { page, errors } = await open('/?scenario=S1&param.F=4&param.H=6&offscreen=1&engine=avbd-gpu:pairsPerBody=1', { width: 800, height: 600 });
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.health?.limits[0]?.steps ?? 0) > 0, undefined, { timeout: 60_000 });
    const before = (await page.evaluate(() => window.__viewer.health))!.limits[0]!;
    expect(before).toMatchObject({ id: 'pairs', effect: 'physics', room: 352, fix: { option: 'pairsPerBody' } });
    expect(before.peak).toBeGreaterThan(352);
    const fix = `avbd-gpu:pairsPerBody=${before.fix!.value}`;
    // The HUD redraws as soon as the limit is first hit.
    const button = page.locator('#hud button[data-fix]');
    await button.waitFor({ timeout: 10_000 });
    expect(await button.getAttribute('data-fix')).toBe(fix);
    expect(await button.innerText()).toBe(`Rebuild with pairsPerBody=${before.fix!.value}`);
    expect(await page.locator('#hud div.bad').first().innerText()).toMatch(/^contacts dropped on \d+ of \d+ steps: a step needed \d+ broadphase pairs and the buffer holds 352/);

    // A slow press, held across HUD redraws (every 10 frames): the button is one element kept across them, so the click lands.
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    const frames = await page.evaluate(() => window.__viewer.frames);
    await page.waitForFunction((f) => window.__viewer.frames >= f + 25, frames, { timeout: 30_000 });
    await page.mouse.up();
    await page.waitForFunction(() => window.__viewer.status !== 'running' || (window.__viewer.resets === 2 && window.__viewer.health !== null), undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }))).toEqual({ s: 'running', e: undefined });
    expect(new URL(page.url()).searchParams.get('engine')).toBe(fix);
    const after = (await page.evaluate(() => window.__viewer.health))!.limits[0]!;
    expect(after).toMatchObject({ id: 'pairs', steps: 0, room: (before.fix!.value as number) * 352 });
    expect(after.fix).toBeUndefined();
    expect(await page.locator('#hud').innerText()).toContain(`Rebuilt with ${fix}`);
    await page.waitForFunction(() => !document.querySelector('#hud button[data-fix]'), undefined, { timeout: 10_000 });
    // Paused, no snapshot follows a step, so the limits are read on the frame path and come to cover every step before the pause.
    await page.keyboard.press('p');
    await page.waitForFunction(() => { const v = window.__viewer; return v.health?.steps === v.stepIndex; }, undefined, { timeout: 10_000 });
    expect(errors).toEqual([]);
    await page.close();
  });
});

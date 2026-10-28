// A bare viewer URL in headless Chromium opens the default scene
// (default-scene.ts) and writes it into the address bar; ?defaults=factory
// opens the built-in setup.
import { describe, expect, it } from 'vitest';
import { requireWebGPU } from '@tb/testkit';
import { DEFAULT_CONFIG, DEFAULT_SCENE, parseSceneFile, parseViewerConfig } from '../src/index.ts';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

describe('the viewer\'s start', () => {
  it.for([['/?offscreen=1', () => parseSceneFile(JSON.stringify(DEFAULT_SCENE)).config], ['/?offscreen=1&defaults=factory', () => DEFAULT_CONFIG]] as const)('%s opens its setup and shows it in the URL', async ([url, want], ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(url);
    const st = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(st).toEqual({ s: 'running', e: undefined });
    const search = await page.evaluate(() => location.search);
    expect(parseViewerConfig(search)).toEqual({ ...want(), offscreen: true });
    await page.waitForFunction(() => window.__viewer.stepIndex > 2, undefined, { timeout: 120_000 });
    expect(await page.locator('#hud').innerText()).toContain(want().engine);
    expect(errors).toEqual([]);
    await page.close();
  });
});

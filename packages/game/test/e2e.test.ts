// The game page in headless Chromium (SwiftShader in CI): it loads a level,
// aims, plays L1's par line, shows the result card, and scores exactly what
// the headless driver scores for the same shots.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { RapierEngine } from '@tb/adapter-rapier';
import { requireWebGPU, WEBGPU_ARGS } from '@tb/testkit';
import { compileLevel, L1, runSession, type Shot } from '@tb/keystone';

let server: ViteDevServer | null = null;
let browser: Browser | null = null;
let origin = '';

beforeAll(async () => {
  server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!.replace('127.0.0.1', 'localhost');
  try {
    browser = await chromium.launch({ args: platform() === 'linux' ? WEBGPU_ARGS : ['--enable-unsafe-webgpu'] });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 120_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

/** Open the page; null means no WebGPU adapter here (skip unless required). */
async function open(search: string): Promise<{ page: Page; errors: string[] } | null> {
  const page = await browser!.newPage({ viewport: { width: 640, height: 400 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(search, origin).toString());
  await page.waitForFunction(() => window.__game?.status !== 'loading', undefined, { timeout: 60_000 });
  const st = await page.evaluate(() => ({ s: window.__game.status, e: window.__game.error }));
  if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '') && !requireWebGPU()) { await page.close(); return null; }
  expect(st).toEqual({ s: 'running', e: undefined });
  return { page, errors };
}

const ready = (page: Page) => page.waitForFunction(() => window.__game.ready || window.__game.result !== null, undefined, { timeout: 60_000 });

describe('game page', () => {
  it('plays the L1 par line to a result card that matches the headless score', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await open('/?level=L1&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(108);

    // Hovering the tower gives a reachable aim and preview beads.
    const aimed = await page.evaluate(() => window.__game.aim(0, 0));
    expect(aimed?.reachable).toBe(true);
    const stats = await page.evaluate(() => window.__game.capture());
    expect(stats!.bodyFraction).toBeGreaterThan(0.02);
    expect(stats!.distinctColors).toBeGreaterThan(50);

    await page.evaluate(() => { window.__game.fast = true; });
    const shots = L1.solutions!.par as Shot[];
    for (const shot of shots) {
      await ready(page);
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    }
    await page.waitForFunction(() => document.querySelector('#result.show') !== null, undefined, { timeout: 120_000 });
    const result = await page.evaluate(() => ({ score: window.__game.result, counts: window.__game.counts, phase: window.__game.phase }));
    expect(result.phase).toBe('cleared');
    expect(result.counts.fired).toBe(2);
    expect(result.counts.contact).toBeGreaterThanOrEqual(1);
    expect(result.counts.crownDown).toBe(9);
    const card = await page.locator('#result').innerText();
    expect(card).toMatch(/PAR/);
    expect(card).toMatch(/Total/);

    // Same shots, headless, same engine: the same score to the point.
    const r = await runSession(new RapierEngine(), compileLevel(L1), shots);
    expect(result.score).toEqual(r.session.score);

    // Retry regrows the level and resets the rack.
    await page.keyboard.press('r');
    await ready(page);
    expect(await page.evaluate(() => ({ phase: window.__game.phase, strokes: window.__game.strokes, result: window.__game.result }))).toEqual({ phase: 'aiming', strokes: 0, result: null });
    expect(await page.locator('#result').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows a readable error for an unknown level', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(new URL('/?level=L99&offscreen=1', origin).toString());
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown level L99/);
    await page.close();
  });
});

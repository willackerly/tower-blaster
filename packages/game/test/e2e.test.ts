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
import { compileLevel, L1, L4, PRESETTLE_STEPS, runSession, type Shot } from '@tb/keystone';

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
async function open(search: string, timeout = 60_000): Promise<{ page: Page; errors: string[] } | null> {
  const page = await browser!.newPage({ viewport: { width: 640, height: 400 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(search, origin).toString());
  await page.waitForFunction(() => window.__game?.status !== 'loading', undefined, { timeout, polling: 250 });
  const st = await page.evaluate(() => ({ s: window.__game.status, e: window.__game.error }));
  if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '') && !requireWebGPU()) { await page.close(); return null; }
  expect(st).toEqual({ s: 'running', e: undefined });
  return { page, errors };
}

// Timer polling: requestAnimationFrame polling starves while SwiftShader is busy with the GPU solver.
const ready = (page: Page, timeout = 60_000) => page.waitForFunction(() => window.__game.ready || window.__game.result !== null, undefined, { timeout, polling: 250 });

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
    // And the page's own replay agrees, pose for pose.
    const live = await page.evaluate(() => window.__game.state());
    expect(live).toMatchObject({ step: r.steps, phase: 'cleared' });
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);

    // Retry regrows the level and resets the rack.
    await page.keyboard.press('r');
    await ready(page);
    expect(await page.evaluate(() => ({ phase: window.__game.phase, strokes: window.__game.strokes, result: window.__game.result }))).toEqual({ phase: 'aiming', strokes: 0, result: null });
    expect(await page.locator('#result').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  // L4 (38 bodies, one anvil drop) rather than L1: SwiftShader runs the GPU
  // solver at a few hundred ms per step, so this test takes minutes as it is.
  it('plays on the GPU solver, and a replay on the same device is bit-identical', async (ctx) => {
    if (!browser) return ctx.skip();
    // Loading runs the pre-settle: 300 steps at AVBD_ITERATIONS (40), over a minute on CI's SwiftShader.
    const o = await open('/?level=L4&offscreen=1&engine=gpu', 300_000);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 300_000);
    expect(await page.evaluate(() => ({ engine: window.__game.engine, bodies: window.__game.bodies }))).toEqual({ engine: 'gpu', bodies: 38 });
    // The arc preview follows the GPU's one substep and still finds the structure.
    await page.evaluate(() => window.__game.select('marble'));
    expect((await page.evaluate(() => window.__game.aim(0, 0)))?.reachable).toBe(true);
    await page.evaluate(() => { window.__game.fast = true; });
    // The par line was pinned on Rapier, so it need not clear here: compare states, not scores.
    const shots = L4.solutions!.par as Shot[];
    for (const shot of shots) {
      await ready(page);
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    }
    await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), shots.length, { timeout: 600_000, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    expect(live.strokes).toBe(shots.length);
    expect(live.step).toBeGreaterThan(PRESETTLE_STEPS);
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 1_200_000);

  it('names the engines when ?engine= is unknown', async (ctx) => {
    if (!browser) return ctx.skip();
    const page = await browser.newPage();
    await page.goto(new URL('/?level=L1&engine=physx&offscreen=1', origin).toString());
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown engine physx: use rapier or gpu/);
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

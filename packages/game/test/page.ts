// The game page in headless Chromium (SwiftShader in CI) for the browser
// tests: a Vite server and a browser per test file, and pages opened on a
// level once it has loaded.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { afterAll, beforeAll, expect } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { requireWebGPU, WEBGPU_ARGS } from '@tb/testkit';
import type { Shot } from '@tb/keystone';

export interface GamePage {
  /** Null when no browser could start here (the tests skip unless WebGPU is required). */
  browser(): Browser | null;
  url(search: string): string;
  /** Open the page and wait for its level; null means no WebGPU adapter here (skip unless required). */
  open(search: string, timeout?: number): Promise<{ page: Page; errors: string[] } | null>;
}

/** Registers this file's server and browser (beforeAll / afterAll). */
export function gamePage(): GamePage {
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
  const url = (search: string) => new URL(search, origin).toString();
  return {
    browser: () => browser,
    url,
    async open(search, timeout = 60_000) {
      const page = await browser!.newPage({ viewport: { width: 640, height: 400 } });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(url(search));
      await page.waitForFunction(() => window.__game?.status !== 'loading', undefined, { timeout, polling: 250 });
      const st = await page.evaluate(() => ({ s: window.__game.status, e: window.__game.error }));
      if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '') && !requireWebGPU()) { await page.close(); return null; }
      expect(st).toEqual({ s: 'running', e: undefined });
      return { page, errors };
    },
  };
}

// Timer polling: requestAnimationFrame polling starves while SwiftShader is busy with the GPU solver.
export const ready = (page: Page, timeout = 60_000) => page.waitForFunction(() => window.__game.ready || window.__game.result !== null, undefined, { timeout, polling: 250 });

/** Fire shots at fast-forward, each once the page is ready, and wait until the last has settled or the level ended. */
export async function playShots(page: Page, shots: Shot[], timeout: number): Promise<void> {
  await page.evaluate(() => { window.__game.fast = true; });
  for (const shot of shots) {
    await ready(page, timeout);
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
  }
  await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), shots.length, { timeout, polling: 250 });
}

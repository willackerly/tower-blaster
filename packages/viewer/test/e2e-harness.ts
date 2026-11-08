// The viewer e2e files' setup: a Vite dev server and headless Chromium (with
// the WebGPU flags on Linux), started once per file, and a page opener. A
// file calls useViewer() at its top; browser is null when no browser could
// be launched and REQUIRE_WEBGPU is unset, and its tests then skip.
// TB_CHANNEL=chrome runs them in the installed Chrome (the real GPU); TB_HEADED=1
// shows the window, for frame-rate measurements at the display's own rate.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { afterAll, beforeAll } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { requireWebGPU, WEBGPU_ARGS } from '@tb/testkit';

let server: ViteDevServer | null = null;
export let browser: Browser | null = null;
let origin = '';

/** Starts the server and the browser before the calling file's tests, and closes both after them. */
export function useViewer(): void {
  beforeAll(async () => {
    server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
    await server.listen();
    origin = server.resolvedUrls!.local[0]!.replace('127.0.0.1', 'localhost');
    try {
      // TB_CHANNEL=chrome: the installed Chrome, so the real GPU (Metal on a Mac), as the game's tests.
      const channel = process.env.TB_CHANNEL;
      // TB_HEADED=1: a visible window, so rAF runs at the display's rate (a 120 Hz ProMotion panel); headless runs at 60.
      browser = await chromium.launch({ args: platform() === 'linux' ? WEBGPU_ARGS : ['--enable-unsafe-webgpu'], headless: process.env.TB_HEADED !== '1', ...(channel ? { channel } : {}) });
    } catch (e) {
      if (requireWebGPU()) throw e;
    }
  }, 120_000);
  afterAll(async () => { await browser?.close(); await server?.close(); });
}

/** A page of the viewer at `search` (640x400 unless given), once it is past loading (within `timeout` ms), and the page errors it collects. */
export async function open(search: string, viewport = { width: 640, height: 400 }, timeout = 60_000) {
  const page = await browser!.newPage({ viewport });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(search, origin).toString());
  await page.waitForFunction(() => window.__viewer !== undefined && window.__viewer.status !== 'loading', undefined, { timeout });
  return { page, errors };
}

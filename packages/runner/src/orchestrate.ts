// Node side: serve the runner page with cross-origin isolation, drive it in
// Chromium through Playwright, and return the page's result record.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { CLOSE_TIMEOUT_MS, closeWithin } from '@tb/testkit';
import { type RunConfig, toQuery } from './config.ts';

export interface BrowserRunOptions {
  headed?: boolean;
  /** Playwright channel, e.g. "chrome" to use the installed Google Chrome. */
  channel?: string;
  timeoutMs?: number;
  /** How long close() waits for each of the browser and the server (default CLOSE_TIMEOUT_MS). */
  closeTimeoutMs?: number;
  extraArgs?: string[];
}

export function chromiumArgs(): string[] {
  // Developer features turn off Chrome's 100 µs timestamp-query quantization.
  const args = ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'];
  if (platform() === 'linux') args.push('--enable-features=Vulkan');
  return args;
}

export interface RunnerSession {
  /** Run one config in a fresh page (fresh JS heap and WASM instance). */
  run(config: RunConfig): Promise<Record<string, unknown>>;
  /**
   * Close the browser, then the server, waiting at most closeTimeoutMs for
   * each. Resolves to the ones that had not closed ([] normally). Either
   * keeps Node running, so a CLI that gets a non-empty list should write its
   * results first and then exitNow().
   */
  close(): Promise<string[]>;
}

/** One Vite server and one browser, reused across runs. */
export async function openRunner(opts: BrowserRunOptions = {}): Promise<RunnerSession> {
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' } });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) {
    await server.close();
    throw new Error('vite did not report a URL');
  }
  // Serve from localhost, not 127.0.0.1: localhost is a secure context.
  const origin = base.replace('127.0.0.1', 'localhost');
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: [...chromiumArgs(), ...(opts.extraArgs ?? [])],
    ...(opts.channel ? { channel: opts.channel } : {}),
  }).catch(async (e: unknown) => { await server.close(); throw e; });
  return {
    async run(config) {
      const page = await browser.newPage();
      try {
        const errors: string[] = [];
        page.on('pageerror', (e) => errors.push(e.message));
        await page.goto(new URL(toQuery({ ...config, autorun: true }), origin).toString());
        await page.waitForFunction(() => ['done', 'error'].includes(window.__tb?.status), undefined, { timeout: opts.timeoutMs ?? 600_000, polling: 250 });
        const h = await page.evaluate(() => window.__tb);
        if (h.status === 'error') throw new Error(`runner page failed: ${h.error}`);
        if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
        return h.result as Record<string, unknown>;
      } finally {
        await page.close();
      }
    },
    close: () => closeWithin([['browser', () => browser.close()], ['vite server', () => server.close()]], opts.closeTimeoutMs ?? CLOSE_TIMEOUT_MS),
  };
}

export async function runInBrowser(config: RunConfig, opts: BrowserRunOptions = {}): Promise<Record<string, unknown>> {
  const runner = await openRunner(opts);
  try {
    return await runner.run(config);
  } finally {
    await runner.close();
  }
}

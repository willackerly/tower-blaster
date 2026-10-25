// Node side: serve the runner page with cross-origin isolation, drive it in
// Chromium through Playwright, and return the page's result record.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { type RunConfig, toQuery } from './config.ts';

export interface BrowserRunOptions {
  headed?: boolean;
  /** Playwright channel, e.g. "chrome" to use the installed Google Chrome. */
  channel?: string;
  timeoutMs?: number;
  extraArgs?: string[];
}

export function chromiumArgs(): string[] {
  // Developer features turn off Chrome's 100 µs timestamp-query quantization.
  const args = ['--enable-unsafe-webgpu', '--enable-webgpu-developer-features'];
  if (platform() === 'linux') args.push('--enable-features=Vulkan');
  return args;
}

export async function runInBrowser(config: RunConfig, opts: BrowserRunOptions = {}): Promise<Record<string, unknown>> {
  const server = await createServer({ configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' } });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) throw new Error('vite did not report a URL');
  const browser = await chromium.launch({
    headless: !opts.headed,
    args: [...chromiumArgs(), ...(opts.extraArgs ?? [])],
    ...(opts.channel ? { channel: opts.channel } : {}),
  });
  try {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    // Serve from localhost, not 127.0.0.1, so the page is a secure context
    // with an origin that matches the isolation headers.
    await page.goto(new URL(toQuery({ ...config, autorun: true }), base.replace('127.0.0.1', 'localhost')).toString());
    await page.waitForFunction(() => ['done', 'error'].includes(window.__tb?.status), undefined, { timeout: opts.timeoutMs ?? 600_000, polling: 250 });
    const h = await page.evaluate(() => window.__tb);
    if (h.status === 'error') throw new Error(`runner page failed: ${h.error}`);
    if (errors.length) throw new Error(`page errors: ${errors.join('; ')}`);
    return h.result as Record<string, unknown>;
  } finally {
    await browser.close();
    await server.close();
  }
}

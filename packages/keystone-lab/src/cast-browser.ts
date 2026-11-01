// The cast's GPU player (roadmap G5.1): the game's cast page (packages/game
// cast.html) in Chromium through Playwright, served by the game's own Vite
// config so the page plays with exactly the game's engine settings.
// Playwright's Chromium runs WebGPU on SwiftShader on Linux; channel "chrome"
// uses the installed Chrome and so the real GPU (Metal on the M5 Max).
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import type { Page } from 'playwright';
import { createServer } from 'vite';
import { CLOSE_TIMEOUT_MS, closeWithin, launchChromium, WEBGPU_ARGS } from '@tb/testkit';
import { type CastPlay, readShots, writeShots } from '@tb/keystone';
import type { CastPlayer } from './cast.ts';

export interface BrowserCastOptions {
  /** Playwright channel: "chrome" for the installed Chrome (the real GPU on a Mac). */
  channel?: string;
  headed?: boolean;
  /** The game's engine kind the page plays on (default gpu). */
  engine?: 'gpu' | 'rapier';
  /** Engine step cap per play (castPlay's maxSteps). */
  maxSteps?: number;
  /** Lines per page.evaluate call: smaller batches report progress sooner (default 4). */
  batch?: number;
}

export interface BrowserCastPlayer extends CastPlayer {
  /** True on a software adapter (SwiftShader): its plays are valid, its timings are not performance results. */
  software: boolean;
  /** Wall time of each play in the page, ms, in play order. */
  readonly playMs: number[];
  close(): Promise<string[]>;
}

/** Opens the cast page on a browser and returns a player bound to it; close() it when done. */
export async function openBrowserCastPlayer(opts: BrowserCastOptions = {}): Promise<BrowserCastPlayer> {
  const server = await createServer({
    configFile: fileURLToPath(new URL('../../game/vite.config.ts', import.meta.url)),
    // No file watching or HMR: an edit or a checkout while a cast runs must not reload the page under it.
    server: { port: 0, host: '127.0.0.1', watch: null, hmr: false }, logLevel: 'silent' });
  await server.listen();
  const base = server.resolvedUrls?.local[0];
  if (!base) { await server.close(); throw new Error('vite did not report a URL'); }
  // localhost is a secure context (WebGPU needs one); 127.0.0.1 is not.
  const origin = base.replace('127.0.0.1', 'localhost');
  const { browser, close: closeBrowser } = await launchChromium({
    headless: !opts.headed,
    args: platform() === 'linux' ? WEBGPU_ARGS : ['--enable-unsafe-webgpu'],
    ...(opts.channel ? { channel: opts.channel } : {}),
  }).catch(async (e: unknown) => { await server.close(); throw e; });
  const close = () => closeWithin([['browser', closeBrowser], ['vite server', () => server.close()]], CLOSE_TIMEOUT_MS);
  let page: Page;
  try {
    page = await browser.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(new URL(`/cast.html?engine=${opts.engine ?? 'gpu'}`, origin).toString());
    await page.waitForFunction(() => window.__cast?.status !== 'loading', undefined, { timeout: 120_000, polling: 250 });
    const st = await page.evaluate(() => ({ status: window.__cast.status, error: window.__cast.error }));
    if (st.status !== 'ready') throw new Error(`the cast page failed: ${st.error}${errors.length ? `; ${errors.join('; ')}` : ''}`);
  } catch (e) {
    await close();
    throw e;
  }
  const info = await page.evaluate(() => ({ adapter: window.__cast.adapter, software: window.__cast.software, engine: window.__cast.engine }));
  const playMs: number[] = [], batch = Math.max(1, opts.batch ?? 4);
  return {
    adapter: info.adapter, software: info.software, engine: info.engine, playMs,
    // The game aims for the GPU engine's one substep per step; Rapier substeps once per iteration (4).
    substeps: info.engine === 'rapier' ? 4 : 1,
    async play(level, lines) {
      const out: CastPlay[] = [];
      for (let k = 0; k < lines.length; k += batch) {
        const text = lines.slice(k, k + batch).map((l) => writeShots(l));
        // Shot text holds integers only (readShots checks each shot), so a line crosses to the page exactly.
        for (const t of text) readShots(t);
        const got = await page.evaluate(([lv, ls, max]) => window.__cast.play(lv, ls, max ?? undefined), [level, text, opts.maxSteps ?? null] as const);
        for (const { ms, ...p } of got) { playMs.push(ms); out.push(p); }
      }
      return out;
    },
    close,
  };
}

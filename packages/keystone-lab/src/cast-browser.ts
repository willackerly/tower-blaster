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
import { type CastPlay, type LevelDef, readShots, type RubeResult, type Shot, writeShots } from '@tb/keystone';
import type { RestReport } from '../../game/src/cast-page.ts';
import type { CastPlayer } from './cast.ts';
import { withPageRetry } from './page-retry.ts';

export interface BrowserCastOptions {
  /** Playwright channel: "chrome" for the installed Chrome (the real GPU on a Mac). */
  channel?: string;
  headed?: boolean;
  /** The game's engine kind the page plays on (default gpu). */
  engine?: 'gpu' | 'rapier';
  /** Engine step cap per play (castPlay's maxSteps). */
  maxSteps?: number;
  /** A Chorus level: play world k alone (the cast page's chorusOnly). */
  chorusOnly?: number;
  /** Lines per page.evaluate call: smaller batches report progress sooner (default 4). */
  batch?: number;
  /** Times a batch is replayed on a reopened page after the page is lost under it (default 2). */
  retries?: number;
  /**
   * A batch still running after this many ms is taken as a hung page or GPU (B1 at Bounce 0.4 on the M5,
   * 2026-11-06: no progress for 2.5 h): the page is closed, which loses it, so the batch is replayed on a fresh
   * page like any lost page, and after the retries the cast fails instead of hanging. Default 30 min; 0 is off.
   */
  batchTimeoutMs?: number;
}

/** A way to lose the cast page, for tests: navigate it away (its context is destroyed) or close it. */
export type PageFault = 'navigate' | 'close';

async function injectFault(p: Page, f: PageFault): Promise<void> {
  if (f === 'navigate') await p.goto('about:blank').catch(() => undefined);
  else await p.close().catch(() => undefined);
}

export interface BrowserCastPlayer extends CastPlayer {
  /** True on a software adapter (SwiftShader): its plays are valid, its timings are not performance results. */
  software: boolean;
  /** As play, with a Chorus level's world k played alone (chorusOnly for these lines only): the verify's solo arm. */
  playOnly(level: LevelDef, lines: Shot[][], chorusOnly: number): Promise<CastPlay[]>;
  /** Wall time of each play in the page, ms, in play order. */
  readonly playMs: number[];
  /** One line per page lost mid-batch and reopened (when, what was running, the error): empty on a clean cast. */
  readonly reopens: string[];
  /** Test hook: loses the page about 0.5 s into the next batch (or rest), so the reopen and replay path runs. */
  injectFault(kind: PageFault): void;
  /** Sets the batch watchdog (BrowserCastOptions.batchTimeoutMs) from the next batch on; for tests. */
  setBatchTimeout(ms: number): void;
  /** The level at rest on the page's engine (the cast page's rest: pre-settle, then `steps` with nothing fired). */
  rest(level: LevelDef, steps: number): Promise<RestReport>;
  /** A Rube Lab level played once with its plunger on the page's engine (cast-page.ts rube). */
  rube(level: LevelDef): Promise<RubeResult & { ms: number }>;
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
  const url = new URL(`/cast.html?engine=${opts.engine ?? 'gpu'}`, origin).toString();
  // Opens the cast page and waits until it is ready; the previous page, if any, is closed first.
  let page: Page | null = null;
  const openPage = async (): Promise<Page> => {
    if (page) await page.close().catch(() => undefined);
    const p = await browser.newPage();
    page = p;
    const errors: string[] = [];
    p.on('pageerror', (e) => errors.push(e.message));
    await p.goto(url);
    await p.waitForFunction(() => window.__cast?.status !== 'loading', undefined, { timeout: 120_000, polling: 250 });
    const st = await p.evaluate(() => ({ status: window.__cast.status, error: window.__cast.error }));
    if (st.status !== 'ready') throw new Error(`the cast page failed: ${st.error}${errors.length ? `; ${errors.join('; ')}` : ''}`);
    return p;
  };
  let info: { adapter: string; software: boolean; engine: string };
  try {
    const p = await openPage();
    info = await p.evaluate(() => ({ adapter: window.__cast.adapter, software: window.__cast.software, engine: window.__cast.engine }));
  } catch (e) {
    await close();
    throw e;
  }
  const playMs: number[] = [], reopens: string[] = [], batch = Math.max(1, opts.batch ?? 4);
  let fault: PageFault | null = null, batchTimeoutMs = opts.batchTimeoutMs ?? 30 * 60_000;
  // Runs fn on the live page; a page lost under it (see page-retry.ts) is reopened and fn run again.
  const onPage = <T>(what: string, fn: (p: Page) => Promise<T>): Promise<T> => withPageRetry(
    () => {
      const p = page!, run = fn(p), limit = batchTimeoutMs;
      if (fault) { const f = fault; fault = null; setTimeout(() => { void injectFault(p, f); }, 500); }
      if (!(limit > 0)) return run;
      const watchdog = setTimeout(() => {
        console.error(`cast: ${what}: no result after ${(limit / 60_000).toFixed(1)} min; closing the page as hung`);
        void p.close().catch(() => undefined);
      }, limit);
      return run.finally(() => clearTimeout(watchdog));
    },
    async () => {
      const p = await openPage();
      const again = await p.evaluate(() => window.__cast.adapter);
      // The replayed batch must run on the same adapter, or its results would not belong to this cast.
      if (again !== info.adapter) throw new Error(`the reopened cast page has adapter ${again}, not ${info.adapter}`);
    },
    { retries: opts.retries ?? 2, onLost: (e, n) => {
      const msg = `${new Date().toISOString()} ${what}: page lost (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); reopened, attempt ${n + 1}`;
      reopens.push(msg);
      console.error(`cast: ${msg}`);
    } });
  return {
    adapter: info.adapter, software: info.software, engine: info.engine, playMs, reopens,
    // The game aims for the GPU engine's one substep per step; Rapier substeps once per iteration (4).
    substeps: info.engine === 'rapier' ? 4 : 1,
    play: (level, lines, nudges) => playLines(level, lines, nudges ?? null, opts.chorusOnly ?? null),
    playOnly: (level, lines, k) => playLines(level, lines, null, k),
    rest: (level, steps) => onPage('rest', (p) => p.evaluate(([lv, n]) => window.__cast.rest(lv, n), [level, steps] as const)),
    rube: (level) => onPage(`rube ${level.id}`, (p) => p.evaluate((lv) => window.__cast.rube(lv), level)),
    injectFault(kind) { fault = kind; },
    setBatchTimeout(ms) { batchTimeoutMs = ms; },
    close,
  };
  async function playLines(level: LevelDef, lines: Shot[][], nudges: readonly number[] | null, only: number | null): Promise<CastPlay[]> {
    const out: CastPlay[] = [];
    for (let k = 0; k < lines.length; k += batch) {
      const text = lines.slice(k, k + batch).map((l) => writeShots(l)), nud = nudges ? nudges.slice(k, k + batch) : null;
      // Shot text holds integers only (readShots checks each shot), so a line crosses to the page exactly; so do the nudge seeds.
      for (const t of text) readShots(t);
      // Each play starts from the level on a fresh engine, so a batch replayed on a reopened page returns the same plays.
      const got = await onPage(`plays ${k + 1}-${k + text.length}`, (p) => p.evaluate(([lv, ls, max, nd, w]) => window.__cast.play(lv, ls, max ?? undefined, nd ?? undefined, w ?? undefined), [level, text, opts.maxSteps ?? null, nud, only] as const));
      for (const { ms, ...p } of got) { playMs.push(ms); out.push(p); }
    }
    return out;
  }
}

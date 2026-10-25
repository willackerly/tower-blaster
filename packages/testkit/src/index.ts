// Runs code in a real browser WebGPU context from Node tests. On machines
// without a GPU, Chromium falls back to SwiftShader, which is slow but
// spec-conformant: good for correctness, useless for timing.
import { chromium, type Browser, type Page } from 'playwright';
import { CLOSE_TIMEOUT_MS, closeWithin, releaseStdioOnExit, type ReleaseOptions } from './teardown.ts';

export const WEBGPU_ARGS = ['--enable-unsafe-webgpu', '--enable-features=Vulkan'];

// navigator.gpu needs a secure context; localhost qualifies, and routing it
// means no server is required.
const ORIGIN = 'http://localhost:7357';

export interface AdapterSummary { vendor: string; architecture: string; description: string; features: string[] }

export interface WebGPUSession {
  page: Page;
  adapter: AdapterSummary;
  /** Close the browser, waiting at most CLOSE_TIMEOUT_MS: resolves to ['browser'] if it had not exited (see closeWithin). */
  close(): Promise<string[]>;
}

/**
 * Launch Chromium through a Playwright browser server, the launch that
 * exposes the browser's process, and release its stdio once it has exited
 * (releaseStdioOnExit; see teardown.ts for why). close() closes the browser
 * as browser.close() does: gracefully, with a SIGKILL after 30 s.
 */
export async function launchChromium(options: Parameters<typeof chromium.launchServer>[0] = {}, release: ReleaseOptions = {}): Promise<{ browser: Browser; close(): Promise<void> }> {
  const server = await chromium.launchServer(options);
  releaseStdioOnExit(server.process(), release);
  try {
    const browser = await chromium.connect(server.wsEndpoint());
    return { browser, close: () => server.close() };
  } catch (e) {
    await server.kill();
    throw e;
  }
}

export async function openWebGPU(extraArgs: string[] = [], opts: { channel?: string; headless?: boolean } = {}): Promise<WebGPUSession | null> {
  let browser: Browser, closeBrowser: () => Promise<void>;
  try {
    ({ browser, close: closeBrowser } = await launchChromium({ args: [...WEBGPU_ARGS, ...extraArgs], headless: opts.headless ?? true, ...(opts.channel ? { channel: opts.channel } : {}) }));
  } catch (e) {
    if (requireWebGPU()) throw e;
    return null;
  }
  const page = await browser.newPage();
  await page.route(`${ORIGIN}/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><title>webgpu</title>' }),
  );
  await page.goto(`${ORIGIN}/`);
  const adapter = await page.evaluate(async () => {
    if (!('gpu' in navigator)) return null;
    const a = await navigator.gpu.requestAdapter();
    if (!a) return null;
    return {
      vendor: a.info.vendor,
      architecture: a.info.architecture,
      description: a.info.description,
      features: [...a.features] as string[],
    };
  });
  if (!adapter) {
    await closeBrowser();
    if (requireWebGPU()) throw new Error('WebGPU adapter unavailable in Chromium');
    return null;
  }
  return { page, adapter, close: () => closeWithin([['browser', closeBrowser]], CLOSE_TIMEOUT_MS) };
}

/** CI sets REQUIRE_WEBGPU=1 so a missing adapter fails instead of skipping. */
export function requireWebGPU(): boolean {
  return process.env.REQUIRE_WEBGPU === '1';
}

export function isSoftwareAdapter(a: AdapterSummary): boolean {
  return /swiftshader|llvmpipe|lavapipe|software/i.test(`${a.vendor} ${a.architecture} ${a.description}`);
}

/**
 * Bundle a TypeScript entry for the page (esbuild, IIFE) and install its
 * exports as `window[globalName]`, so tests can call real package code inside
 * the browser rather than pasting shader strings into page.evaluate.
 */
export async function loadBundle(page: Page, entry: string, globalName = '__tb_test'): Promise<void> {
  const { build } = await import('esbuild');
  const out = await build({ entryPoints: [entry], bundle: true, format: 'iife', globalName, target: 'es2022', write: false, logLevel: 'silent' });
  await page.addScriptTag({ content: out.outputFiles[0]!.text });
}
export * from './contract.ts';
export * from './collapse.ts';
export * from './observe.ts';
export * from './teardown.ts';

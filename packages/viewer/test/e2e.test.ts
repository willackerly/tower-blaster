// The viewer in headless Chromium: it boots, renders a non-blank scene,
// steps physics, and a fired ball becomes a new body. SwiftShader in CI.
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { requireWebGPU, WEBGPU_ARGS } from '@tb/testkit';
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

/** Minimal RGBA PNG encoder for debug screenshots of offscreen frames. */
function encodePng(w: number, h: number, px: { data: number[]; bytesPerRow: number }): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * px.bytesPerRow + 4 * x, o = y * (w * 4 + 1) + 1 + 4 * x;
    raw[o] = px.data[i]!; raw[o + 1] = px.data[i + 1]!; raw[o + 2] = px.data[i + 2]!; raw[o + 3] = 255;
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.concat([Buffer.from(type), data]); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(t)); return Buffer.concat([len, t, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

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

async function open(search: string) {
  const page = await browser!.newPage({ viewport: { width: 640, height: 400 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(new URL(search, origin).toString());
  await page.waitForFunction(() => window.__viewer?.status !== 'loading', undefined, { timeout: 60_000 });
  return { page, errors };
}

describe('viewer', () => {
  it('renders a tower, steps physics and fires a ball', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=3&param.H=6&param.gap=0.02&offscreen=1');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.frames > 10 && window.__viewer.stepIndex > 5, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.bodies)).toBe(54);

    const stats = await page.evaluate((keep) => window.__viewer.capture(keep), !!process.env.VIEWER_SCREENSHOT);
    expect(stats).not.toBeNull();
    // Bodies cover part of the frame, with lit and shadowed faces in several colours: not blank.
    expect(stats!.bodyFraction).toBeGreaterThan(0.05);
    expect(stats!.distinctColors).toBeGreaterThan(50);
    if (process.env.VIEWER_SCREENSHOT) writeFileSync(process.env.VIEWER_SCREENSHOT, encodePng(stats!.width, stats!.height, stats!.pixels!));

    await page.evaluate(() => window.__viewer.fire(0, 0));
    await page.waitForFunction(() => window.__viewer.bodies === 55, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => window.__viewer.inputs.length)).toBe(1);
    expect(await page.locator('#hud').innerText()).toMatch(/bodies[\s\S]*ms\/step/);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('shows a readable error for a bad URL instead of a blank page', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page } = await open('/?scenario=S99&offscreen=1');
    expect(await page.evaluate(() => window.__viewer.status)).toBe('error');
    expect(await page.locator('#error').innerText()).toMatch(/unknown scenario S99/);
    await page.close();
  });
});

// The browser half of pnpm playtest:smoke against the game page itself (the
// Vite dev server, no gate: the pass cookie is ignored there), so a change to
// the front door or the HUD that would break the deploy's smoke check fails
// here first, before it reaches main. And it names the step that fails.
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import { smokeBrowser } from '../src/smoke.ts';

let server: ViteDevServer | null = null;
let origin = '';
beforeAll(async () => {
  server = await createServer({ configFile: fileURLToPath(new URL('../../game/vite.config.ts', import.meta.url)), server: { port: 0, host: '127.0.0.1' }, logLevel: 'silent' });
  await server.listen();
  origin = server.resolvedUrls!.local[0]!.replace('127.0.0.1', 'localhost').replace(/\/$/, '');
}, 120_000);
afterAll(async () => { await server?.close(); });

describe('playtest smoke in the browser', () => {
  it('the front door, Play, the level loads, the first shot fires, no page errors', async () => {
    expect(await smokeBrowser(origin, 'unused-without-a-gate')).toEqual([]);
  }, 300_000);
  it('names the step that fails: a site that serves something else never shows the front door', async () => {
    const other = httpServer((_, res) => res.end('<!doctype html><p>not the game</p>'));
    await new Promise<void>((r) => other.listen(0, '127.0.0.1', r));
    try {
      const [problem] = await smokeBrowser(`http://localhost:${(other.address() as AddressInfo).port}`, 'x', { timeoutMs: 3_000 });
      expect(problem).toMatch(/^in the browser, the front door: page.waitForFunction: Timeout 3000ms exceeded/);
    } finally {
      other.close();
    }
  }, 120_000);
});

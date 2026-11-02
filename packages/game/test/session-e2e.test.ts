// Save session on the game page (roadmap G8): a round saved from the result card
// replays from the file's link to the same score and state, a banked round
// included; and a browser without WebGPU gets the explanation, not a raw error.
// Rapier (deterministic here), headless Chromium.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import type { SessionFile } from '../src/session-file.ts';
import { gamePage } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;

async function saveFrom(page: import('playwright').Page): Promise<SessionFile> {
  const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.kg-result [data-act="save"]').click()]);
  return JSON.parse(readFileSync((await dl.path())!, 'utf8')) as SessionFile;
}

async function replay(file: SessionFile) {
  const u = new URL(file.replay);
  const o = await game.open(`${u.pathname}${u.search}`, 5 * MINUTES);
  const { page, errors } = o!;
  await page.evaluate(() => { window.__game.fast = true; });
  await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 5 * MINUTES, polling: 100 });
  const out = await page.evaluate(() => ({ result: window.__game.result, state: window.__game.state() }));
  expect(errors).toEqual([]);
  await page.close();
  return out;
}

describe('save session', () => {
  it('a par round saved from the result card replays from its link to the same score and state', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    for (const s of L1.solutions!.par as Shot[]) {
      await page.waitForFunction(() => window.__game.ready || window.__game.result !== null, undefined, { timeout: MINUTES, polling: 100 });
      expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
    }
    await page.waitForFunction(() => window.__game.result !== null && document.querySelector('.kg-result [data-act="save"]') !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const played = await page.evaluate(() => ({ result: window.__game.result, state: window.__game.state() }));
    const file = await saveFrom(page);
    expect(file).toMatchObject({ kind: 'keystone-session', level: 'L1', engine: 'rapier', banked: false, score: played.result });
    expect(errors).toEqual([]);
    await page.close();
    expect(await replay(file)).toEqual(played);
  }, 10 * MINUTES);

  it('a banked outcome round (B1, one shot then bank) replays with the bank to the same score', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=B1&engine=rapier&offscreen=1', 5 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.ready, undefined, { timeout: 5 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.fireOpener())).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 5 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.bank())).toBe(true);
    await page.waitForFunction(() => window.__game.result !== null && document.querySelector('.kg-result [data-act="save"]') !== null, undefined, { timeout: MINUTES, polling: 100 });
    const played = await page.evaluate(() => ({ result: window.__game.result, state: window.__game.state() }));
    const file = await saveFrom(page);
    expect(file).toMatchObject({ level: 'B1', banked: true });
    expect(new URL(file.replay).searchParams.get('keystone.bank')).toBe('1');
    expect(errors).toEqual([]);
    await page.close();
    expect(await replay(file)).toEqual(played);
  }, 15 * MINUTES);

  it('without WebGPU the page explains what to use instead', async (ctx) => {
    const b = game.browser();
    if (!b) return ctx.skip();
    const page = await b.newPage();
    await page.addInitScript(() => { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined }); delete (Navigator.prototype as { gpu?: unknown }).gpu; });
    await page.goto(game.url('/?engine=rapier&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: MINUTES });
    const text = await page.locator('#error').innerText();
    expect(text).toContain("This browser can't run Keystone");
    expect(text).toContain('Chrome');
    expect(text).not.toContain('Error:');
    await page.close();
  });
});

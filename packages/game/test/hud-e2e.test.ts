// The in-play HUD after the playtest polish (roadmap U5), on the game page at a laptop's size:
// the hint line is one short line within HELP_BUDGET (? shows every key and goes back), Leverage
// hides until the first shot, and the Down bar fills as the structure falls, with a tick per star
// threshold in collapse, lit once reached. Rapier plays B1 here as a custom run (its stars were cast
// on the GPU solver), so its bar has the objective's tick only; the GPU case loads B1 with its cast
// stars and checks all three ticks before a shot.
import { describe, expect, it } from 'vitest';
import type { Page } from 'playwright';
import { B1 } from '@tb/keystone';
import { HELP_BUDGET } from '../src/ui.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;

async function open(search: string, timeout: number): Promise<{ page: Page; errors: string[] } | null> {
  const page = await game.browser()!.newPage({ viewport: { width: 1280, height: 800 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(game.url(search));
  await page.waitForFunction(() => window.__game?.status !== 'loading', undefined, { timeout, polling: 250 });
  const st = await page.evaluate(() => ({ s: window.__game.status, e: window.__game.error }));
  if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '')) { await page.close(); return null; }
  expect(st).toEqual({ s: 'running', e: undefined });
  return { page, errors };
}

/** The bar as drawn: its fill (% of the bar), and each tick's position (%), stars and lit state. */
const meter = (page: Page) => page.evaluate(() => {
  const m = document.querySelector('.kg-hud .meter');
  if (!m) return null;
  const fill = parseFloat((m.querySelector('i') as HTMLElement).style.width);
  const ticks = [...m.querySelectorAll('.tick')].map((t) => ({ at: parseFloat((t as HTMLElement).style.left), stars: t.textContent!.length, got: t.classList.contains('got'), obj: t.classList.contains('obj') }));
  return { fill, ticks };
});

/** The help panel's text and how many lines it takes. */
const helpLines = (page: Page) => page.evaluate(() => {
  const h = document.getElementById('help')!, cs = getComputedStyle(h);
  const inner = h.getBoundingClientRect().height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  return { text: h.innerText, lines: Math.round(inner / parseFloat(cs.lineHeight)) };
});

describe('HUD polish on the game page', () => {
  it('a short hint line, Leverage after the first shot, and a Down bar that fills as B1 falls', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await open('/?level=B1&engine=rapier&offscreen=1&progress=off', 5 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 5 * MINUTES);

    const help = await helpLines(page);
    console.log(`hint line (${help.text.length} chars): ${help.text}`);
    expect(help.text.length).toBeLessThanOrEqual(HELP_BUDGET);
    expect(help.lines).toBe(1);
    await page.keyboard.press('?');
    const all = await helpLines(page);
    expect(all.text).toMatch(/Space/);
    expect(all.text.length).toBeGreaterThan(HELP_BUDGET);
    await page.locator('#help [data-act="keys"]').click();
    expect((await helpLines(page)).text).toBe(help.text);

    // Before the first shot: no Leverage; the bar empty with one tick, the objective's 40%, not reached.
    expect(await page.locator('.kg-hud').innerText()).not.toMatch(/Leverage/);
    const min = B1.objective.kind === 'collapse' ? B1.objective.min : NaN;
    expect(await meter(page)).toEqual({ fill: 0, ticks: [{ at: 100 * min, stars: 1, got: false, obj: true }] });

    // The pre-aimed opener: the bar fills as the wall comes down, and stays with what the HUD's Down says.
    expect(await page.evaluate(() => window.__game.fireOpener())).toBe(true);
    const fills: number[] = [];
    while (await page.evaluate(() => window.__game.phase === 'running')) {
      const m = await meter(page);
      if (m) fills.push(m.fill);
      await page.waitForTimeout(200);
      if (fills.length === 25) await page.evaluate(() => { window.__game.fast = true; });
    }
    await ready(page, 5 * MINUTES);
    const end = (await meter(page))!, d = await page.evaluate(() => window.__game.collapse);
    console.log(`bar while falling: ${fills.map((f) => f.toFixed(0)).join(' ')}; settled D ${d.toFixed(3)}`);
    expect(Math.max(...fills)).toBeGreaterThan(0);
    expect(end.fill).toBeCloseTo(Math.min(100, 100 * d), 0);
    expect(end.ticks[0]!.got).toBe(d >= min);
    expect(await page.locator('.kg-hud').innerText()).toMatch(/Leverage\s+×/);
    expect(errors).toEqual([]);
    await page.close();
  }, 15 * MINUTES);

  it('on the engine its stars were cast on, B1 shows all three ticks: objective, T2, T3', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await open('/?level=B1&engine=gpu&offscreen=1&progress=off', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => document.querySelector('.kg-hud .meter') !== null, undefined, { timeout: 10 * MINUTES, polling: 250 });
    const min = B1.objective.kind === 'collapse' ? B1.objective.min : NaN;
    expect((await meter(page))!.ticks).toEqual([
      { at: 100 * min, stars: 1, got: false, obj: true },
      { at: 100 * B1.stars!.t2, stars: 2, got: false, obj: false },
      { at: 100 * B1.stars!.t3, stars: 3, got: false, obj: false },
    ]);
    expect(await page.locator('.kg-hud').innerText()).not.toMatch(/custom/);
    expect(errors).toEqual([]);
    await page.close();
  }, 15 * MINUTES);
});

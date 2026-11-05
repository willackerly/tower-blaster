// Pulls on the game page (C1, docs/game/undercut-bullet-time.md): with `pull` racked
// (keystone.rack), hovering a plain block aims a pull of it and a crown is refused;
// firing takes the block out, the column above drops one h (the collapse fraction
// moves by the column's share), the pulled block can no longer be aimed at, and the
// page ends where runSession ends the same line headless and where its own replay
// ends it. Rapier through the aim path; the GPU solver from a link (SwiftShader in CI).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
const RACK = ['pull', 'pull'];
const c = compileLevel({ ...L1, rack: ['pull', 'pull'] });
/** L1's base blocks (home centre half an h up), lowest id first, and each one's column above. */
const bases = [...Array(c.meta.n).keys()].filter((i) => Math.abs(c.meta.home[3 * i + 1]! - 0.25) < 1e-6);
const LINE: Shot[] = [{ ammo: 'pull', body: bases[0]! }, { ammo: 'pull', body: bases[3]! }];
/**
 * One column of nine cubes (each 31.25 kg) one h (0.5 m) lower, over the tower's whole span (40
 * cubes from home down to lying on the ground): about 0.05 of D per pull.
 */
const COLUMN_D = (9 * 0.5) / (c.meta.n * (c.meta.home.filter((_, k) => k % 3 === 1).reduce((a, y) => a + y, 0) / c.meta.n - 0.25));

describe('pull on the game page', () => {
  it('the line pulls two of L1\'s four base blocks, each under a column of nine', () => {
    expect(bases).toHaveLength(4);
    expect(COLUMN_D).toBeGreaterThan(0.04);
    expect(COLUMN_D).toBeLessThan(0.06);
  });

  it('Rapier: hover aims a pull, a crown is refused, the pulled block is gone from the aim, and the page replays the line', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&keystone.rack=${RACK.join(',')}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.select('pull'))).toBe(true);
    // Sweep the view for what a pull would take under each point: plain blocks, crowns refused.
    const seen = await page.evaluate(() => {
      const out: Array<{ body: number; ok: boolean }> = [];
      for (let y = -0.9; y <= 0.9; y += 0.05) for (let x = -0.5; x <= 0.5; x += 0.05) {
        const a = window.__game.aim(x, y);
        if (a && a.shot.ammo === 'pull') out.push({ body: a.shot.body, ok: a.reachable });
      }
      return out;
    });
    const crowns = new Set(c.meta.crowns);
    expect(seen.some((s) => s.ok)).toBe(true);
    for (const s of seen) expect(s.ok, `body ${s.body}`).toBe(!crowns.has(s.body));
    expect(seen.some((s) => crowns.has(s.body)), 'the sweep reaches the crown course').toBe(true);
    // A refused pull does nothing.
    expect(await page.evaluate((b) => window.__game.fire({ ammo: 'pull', body: b }), c.meta.crowns[0]!)).toBe(false);
    for (const [k, shot] of LINE.entries()) {
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
      await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), k + 1, { timeout: 4 * MINUTES, polling: 100 });
      const d = await page.evaluate(() => window.__game.collapse);
      expect(d / ((k + 1) * COLUMN_D), `D after pull ${k + 1}`).toBeGreaterThan(0.9);
      expect(d / ((k + 1) * COLUMN_D), `D after pull ${k + 1}`).toBeLessThan(1.1);
    }
    expect(await page.evaluate(() => window.__game.phase)).toBe('failed');
    const live = await page.evaluate(() => window.__game.state());
    const r = await runSession(new RapierEngine(), c, LINE, driverOptions('rapier'));
    expect(r.session.phase).toBe('failed');
    expect(live).toEqual({ step: r.steps, phase: 'failed', strokes: 2, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate((s) => window.__game.replay(s), LINE)).toEqual(live);
    expect(await page.evaluate(() => ({ fired: window.__game.counts.fired, status: window.__game.status }))).toEqual({ fired: 2, status: 'running' });
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);

  it('GPU solver: a pull line from the link wakes and drops the column above, and replays bit-equal on the same device', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=gpu&offscreen=1&keystone.rack=${RACK.join(',')}&keystone.shots=${writeShots(LINE)}`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__game.engine)).toBe('gpu');
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 20 * MINUTES, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    expect(live.phase).toBe('failed');
    const d = await page.evaluate(() => window.__game.collapse);
    expect(d / (2 * COLUMN_D)).toBeGreaterThan(0.9);
    expect(d / (2 * COLUMN_D)).toBeLessThan(1.1);
    expect(await page.evaluate((s) => window.__game.replay(s), LINE)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 40 * MINUTES);
});

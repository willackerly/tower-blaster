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
import { PULL_SLIDE_STEPS } from '../src/pull-anim.ts';
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
      const out: Array<{ body: number; ok: boolean; at: [number, number] }> = [];
      for (let y = -0.9; y <= 0.9; y += 0.05) for (let x = -0.5; x <= 0.5; x += 0.05) {
        const a = window.__game.aim(x, y);
        if (a && a.shot.ammo === 'pull') out.push({ body: a.shot.body, ok: a.reachable, at: [x, y] });
      }
      return out;
    });
    const crowns = new Set(c.meta.crowns);
    expect(seen.some((s) => s.ok)).toBe(true);
    for (const s of seen) expect(s.ok, `body ${s.body}`).toBe(!crowns.has(s.body));
    expect(seen.some((s) => crowns.has(s.body)), 'the sweep reaches the crown course').toBe(true);
    // The refusal hint (PT17): neutral while a crown is only hovered, red once a click on it is refused, and
    // neutral again after the aim has left the crown and come back.
    const crown = seen.find((s) => crowns.has(s.body))!, plain = seen.find((s) => s.ok)!;
    const hint = () => page.evaluate(() => {
      const el = document.querySelector('.pull-hint');
      return el ? { cls: el.className, colour: getComputedStyle(el).color } : null;
    });
    const hintIs = (cls: string | null) => page.waitForFunction((want) => (document.querySelector('.pull-hint')?.className.split(' ')[0] ?? null) === want, cls, { timeout: 30_000, polling: 50 });
    const RED = 'rgb(240, 128, 106)';
    await page.evaluate((at) => window.__game.aim(at[0], at[1]), crown.at);
    await hintIs('hint');
    const hovered = (await hint())!;
    expect(hovered.colour).not.toBe(RED);
    // A refused pull does nothing, and turns the hint red.
    expect(await page.evaluate((b) => window.__game.fire({ ammo: 'pull', body: b }), crown.body)).toBe(false);
    await hintIs('bad');
    expect((await hint())!.colour).toBe(RED);
    await page.evaluate((at) => window.__game.aim(at[0], at[1]), plain.at);
    await hintIs(null);
    await page.evaluate((at) => window.__game.aim(at[0], at[1]), crown.at);
    await hintIs('hint');
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

  it('Rapier: a pull is drawn (PT17): ten steps on the block is out of its slot by more than half its depth and shrinking, then gone; keystone.pullanim=0 draws none', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    for (const anim of [true, false]) {
      // A freeze (Bullet Time's, keystone.freeze=1) holds the world ten steps after the pull, for the reads.
      const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&keystone.rack=${RACK.join(',')}&keystone.freeze=1${anim ? '' : '&keystone.pullanim=0'}`);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await ready(page);
      expect(await page.evaluate(() => window.__game.select('pull'))).toBe(true);
      // A plain block in view: the first the aim would pull, sweeping up from the bottom of the view.
      const body = await page.evaluate(() => {
        for (let y = 0.9; y >= -0.9; y -= 0.05) for (let x = -0.3; x <= 0.3; x += 0.05) { const a = window.__game.aim(x, y); if (a && a.shot.ammo === 'pull' && a.reachable) return a.shot.body; }
        return -1;
      });
      expect(body).toBeGreaterThanOrEqual(0);
      expect(await page.evaluate((b) => window.__game.coverage(b), body)).toBeGreaterThan(20);
      const start = await page.evaluate(() => window.__game.stepIndex);
      await page.evaluate(([b, n]) => new Promise<void>((done) => {
        if (!window.__game.fire({ ammo: 'pull', body: b })) throw new Error('the pull was refused');
        const t = setInterval(() => { if (window.__game.stepIndex >= n) { clearInterval(t); window.__game.freeze(true); done(); } }, 2);
      }), [body, start + 10] as const);
      const k = (await page.evaluate(() => window.__game.stepIndex)) - start;
      expect(k).toBeGreaterThanOrEqual(10);
      expect(k).toBeLessThanOrEqual(PULL_SLIDE_STEPS);
      const drawn = await page.evaluate(() => window.__game.pullDrawn);
      const cover = await page.evaluate((b) => window.__game.coverage(b), body);
      if (anim) {
        expect(drawn).not.toBeNull();
        expect({ body: drawn!.body, k: drawn!.k }).toEqual({ body, k });
        const home = [0, 1, 2].map((j) => c.meta.home[3 * body + j]!);
        // The block's depth is one h (0.5 m): more than half of it out, at the height it stood.
        expect(Math.hypot(drawn!.pos[0] - home[0]!, drawn!.pos[2] - home[2]!)).toBeGreaterThan(0.25);
        expect(Math.abs(drawn!.pos[1] - home[1]!), 'at the height it stood (settled a little under its build pose)').toBeLessThan(0.05);
        expect(drawn!.scale).toBeGreaterThan(0.3);
        expect(drawn!.scale).toBeLessThan(1);
        expect(cover, 'the sliding block is in the frame').toBeGreaterThan(0);
      } else {
        expect(drawn).toBeNull();
        expect(cover).toBe(0);
      }
      // Resumed, the slide ends and the slot is a tombstone again, drawn by nothing.
      expect(await page.evaluate(() => window.__game.freeze(false))).toBe(true);
      await page.waitForFunction((n) => window.__game.stepIndex >= n || window.__game.ready, start + PULL_SLIDE_STEPS + 3, { timeout: MINUTES, polling: 20 });
      expect(await page.evaluate(() => window.__game.pullDrawn)).toBeNull();
      expect(await page.evaluate((b) => window.__game.coverage(b), body)).toBe(0);
      expect(errors).toEqual([]);
      await page.close();
    }
  }, 5 * MINUTES);

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

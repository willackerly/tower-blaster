// Bullet Time on the game page (C2, docs/game/undercut-bullet-time.md): with a freeze budget
// (keystone.freeze) a running shot can be frozen (key T, handle.freeze), the physics stands
// still while the player aims, resuming costs nothing, and a shot fired while frozen cuts in at
// the frozen step and spends a freeze, even with rapid fire off (keystone.rapid=0). The line
// it records replays headless, and on the page, to the exact state. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
/**
 * A marble well wide of the tower, lobbed high so it runs a while, then the par cannonball while it is frozen. Fired
 * flat (pitch 0) it left the lot and the run ended about 20 steps in, so the second freeze, asked for some 15 steps
 * in, raced the end of the run and lost on a slow CI runner; lobbed at 70 deg the run lasts about 95 steps.
 */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 700, power: 30 };
const par = L1.solutions!.par![0] as Shot;
const URL = '/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.rapid=0&keystone.freeze=1';

describe('Bullet Time on the game page', () => {
  it('freeze holds the physics, resume is free, a frozen shot cuts in and spends the freeze; the line replays', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const fz = (on?: boolean) => page.evaluate((v) => window.__game.freeze(v), on);
    const at = () => page.evaluate(() => window.__game.stepIndex);
    // Nothing to freeze while aiming.
    expect(await fz(true)).toBe(false);
    const start = await at();
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 10, { timeout: 60_000, polling: 20 });
    // Rapid fire is off: unfrozen, a shot mid-run is refused.
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(false);
    expect(await fz(true)).toBe(true);
    const held = await at();
    await page.waitForTimeout(400);
    expect(await at()).toBe(held);
    expect(await page.evaluate(() => ({ frozen: window.__game.frozen, phase: window.__game.phase }))).toEqual({ frozen: true, phase: 'running' });
    // Resume without firing: free, and the shot runs on.
    expect(await fz(false)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, held + 5, { timeout: 60_000, polling: 20 });
    expect(await fz(true)).toBe(true);
    const frozenAt = await at();
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(true);
    expect(await page.evaluate(() => ({ frozen: window.__game.frozen, strokes: window.__game.strokes }))).toEqual({ frozen: false, strokes: 2 });
    // The one freeze is spent.
    expect(await fz(true)).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    const line = await page.evaluate(() => window.__game.line());
    console.log(`frozen line: ${writeShots(line)}`);
    expect(line.map((s) => s.after)).toEqual([undefined, frozenAt - start]);
    expect(await page.evaluate(() => window.__game.counts.cut)).toBe(1);
    const r = await runSession(new RapierEngine(), compileLevel({ ...L1, freeze: 1 }), line, driverOptions('rapier'));
    expect(r.session.outcomes[0]!.cut).toBe(true);
    expect(r.session.freezesLeft).toBe(0);
    const live = await page.evaluate(() => window.__game.state());
    expect(live).toEqual({ step: r.steps, phase: r.session.phase, strokes: 2, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate((l) => window.__game.replay(l), line)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
  it('the frozen look (PT8): the frozen frame\'s mean saturation is at least 30% under the same frozen world drawn plain, and the label says what to do', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const sat = (p: { width: number; height: number; pixels?: { data: number[]; bytesPerRow: number } } | null) => {
      const px = p!.pixels!;
      let s = 0;
      for (let y = 0; y < p!.height; y++) for (let x = 0; x < p!.width; x++) {
        const o = y * px.bytesPerRow + 4 * x, r = px.data[o]!, g = px.data[o + 1]!, b = px.data[o + 2]!, mx = Math.max(r, g, b);
        s += mx > 0 ? (mx - Math.min(r, g, b)) / mx : 0;
      }
      return s / (p!.width * p!.height);
    };
    const o = await game.open(URL);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.frozenLook)).toBe(true);
    const label = () => page.evaluate(() => { const el = document.querySelector('.kg-frozen'); return el ? { on: el.classList.contains('on'), text: el.textContent } : null; });
    expect((await label())?.on).toBe(false);
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 10, { timeout: 60_000, polling: 20 });
    expect(await page.evaluate(() => window.__game.freeze(true))).toBe(true);
    // The grade eases in over 0.15 s of frames (however slow they come); the world stands still, so both frames show the same state.
    await page.waitForFunction(() => window.__game.frozenGrade === 1, undefined, { timeout: 30_000, polling: 50 });
    const graded = await page.evaluate(() => window.__game.capture(true));
    expect(await label()).toEqual({ on: true, text: expect.stringMatching(/FROZEN · aim and fire/) });
    // The same frozen world with the look switched off (keystone.frozenlook=0, read live): the frame as it runs.
    await page.evaluate(() => { window.__game.feel.frozenLook = false; });
    await page.waitForFunction(() => window.__game.frozenGrade === 0, undefined, { timeout: 30_000, polling: 50 });
    const plain = await page.evaluate(() => window.__game.capture(true));
    expect((await label())?.on).toBe(false);
    const msg = JSON.stringify({ graded: sat(graded), plain: sat(plain) });
    expect(sat(plain), msg).toBeGreaterThan(0.1);
    expect(sat(graded), msg).toBeLessThan(0.7 * sat(plain));
    // Back on, then resumed: the label goes with the freeze.
    await page.evaluate(() => { window.__game.feel.frozenLook = true; });
    await page.waitForFunction(() => document.querySelector('.kg-frozen')?.classList.contains('on'), undefined, { timeout: 10_000, polling: 50 });
    expect(await page.evaluate(() => window.__game.freeze(false))).toBe(true);
    await page.waitForFunction(() => !document.querySelector('.kg-frozen')?.classList.contains('on'), undefined, { timeout: 10_000, polling: 50 });
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
  it('undo of a shot fired while frozen goes back to the frozen moment: frozen again, the freeze not spent', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 10, { timeout: 60_000, polling: 20 });
    expect(await page.evaluate(() => window.__game.freeze(true))).toBe(true);
    const frozen = await page.evaluate(() => window.__game.state());
    expect(await page.evaluate((s) => window.__game.fire(s), par)).toBe(true);
    expect(await page.evaluate(() => window.__game.freeze(true))).toBe(false); // spent
    await page.waitForFunction((n) => window.__game.stepIndex >= n, frozen.step + 5, { timeout: 60_000, polling: 20 });
    // Undo (from the checkpoint taken as the par shot went in): the frozen moment, exactly, still frozen.
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    expect(await page.evaluate(() => window.__game.undone!.mode)).toBe('checkpoint');
    expect(await page.evaluate(() => ({ frozen: window.__game.frozen, phase: window.__game.phase }))).toEqual({ frozen: true, phase: 'running' });
    expect(await page.evaluate(() => window.__game.state())).toEqual(frozen);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__game.stepIndex)).toBe(frozen.step);
    // The freeze is back: resuming is free, and freezing again works.
    expect(await page.evaluate(() => window.__game.freeze(false))).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, frozen.step + 3, { timeout: 60_000, polling: 20 });
    expect(await page.evaluate(() => window.__game.freeze(true))).toBe(true);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});

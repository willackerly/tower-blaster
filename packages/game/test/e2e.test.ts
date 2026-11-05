// The game page in headless Chromium (SwiftShader in CI): it loads a level,
// aims, plays L1's par line, shows the result card, and scores exactly what
// the headless driver scores for the same shots. It runs on Rapier, which is
// fast on a CPU; par-gpu-L*.test.ts play every level on the default GPU solver.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L1, runSession, type Shot } from '@tb/keystone';
import { withRules } from '../src/params.ts';
import { DEFAULT_FEEL } from '../src/pacing.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();

describe('game page', () => {
  it('plays the L1 par line to a result card that matches the headless score', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(40);
    // No pace juice unless asked for.
    expect(await page.evaluate(() => window.__game.feel)).toEqual(DEFAULT_FEEL);

    // Hovering the tower gives a reachable aim and preview beads. (L1's tower
    // is 1 m wide, and the centre ray runs down the 1 cm seam between its columns.)
    const aimed = await page.evaluate(() => window.__game.aim(0.05, 0));
    expect(aimed?.reachable).toBe(true);
    const stats = await page.evaluate(() => window.__game.capture());
    expect(stats!.bodyFraction).toBeGreaterThan(0.02);
    expect(stats!.distinctColors).toBeGreaterThan(50);

    await page.evaluate(() => { window.__game.fast = true; });
    // The handle never shows a result while it still says running: physics steps run between
    // frames, so whatever a step changes must reach the handle with it, not on the next frame.
    await page.evaluate(() => {
      const w = window as unknown as { __torn: string[] };
      w.__torn = [];
      const id = setInterval(() => {
        const g = window.__game;
        if (g.result !== null && g.phase === 'running') w.__torn.push(`step ${g.stepIndex}`);
        if (g.result !== null) clearInterval(id);
      }, 0);
    });
    // Pinned on the AVBD reference; this line also clears L1 on Rapier.
    const shots = L1.solutions!.par as Shot[];
    for (const shot of shots) {
      await ready(page);
      expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 100 });
    expect(await page.evaluate(() => document.querySelector('#result.show') !== null)).toBe(true);
    const result = await page.evaluate(() => ({ score: window.__game.result, counts: window.__game.counts, phase: window.__game.phase }));
    expect(await page.evaluate(() => (window as unknown as { __torn: string[] }).__torn)).toEqual([]);
    expect(result.phase).toBe('cleared');
    expect(result.counts.fired).toBe(1);
    expect(result.counts.contact).toBeGreaterThanOrEqual(1);
    expect(result.counts.crownDown).toBe(4);
    const card = await page.locator('#result').innerText();
    expect(card).toMatch(/PAR/);
    expect(card).toMatch(/Total/);

    // Same shots, headless, same engine: the same score to the point.
    const r = await runSession(new RapierEngine(), compileLevel(L1), shots);
    expect(result.score).toEqual(r.session.score);
    // And the page's own replay agrees, pose for pose.
    const live = await page.evaluate(() => window.__game.state());
    expect(live).toMatchObject({ step: r.steps, phase: 'cleared' });
    // The card showed as soon as the last crown was down, before the settle that scores it.
    const shownAt = await page.evaluate(() => window.__game.resultShownAt);
    const lastCrown = r.feedback.filter((f) => f.t === 'crownDown').at(-1)!.step;
    expect(shownAt).toBeGreaterThanOrEqual(lastCrown);
    expect(shownAt).toBeLessThan(r.feedback.find((f) => f.t === 'levelEnd')!.step);
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);
    // Rapier reports no limits (PhysicsEngine.health is optional); the GPU's are checked in par-gpu.ts.
    expect(await page.evaluate(() => window.__game.health())).toBeNull();

    // Keys typed into a form field (the viewer's panels share the page) are not game keys: N would load L2.
    await page.evaluate(() => { const i = document.createElement('input'); i.id = 'field'; document.body.append(i); });
    await page.locator('#field').press('n');
    await page.waitForTimeout(1500);
    expect(await page.evaluate(() => ({ level: window.__game.level, phase: window.__game.phase }))).toEqual({ level: 'L1', phase: 'cleared' });
    await page.evaluate(() => document.getElementById('field')!.remove());

    // Retry regrows the level and resets the rack.
    await page.keyboard.press('r');
    await ready(page);
    expect(await page.evaluate(() => ({ phase: window.__game.phase, strokes: window.__game.strokes, result: window.__game.result }))).toEqual({ phase: 'aiming', strokes: 0, result: null });
    expect(await page.locator('#result').isVisible()).toBe(false);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('an outcome level (L1 scored on what comes down) aims again after its clear, banks from the HUD, and scores as headless', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&keystone.scoring=outcome&offscreen=1&engine=rapier');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    await page.evaluate(() => { window.__game.fast = true; });
    const shots = L1.solutions!.par as Shot[];
    expect(await page.evaluate(() => window.__game.bank())).toBe(false); // nothing has settled yet
    expect(await page.evaluate((s) => window.__game.fire(s), shots[0]!)).toBe(true);
    // Every crown comes down, and the level stays open: three items are left to fire or bank.
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 1, undefined, { timeout: 120_000, polling: 100 });
    expect(await page.evaluate(() => ({ phase: window.__game.phase, result: window.__game.result, crowns: window.__game.counts.crownDown }))).toEqual({ phase: 'aiming', result: null, crowns: 4 });
    expect(await page.locator('#result').isVisible()).toBe(false);
    const hud = await page.locator('#hud').innerText();
    expect(hud).toMatch(/fell every crown ✓/);
    expect(hud).toMatch(/Down \d+%/);
    await page.locator('#hud button[data-act="bank"]').click();
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 30_000, polling: 100 });
    const card = await page.locator('#result').innerText();
    expect(card).toMatch(/Rack left/);
    expect(card).toMatch(/\d+% DOWN/);
    expect(card).not.toMatch(/par/i);
    const score = await page.evaluate(() => window.__game.result);
    expect(score!.lines).toContainEqual({ label: 'Rack left', value: 1200 });
    expect(score!.stars).toBe(1); // uncast: the objective's star only

    // (level, shots) is the whole session: headless, the shots run out and it banks there.
    const r = await runSession(new RapierEngine(), compileLevel(withRules(L1, { scoring: 'outcome' })), shots);
    expect(r.session.phase).toBe('cleared');
    expect(score).toEqual(r.session.score);
    const live = await page.evaluate(() => window.__game.state());
    expect(live).toMatchObject({ step: r.steps, phase: 'cleared', strokes: 1 });
    expect(await page.evaluate((s) => window.__game.replay(s), shots)).toEqual(live);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('?keystone.frames reaches the frame governor, and a capture draws whatever it decides', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&offscreen=1&engine=rapier&keystone.frames=half');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.frames)).toBe('half');
    // How many frames a headless rAF skips depends on the rate it runs at (under 110 Hz none, faster about
    // down to 60 drawn a second: frame-rate.ts), so only the bounds that hold at any rate are checked here.
    await page.waitForFunction(() => window.__game.draws.drawn > 10, undefined, { timeout: 60_000 });
    const draws = await page.evaluate(() => window.__game.draws);
    if (!draws.decimating) expect(draws.skipped).toBe(0);
    expect(draws.skipped).toBeLessThanOrEqual(4 * draws.drawn + 4); // at most 4 skipped per drawn up to 300 Hz
    const stats = await page.evaluate(() => window.__game.capture());
    expect(stats!.bodyFraction).toBeGreaterThan(0.02);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('refuses an unknown ?keystone.frames', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const page = await game.browser()!.newPage();
    await page.goto(game.url('/?level=L1&engine=rapier&offscreen=1&keystone.frames=60'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/keystone.frames must be one of all, half, auto: 60/);
    await page.close();
  });

  it('names the engines when ?engine= is unknown', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const page = await game.browser()!.newPage();
    await page.goto(game.url('/?level=L1&engine=physx&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown engine physx: use rapier or gpu/);
    await page.close();
  });

  it('shows a readable error for an unknown level', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const page = await game.browser()!.newPage();
    await page.goto(game.url('/?level=L99&offscreen=1'));
    await page.waitForFunction(() => window.__game?.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.locator('#error').innerText()).toMatch(/unknown level L99/);
    await page.close();
  });
});

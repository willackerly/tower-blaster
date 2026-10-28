// Keystone's rules in the viewer (rules=keystone) in headless Chromium: the
// game's loop plays the level, and a session ends in exactly the steps, score
// and poses runSession reaches headless with the game's driver options, so
// the viewer plays the game, not a likeness of it. Rapier for speed; the GPU
// case is e2e-keystone-gpu.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { driverOptions } from '@tb/game';
import { compileLevel, L1, L2, type LevelDef, runSession, type Shot, snapshotHash } from '@tb/keystone';
import { encodeLevelParam } from '../src/index.ts';
import { browser, useViewer } from './e2e-harness.ts';
import { openRules, play, ready } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;

describe('viewer under Keystone rules', () => {
  it('plays L1\'s par line to the score, steps and poses runSession reaches headless', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await openRules('/?level=L1&rules=keystone&engine=rapier&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    // The game's HUD in the viewer's panel; the viewer's help shows the game's keys.
    expect(await page.locator('#hud.kg-hud').innerText()).toMatch(new RegExp(L1.name));
    expect(await page.locator('#help').innerText()).toMatch(/Retry|retry/);
    expect(await page.evaluate(() => ({ engine: window.__viewer.game!.engine, feel: window.__viewer.game!.feel, bodies: window.__viewer.game!.bodies }))).toEqual({ engine: 'rapier', feel: { hitStop: false, slowMo: false }, bodies: 40 });

    const shots = L1.solutions!.par as Shot[];
    const live = await play(page, shots);
    const r = await runSession(new RapierEngine(), compileLevel(L1), shots, driverOptions('rapier'));
    expect(live.state).toEqual({ step: r.steps, phase: 'cleared', strokes: shots.length, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(live.score).toEqual(r.session.score);
    expect(await page.locator('.kg-result.show').innerText()).toMatch(/Total/);
    expect(await page.evaluate((s) => window.__viewer.game!.replay(s), shots)).toEqual(live.state);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('plays a level of your own as runSession does, and N stays on it', async (ctx) => {
    if (!browser) return ctx.skip();
    const mine: LevelDef = { ...structuredClone(L2), id: 'mine', name: 'Mine' };
    const o = await openRules(`/?level.def=${encodeLevelParam(mine)}&rules=keystone&engine=rapier&offscreen=1`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__viewer.game!.level)).toBe('mine');
    // The only level: N has nowhere to go (it would reload the level if it did).
    const loads = await page.evaluate(() => window.__viewer.game!.timing.loadMs);
    await page.keyboard.press('n');
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => ({ level: window.__viewer.game!.level, loadMs: window.__viewer.game!.timing.loadMs }))).toEqual({ level: 'mine', loadMs: loads });
    const shots = L2.solutions!.par as Shot[];
    const live = await play(page, shots);
    const r = await runSession(new RapierEngine(), compileLevel(mine), shots, driverOptions('rapier'));
    expect(live.state).toMatchObject({ step: r.steps, phase: r.session.phase, hash: snapshotHash(r.snapshot) });
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the panel switches a level to Keystone rules, the URL saying so', async (ctx) => {
    if (!browser) return ctx.skip();
    // Tall enough that the panel's rules fields are clear of the presets column.
    const o = await openRules('/?level=L1&engine=rapier&scale=0.5&offscreen=1', { width: 1280, height: 1000 });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__viewer.game)).toBeNull();
    await page.evaluate(() => { (document.getElementById('controls') as HTMLDetailsElement).open = true; });
    await page.locator('#scene-form select[name=rules]').selectOption('keystone');
    expect(await page.locator('#scene-form .world').isHidden()).toBe(true);
    await page.locator('#scene-form input[name=slowmo]').check();
    expect(await page.locator('#scene-form .out').innerText()).toMatch(/by Keystone's rules on Rapier/);
    await page.locator('#scene-form button[type=submit]').click();
    await page.waitForURL(/rules=keystone/, { timeout: MINUTES });
    await page.waitForFunction(() => window.__viewer?.game?.status === 'running', undefined, { timeout: MINUTES });
    expect(new URL(page.url()).search).toBe('?level=L1&engine=rapier&offscreen=1&rules=keystone&keystone.slowmo=1');
    expect(await page.evaluate(() => window.__viewer.game!.feel)).toEqual({ hitStop: false, slowMo: true });
    expect(errors).toEqual([]);
    await page.close();
  });
});

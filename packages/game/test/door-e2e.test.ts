// The front door on the game page (roadmap G7), Rapier in headless Chromium:
// a bare URL opens the door over B1 loading behind it; Play then the pre-aimed
// Fire button bring the wall down (the first-minute promise, measured in sim
// time here and in wall time on a real GPU: TB_CHANNEL=chrome with engine gpu);
// the door holds the game's keys; Esc and Menu bring it back; settings are
// stored and replace their URL key; progress shows on the cards after a reload.
import { describe, expect, it } from 'vitest';
import { B1, L1, type Shot, writeShots } from '@tb/keystone';
import { gamePage } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
/** What counts as the first collapse: a tenth of the structure's drop potential released (D: about 100 of B1's 1,000 blocks brought to the ground). */
const FIRST_COLLAPSE = 0.1;
/** The promise: within 20 s; at 60 steps a second that is this many steps of sim time. */
const PROMISE_S = 20;
const real = Boolean(process.env.TB_CHANNEL);
const engine = real ? 'gpu' : 'rapier';

describe('front door', () => {
  it('a fresh visit: door over B1, Play, Fire, and the wall comes down within the promise', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?engine=${engine}&offscreen=1`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__door.open)).toBe(true);
    expect(await page.locator('.kg-door .card').count()).toBe(3);
    expect(await page.locator('.kg-door .play').innerText()).toBe('Play · Long Wall');
    // The door holds the game's keys: N would load B2.
    await page.keyboard.press('n');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__game.level)).toBe('B1');

    await page.locator('.kg-door .play').click();
    expect(await page.evaluate(() => window.__door.open)).toBe(false);
    await page.waitForFunction(() => window.__game.ready, undefined, { timeout: 5 * MINUTES, polling: 250 });
    const start = await page.evaluate(() => window.__game.stepIndex);
    await page.locator('.kg-hud button.opener').click();
    await page.waitForFunction((d) => window.__game.collapse >= d || window.__game.phase === 'aiming' && window.__game.strokes === 1, FIRST_COLLAPSE, { timeout: 10 * MINUTES, polling: 100 });
    const at = await page.evaluate(() => ({ wall: performance.now(), step: window.__game.stepIndex, collapse: window.__game.collapse, strokes: window.__game.strokes }));
    const simS = (at.step - start) / 60;
    console.log(`first collapse on ${engine}: D ${at.collapse.toFixed(3)} after ${simS.toFixed(1)} s of sim, ${(at.wall / 1000).toFixed(1)} s of wall time since navigation${real ? '' : ' (software: not a performance result)'}`);
    expect(at.strokes).toBe(1);
    expect(at.collapse).toBeGreaterThanOrEqual(FIRST_COLLAPSE);
    expect(simS).toBeLessThan(PROMISE_S);
    if (real) expect(at.wall).toBeLessThan(PROMISE_S * 1000);
    // The opener is offered once: gone after the first shot.
    expect(await page.locator('.kg-hud button.opener').count()).toBe(0);
    expect(errors).toEqual([]);
    await page.close();
  }, 15 * MINUTES);

  it('Esc and Menu toggle it; a named level opens without it; door=1 shows it anyway', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__door.open)).toBe(false);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__door.open)).toBe(true);
    // The chamber series: L1 to L5, par targets.
    expect(await page.locator('.kg-door .card .id').allInnerTexts()).toEqual(['L1', 'L2', 'L3', 'L4', 'L5']);
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__door.open)).toBe(false);
    await page.locator('#menu').click();
    expect(await page.evaluate(() => window.__door.open)).toBe(true);
    // Picking a card loads that level.
    await page.locator('.kg-door .card').nth(1).click();
    await page.waitForFunction(() => window.__game.level === 'L2', undefined, { timeout: MINUTES });
    expect(errors).toEqual([]);
    await page.close();
    const o2 = await game.open('/?level=L1&engine=rapier&offscreen=1&door=1');
    expect(await o2!.page.evaluate(() => window.__door.open)).toBe(true);
    await o2!.page.close();
    const o3 = await game.open('/?engine=rapier&offscreen=1&door=0');
    expect(await o3!.page.evaluate(() => window.__door.open)).toBe(false);
    await o3!.page.close();
  }, 5 * MINUTES);

  it('settings are stored, applied and replace their URL key; progress shows on the card after a reload', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&look=candy&keystone.shake=0&keystone.shots=${writeShots(L1.solutions!.par as Shot[])}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const stars = await page.evaluate(() => window.__game.result!.stars);
    await page.keyboard.press('Escape');
    await page.locator('.kg-door [data-act="look"][data-arg="real"]').click();
    await page.locator('.kg-door [data-act="sound"]').click();
    await page.locator('.kg-door [data-act="sharp"][data-arg="1"]').click();
    // Camera: still by default; Dynamic turns the follow and the shake on at once, over the URL's keystone.shake=0, which goes.
    expect(await page.locator('.kg-door [data-act="camera"].on').innerText()).toBe('Still');
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: false, shake: false });
    await page.locator('.kg-door [data-act="camera"][data-arg="dynamic"]').click();
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: true, shake: true });
    expect(new URLSearchParams(await page.evaluate(() => location.search)).has('keystone.shake')).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tb.settings.v1')!))).toEqual({ sound: false, look: 'real', sharp: 1, camera: 'dynamic' });
    expect(await page.evaluate(() => window.__game.maxDpr)).toBe(1);
    expect(new URLSearchParams(await page.evaluate(() => location.search)).has('look')).toBe(false);

    await page.goto(game.url('/?level=L1&engine=rapier&offscreen=1&door=1'));
    await page.waitForFunction(() => window.__game?.status === 'running', undefined, { timeout: MINUTES });
    expect(await page.locator('.kg-door [data-act="look"].on').innerText()).toBe('Photoreal');
    expect(await page.locator('.kg-door [data-act="sound"]').innerText()).toBe('Off');
    expect(await page.locator('.kg-door [data-act="camera"].on').innerText()).toBe('Dynamic');
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: true, shake: true });
    const card = await page.locator('.kg-door .card').first().innerText();
    expect(card).toContain('1 play');
    expect(await page.locator('.kg-door .card').first().locator('li.got').count()).toBe(stars);
    // Forget my progress takes two clicks.
    await page.locator('.kg-door [data-act="reset"]').click();
    expect(await page.locator('.kg-door .card').first().innerText()).toContain('1 play');
    await page.locator('.kg-door [data-act="reset"]').click();
    expect(await page.locator('.kg-door .card').first().innerText()).toContain('Not played yet');
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

// B1's opener is its ace line's first shot.
it('B1 has an opener to offer', () => { expect(B1.solutions?.ace?.[0]).toBeDefined(); });

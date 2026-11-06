// The front door on the game page (roadmap G7), Rapier in headless Chromium:
// a bare URL opens the door over B1 loading behind it; Play then the pre-aimed
// Fire button bring the wall down (the first-minute promise, measured in sim
// time here and in wall time on a real GPU: TB_CHANNEL=chrome with engine gpu);
// the door holds the game's keys; Esc and Menu bring it back; settings are
// stored and replace their URL key; progress shows on the cards after a reload;
// every series is listed, and a trial picked from the Trials toggle loads in
// place (no page load), with N and P walking the trials only.
import { describe, expect, it } from 'vitest';
import { B1, L1, type Shot, TRIAL_LEVELS, writeShots } from '@tb/keystone';
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
    // Every rated level (B1-B3, L1-L5, U1-U3); the trials wait behind their toggle.
    expect(await page.locator('.kg-door .card:not(.duel)').count()).toBe(11);
    expect(await page.locator('.kg-door [data-act="trials"]').innerText()).toBe(`TRIALS · UNRATED (${TRIAL_LEVELS.length}) ▸`);
    expect(await page.locator('.kg-door .card.duel').count()).toBe(2);
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
    // Every series, the slice first: B1 to B3, L1 to L5, U1 to U3; L1 is the loaded one.
    expect(await page.locator('.kg-door .card:not(.duel) .id').allInnerTexts()).toEqual(['B1', 'B2', 'B3', 'L1', 'L2', 'L3', 'L4', 'L5', 'U1', 'U2', 'U3']);
    expect(await page.locator('.kg-door .card.current .id').innerText()).toBe('L1');
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => window.__door.open)).toBe(false);
    await page.locator('#menu').click();
    expect(await page.evaluate(() => window.__door.open)).toBe(true);
    // Picking a card loads that level.
    await page.locator('.kg-door .card[aria-label^="L2 "]').click();
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
    // The settings sit behind Advanced settings, closed until it is clicked.
    expect(await page.locator('.kg-door [data-act="look"]').count()).toBe(0);
    await page.locator('.kg-door [data-act="advanced"]').click();
    await page.locator('.kg-door [data-act="look"][data-arg="real"]').click();
    await page.locator('.kg-door [data-act="sound"]').click();
    await page.locator('.kg-door [data-act="sharp"][data-arg="1"]').click();
    // Camera: still by default; Dynamic turns the follow and the shake on at once, over the URL's keystone.shake=0, which goes.
    expect(await page.locator('.kg-door [data-act="camera"].on').innerText()).toBe('Still');
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: false, shake: false });
    await page.locator('.kg-door [data-act="camera"][data-arg="dynamic"]').click();
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: true, shake: true });
    expect(new URLSearchParams(await page.evaluate(() => location.search)).has('keystone.shake')).toBe(false);
    // Rapid fire: on by default; Off applies to the game at once.
    expect(await page.locator('.kg-door [data-act="rapid"].on').innerText()).toBe('On');
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(true);
    await page.locator('.kg-door [data-act="rapid"][data-arg="off"]').click();
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(false);
    // Duel turns: the turn view on by default; Leave it applies to the game at once.
    expect(await page.locator('.kg-door [data-act="duelview"].on').innerText()).toBe('Turn the view');
    expect(await page.evaluate(() => window.__game.feel.turnView)).toBe(true);
    await page.locator('.kg-door [data-act="duelview"][data-arg="off"]').click();
    expect(await page.evaluate(() => window.__game.feel.turnView)).toBe(false);
    // Launch height: High by default; Level's applies to the game at once (the launcher moves to the level's own).
    expect(await page.locator('.kg-door [data-act="launch"].on').innerText()).toBe('High');
    expect(await page.evaluate(() => window.__game.feel.launch)).toBe('high');
    await page.locator('.kg-door [data-act="launch"][data-arg="level"]').click();
    expect(await page.evaluate(() => window.__game.feel.launch)).toBe('level');
    // Stone marks: carved by default (L1's four crowns carry the crosshair); Off clears every stone at once, Carved recarves them.
    expect(await page.locator('.kg-door [data-act="marks"].on').innerText()).toBe('Carved');
    const hits = () => page.evaluate(() => window.__game.marks().filter((m) => m === 1).length);
    expect(await hits()).toBe(4);
    await page.locator('.kg-door [data-act="marks"][data-arg="off"]').click();
    expect(await page.evaluate(() => window.__game.feel.marks)).toBe(false);
    expect(await page.evaluate(() => window.__game.marks().some((m) => m !== 0))).toBe(false);
    await page.locator('.kg-door [data-act="marks"][data-arg="on"]').click();
    expect(await hits()).toBe(4);
    await page.locator('.kg-door [data-act="marks"][data-arg="off"]').click();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tb.settings.v1')!))).toEqual({ sound: false, look: 'real', sharp: 1, camera: 'dynamic', rapid: false, duelView: false, launch: 'level', marks: false, view: 'goals', impact: true, xray: 'off', quality: 'auto' });
    expect(await page.evaluate(() => window.__game.maxDpr)).toBe(1);
    expect(new URLSearchParams(await page.evaluate(() => location.search)).has('look')).toBe(false);

    await page.goto(game.url('/?level=L1&engine=rapier&offscreen=1&door=1'));
    await page.waitForFunction(() => window.__game?.status === 'running', undefined, { timeout: MINUTES });
    await page.locator('.kg-door [data-act="advanced"]').click();
    expect(await page.locator('.kg-door [data-act="look"].on').innerText()).toBe('Photoreal');
    expect(await page.locator('.kg-door [data-act="sound"]').innerText()).toBe('Off');
    expect(await page.locator('.kg-door [data-act="camera"].on').innerText()).toBe('Dynamic');
    expect(await page.evaluate(() => window.__game.feel)).toMatchObject({ follow: true, shake: true, rapid: false, turnView: false });
    expect(await page.locator('.kg-door [data-act="duelview"].on').innerText()).toBe('Leave it');
    expect(await page.locator('.kg-door [data-act="rapid"].on').innerText()).toBe('Off');
    // Stored Off: the level loads with plain stones.
    expect(await page.locator('.kg-door [data-act="marks"].on').innerText()).toBe('Off');
    expect(await page.evaluate(() => [window.__game.feel.marks, window.__game.marks().some((m) => m !== 0)])).toEqual([false, false]);
    const l1 = page.locator('.kg-door .card[aria-label^="L1 "]');
    expect(await l1.innerText()).toContain('1 play');
    expect(await l1.locator('li.got').count()).toBe(stars);
    // Forget my progress takes two clicks.
    await page.locator('.kg-door [data-act="reset"]').click();
    expect(await l1.innerText()).toContain('1 play');
    await page.locator('.kg-door [data-act="reset"]').click();
    expect(await l1.innerText()).toContain('Not played yet');
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);
});

describe('trials on the door', () => {
  it('the Trials toggle lists every trial; a pick loads in place; N and P stay inside the trials and the chamber stops at L5', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L5&engine=rapier&offscreen=1&door=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game?.status === 'running', undefined, { timeout: MINUTES });
    // A marker on the window: gone if anything reloads the page.
    await page.evaluate(() => { (window as unknown as { marker: number }).marker = 1; });
    expect(await page.locator('.kg-door .card.trial').count()).toBe(0);
    await page.locator('.kg-door [data-act="trials"]').click();
    expect(await page.locator('.kg-door .card.trial').count()).toBe(TRIAL_LEVELS.length);
    expect(await page.locator('.kg-door .card.trial .id').allInnerTexts()).toEqual(TRIAL_LEVELS.map((d) => d.id));
    // Play still offers the first rated level, not a trial.
    expect(await page.locator('.kg-door .play').innerText()).toBe(`Play · ${B1.name}`);
    await page.locator('.kg-door .card[aria-label^="T-X1 "]').click();
    await page.waitForFunction(() => window.__game.level === 'T-X1' && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    expect(new URLSearchParams(await page.evaluate(() => location.search)).get('level')).toBe('T-X1');
    // The trial is outcome-scored with its objective (the last domino down) and nothing cast.
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    await page.keyboard.press('n');
    await page.waitForFunction(() => window.__game.level === 'T-X2' && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    await page.keyboard.press('p');
    await page.waitForFunction(() => window.__game.level === 'T-X1' && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    // The first trial has no P: it stays put rather than running back into Undercut's levels.
    await page.evaluate(() => window.__game.load('T-S1'));
    await page.waitForFunction(() => window.__game.level === 'T-S1' && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    await page.keyboard.press('p');
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__game.level)).toBe('T-S1');
    // L5, the chamber's last, has no N into Undercut's.
    await page.evaluate(() => window.__game.load('L5'));
    await page.waitForFunction(() => window.__game.level === 'L5' && window.__game.ready, undefined, { timeout: MINUTES, polling: 100 });
    await page.keyboard.press('n');
    await page.waitForTimeout(1000);
    expect(await page.evaluate(() => window.__game.level)).toBe('L5');
    expect(await page.evaluate(() => (window as unknown as { marker?: number }).marker)).toBe(1);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('a URL naming a trial opens it with the Trials toggle open', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=t-x3b&engine=rapier&offscreen=1&door=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game?.status === 'running', undefined, { timeout: MINUTES });
    expect(await page.evaluate(() => window.__game.level)).toBe('T-X3B');
    expect(await page.locator('.kg-door .card.trial').count()).toBe(TRIAL_LEVELS.length);
    expect(await page.locator('.kg-door .card.current .id').innerText()).toBe('T-X3B');
    expect(errors).toEqual([]);
    await page.close();
  }, 3 * MINUTES);
});

// B1's opener is its ace line's first shot.
it('B1 has an opener to offer', () => { expect(B1.solutions?.ace?.[0]).toBeDefined(); });

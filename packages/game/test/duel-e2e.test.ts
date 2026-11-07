// The Siege Table on the game page (?duel=D1, docs/game/siege-table.md): the turn controller refuses a
// shot from the wrong side or out of turn, passes the turn at each settle, runs the duel's level to a
// result card, and Rematch starts the other side first. Eight sideways misses on Rapier: nothing is hit,
// so both keeps stand alike and the duel is a draw. The aids (duel-view.ts): each turn opens over the shoulder
// of its side, the camera swinging there when the turn passes (keystone.turnview=0 leaves it) under a hand-over
// card (keystone.handoff=0: a banner), the side's arc is dotted on the ground, and off the side the HUD and a
// refused shot say which way to drag. Nothing shows empty, and a duel cannot be banked before it is decided
// (PT5, agent playtest 1). Headless Chromium.
import { describe, expect, it } from 'vitest';
import { compileLevel, D1, duelLevel, EAST_ARC, inArc, type Shot, WEST_ARC } from '@tb/keystone';
import type { Page } from 'playwright';
import { azFromYaw } from '../src/aim.ts';
import { duelEndView, DUEL_YAW_OFFSET } from '../src/duel-view.ts';
import { gamePage, ready } from './page.ts';

/** Turn view azimuths: DUEL_YAW_OFFSET round from the middle of each side's arc (duel-view.ts duelView). */
const offMiddle = (az: number, middle: number) => Math.abs(((az - middle + 1080) % 720) - 360) / 2;

/** Overlays that show but say nothing (PT5: an empty dark bar over the Heraldry result): class names, none expected. */
const emptyShown = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.kg-banner, .kg-result, .duel-handoff, .duel-float')]
  .filter((e) => { const cs = getComputedStyle(e), r = e.getBoundingClientRect(); return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.01 && r.width > 0 && r.height > 0 && !e.textContent!.trim(); })
  .map((e) => e.className));

const game = gamePage();

/** A shot from azimuth az turned 90 degrees off the lot centre at low power: it lands beside the launcher, clear of both keeps. */
const miss = (az: number, ammo: Shot['ammo'] = 'cannonball'): Shot => ({ ammo, az, y: 4, yaw: 900, pitch: 0, power: 30 } as Shot);
const WEST = 360, EAST = 0;

declare global { interface Window { __views?: { yaw: number; turning: boolean }[] } }

describe('game page, Siege Table', () => {
  it('takes turns by side, refuses the wrong side, ends in a draw on eight misses, and Rematch starts Blue', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D1&engine=rapier&look=candy&offscreen=1&progress=off');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => [window.__game.level, window.__game.duel?.turn, window.__game.duel?.first])).toEqual(['D1', 0, 0]);
    expect(await page.evaluate(() => document.querySelector('.kg-hud')!.textContent)).toMatch(/Gold to fire, from behind the gold keep/);
    // PT34: the goal from the first frame, and no undo or restart on offer in a hot-seat match.
    expect(await page.evaluate(() => document.querySelector('.kg-hud .duel-goal')?.textContent)).toBe("Topple Blue's ⌖ king · protect your ⛨ king");
    expect(await page.evaluate(() => document.querySelector('#help')!.textContent)).not.toMatch(/undo|restart/i);
    // The turn view: the duel opens over Gold's shoulder (DUEL_YAW_OFFSET off the middle of its side), its arc dotted on the ground, and no cue.
    await page.waitForFunction(() => window.__game.view.arcBeads > 0, undefined, { timeout: 30_000 });
    const opening = await page.evaluate(() => window.__game.view);
    expect(offMiddle(azFromYaw(opening.yaw), WEST)).toBe(DUEL_YAW_OFFSET);
    expect(inArc(azFromYaw(opening.yaw), WEST_ARC)).toBe(true);
    expect(opening).toMatchObject({ turning: false, cue: null });
    // No hand-over card before the first shot: the players chose to start.
    expect(await page.evaluate(() => window.__game.handoff)).toBe(false);
    // Every frame's view, to see the swing between turns.
    await page.evaluate(() => {
      const views: { yaw: number; turning: boolean }[] = window.__views = [];
      const f = () => { views.push({ yaw: window.__game.view.yaw, turning: window.__game.view.turning }); requestAnimationFrame(f); };
      requestAnimationFrame(f);
    });
    // Gold may not fire from Blue's side, nor a marble it does not have.
    expect(await page.evaluate((s) => window.__game.fire(s), miss(EAST))).toBe(false);
    expect(await page.evaluate((s) => window.__game.fire(s), { ...miss(WEST), ammo: 'marble' } as Shot)).toBe(false);
    // One shot per turn: rapid fire is off in a duel, and a second click while a shot runs is refused.
    expect(await page.evaluate(() => window.__game.feel.rapid)).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    const order: number[] = [];
    for (let k = 0; k < 8; k++) {
      await ready(page, 120_000);
      const turn = await page.evaluate(() => window.__game.duel!.turn);
      order.push(turn);
      // Each turn's view comes to rest over its own side's shoulder, with no cue.
      await page.waitForFunction(() => !window.__game.view.turning, undefined, { timeout: 60_000, polling: 100 });
      const v = await page.evaluate(() => window.__game.view);
      expect(offMiddle(azFromYaw(v.yaw), turn === 0 ? WEST : EAST)).toBe(DUEL_YAW_OFFSET);
      expect(inArc(azFromYaw(v.yaw), turn === 0 ? WEST_ARC : EAST_ARC)).toBe(true);
      expect(v.cue).toBeNull();
      expect(v.arcBeads).toBeGreaterThan(0);
      // After the first turn the hand-over card names the next side; nothing shows empty.
      if (k > 0) {
        expect(await page.evaluate(() => [window.__game.handoff, document.querySelector('.duel-handoff.show')?.textContent])).toEqual([true, expect.stringMatching(turn === 0 ? /Gold's turn/ : /Blue's turn/)]);
        expect(await emptyShown(page)).toEqual([]);
        // PT34: every hand-over says what the last shot did, a miss too.
        expect(await page.evaluate(() => document.querySelector('.duel-handoff.show .tally')?.textContent)).toMatch(turn === 0 ? /^Blue's shot: 0 gold blocks down · Gold's king stands$/ : /^Gold's shot: 0 blue blocks down · Blue's king stands$/);
        // The second turn's card is tapped away (a tap never fires); later ones go when the shot is fired.
        if (k === 1) {
          // PT34: on a touch screen the card is opaque, so the rack does not show through it.
          expect(await page.evaluate(() => { document.body.classList.add('kg-touch'); const bg = getComputedStyle(document.querySelector('.duel-handoff .band')!).backgroundColor; document.body.classList.remove('kg-touch'); return bg; })).toBe('rgb(20, 24, 33)');
          await page.click('.duel-handoff');
          expect(await page.evaluate(() => [window.__game.handoff, window.__game.strokes])).toEqual([false, 1]);
        }
      }
      // PT34: R mid-duel restarts nothing (it is Rematch once the duel is over).
      if (k === 2) {
        await page.keyboard.press('r');
        expect(await page.evaluate(() => [window.__game.level, window.__game.strokes, window.__game.duel!.turn])).toEqual(['D1', 2, turn]);
      }
      const ammo = k >= 6 ? 'w-grenade' : 'cannonball';
      const shot = miss(turn === 0 ? WEST : EAST, ammo);
      expect(await page.evaluate((s) => [window.__game.fire(s), window.__game.fire(s)], shot)).toEqual([true, false]);
    }
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 120_000, polling: 250 });
    expect(order).toEqual([0, 1, 0, 1, 0, 1, 0, 1]);
    // Refereed: the round ends with no solo tally (PT16); the duel's own result is the outcome.
    expect(await page.evaluate(() => window.__game.result)).toMatchObject({ refereed: true, lines: [], total: 0, stars: 0, stamp: 'DUEL' });
    // It swung, not cut: frames between the turns drew the camera on its way, at yaws between the two sides'.
    const views = await page.evaluate(() => window.__views!);
    const between = views.filter((x) => x.turning && Math.abs(Math.cos(x.yaw)) > 0.05);
    expect(between.length).toBeGreaterThan(7 * 2);
    // Over: no arc, no cue.
    await page.waitForFunction(() => window.__game.view.arcBeads === 0, undefined, { timeout: 30_000 });
    const d = await page.evaluate(() => window.__game.duel!);
    expect(d).toMatchObject({ over: true, winner: null, why: 'both keeps stand alike', log: order });
    expect(d.sides.map((s) => [s.name, s.share, s.shotsLeft])).toEqual([['Gold', 1, 0], ['Blue', 1, 0]]);
    expect(await page.evaluate(() => document.querySelector('.kg-result')!.textContent)).toMatch(/A draw[^]*Blue's last shot: 0 gold blocks down/);
    // PT34: the turn view ends on the whole table, both keeps (duel-view.ts duelEndView).
    await page.waitForFunction(() => !window.__game.view.turning, undefined, { timeout: 30_000, polling: 100 });
    const end = await page.evaluate(() => window.__game.view);
    const want = duelEndView(compileLevel(duelLevel(D1, 0)), 640 / 400); // offscreen=1 draws 640 x 400
    expect([end.yaw, end.pitch, end.distance]).toEqual([want.yaw, want.pitch, want.distance].map((x) => expect.closeTo(x, 6)));
    expect(await page.evaluate(() => window.__game.handoff)).toBe(false);
    expect(await emptyShown(page)).toEqual([]);
    // Custom (a duel has no stars): nothing recorded.
    expect(await page.evaluate(() => Object.keys(window.__progress.progress.levels))).toEqual([]);

    await page.click('.kg-result [data-act="rematch"]');
    await page.waitForFunction(() => window.__game.level === 'D1-2', undefined, { timeout: 60_000 });
    await ready(page);
    expect(await page.evaluate(() => [window.__game.duel!.turn, window.__game.duel!.first, window.__game.strokes])).toEqual([1, 1, 0]);
    expect(await page.evaluate(() => new URLSearchParams(location.search).get('duel'))).toBe(D1.id);
    // The rematch opens on Blue's side.
    expect(offMiddle(azFromYaw(await page.evaluate(() => window.__game.view.yaw)), EAST)).toBe(DUEL_YAW_OFFSET);
    expect(errors).toEqual([]);
    await page.close();
  }, 400_000);

  // PT5: a bank mid-duel (the agent playtest's harness banked after four turns) showed an empty result card. A duel ends by its referee only;
  // Heraldry floats each shot's points where it landed, and a middle click lands on the tower.
  it('Heraldry: a middle click hits the tower and floats its points; no bank mid-duel, nothing shown empty', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D2&engine=rapier&look=candy&offscreen=1&progress=off&keystone.handoff=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.handoff)).toBe(false);
    await page.evaluate(() => { window.__game.fast = true; });
    const aimed = await page.evaluate(() => window.__game.aim(0, -0.05));
    expect(aimed?.reachable).toBe(true);
    expect(await page.evaluate((s) => window.__game.fire(s), aimed!.shot)).toBe(true);
    await page.waitForFunction(() => window.__game.duel!.turn === 1 && window.__game.ready, undefined, { timeout: 120_000, polling: 250 });
    const d = await page.evaluate(() => window.__game.duel!);
    expect(d.over).toBe(false);
    // The shot brought blocks down, and the float said how many of whose (duel-hud.ts scoreFloatHtml).
    expect(d.sides[0]!.share + d.sides[1]!.share).toBeLessThan(2);
    expect(await page.evaluate(() => window.__game.scoreFloat)).toMatch(/^(\+\d+ blue)?\s?(−\d+ gold)?\s?= [+−]?\d+$/);
    // Without the card, a banner says whose turn.
    expect(await page.evaluate(() => [window.__game.handoff, document.querySelector('#banner')!.textContent])).toEqual([false, "Blue's turn"]);
    // No bank mid-duel: B, the HUD and the handle all refuse it, and no card shows.
    expect(await page.evaluate(() => window.__game.bank())).toBe(false);
    expect(await page.evaluate(() => [window.__game.result, document.querySelector('.kg-result.show')])).toEqual([null, null]);
    expect(await emptyShown(page)).toEqual([]);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);

  it('keystone.turnview=0 leaves the camera to the players; off the side the HUD and a refused shot say which way to drag', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?duel=D1&engine=rapier&look=candy&offscreen=1&progress=off&keystone.turnview=0&keystone.arcs=0');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => [window.__game.feel.turnView, window.__game.feel.arcs])).toEqual([false, false]);
    // The level's own opening view (view.ts viewOf: from 36 deg yaw, azimuth 108) is on Blue's side, not Gold's: the short way to the west (azimuth 200 on) is to drag right.
    const v0 = await page.evaluate(() => window.__game.view);
    expect(azFromYaw(v0.yaw)).toBe(108);
    await page.waitForFunction(() => window.__game.view.cue !== null, undefined, { timeout: 30_000 });
    expect(await page.evaluate(() => [window.__game.view.cue, window.__game.view.arcBeads])).toEqual(['right', 0]);
    expect(await page.evaluate(() => document.querySelector('.kg-hud .turn-cue')!.textContent)).toBe("Drag right ▸Two fingers right ▸ to turn to Gold's side");
    // A shot from due east is refused, its banner saying the way (either way is as short from there: right, by turnCue's tie rule).
    expect(await page.evaluate((s) => window.__game.fire(s), miss(EAST))).toBe(false);
    expect(await page.evaluate(() => document.querySelector('#banner')!.textContent)).toBe("Drag right ▸ to turn to Gold's side");
    // Gold fires from its own side; once the shot settles Blue is to fire and the camera has not moved.
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), miss(WEST))).toBe(true);
    await page.waitForFunction(() => window.__game.duel!.turn === 1 && window.__game.ready, undefined, { timeout: 120_000, polling: 250 });
    const v1 = await page.evaluate(() => window.__game.view);
    expect(v1).toMatchObject({ yaw: v0.yaw, pitch: v0.pitch, distance: v0.distance, turning: false, cue: null });
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});

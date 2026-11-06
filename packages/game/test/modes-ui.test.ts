// The Lot Sheet and Siege Table on the page: HUD and result-card formatting, the door's
// Two players section, URL keys and progress keeping goals. Pure functions, no browser.
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@tb/engine-api';
import { compileLevel, D1, D2, Duel, duelLevel, DUELS, outcomeScore, type Shot } from '@tb/keystone';
import { doorDuels, doorHtml, doorOnLoad, duelsOnDoor } from '../src/door.ts';
import { duelHudHtml, duelResultHtml, sideOf } from '../src/duel-hud.ts';
import { hudHtml, rackChips } from '../src/hud.ts';
import { goalsHudHtml, goalsMode, goalsResultHtml } from '../src/lot-hud.ts';
import { duelOf, parseGameParams } from '../src/params.ts';
import { emptyProgress, parseProgress, recordPlay } from '../src/progress.ts';
import { DEFAULT_SETTINGS } from '../src/settings.ts';

const q = (s: string) => new URLSearchParams(s);

describe('lot sheet on the page', () => {
  const goals = [{ id: 'ace', text: 'All crowns with the <first> shot', met: true }, { id: 'tidy', text: 'Tidy', met: false, before: true }, { id: 'x', text: 'X', met: false }];
  it('keystone.goals: shown by default, all, off; anything else refused', () => {
    expect(goalsMode(q(''))).toBe('shown');
    expect(goalsMode(q('keystone.goals=all'))).toBe('all');
    expect(goalsMode(q('keystone.goals=off'))).toBe('off');
    expect(() => goalsMode(q('keystone.goals=1'))).toThrow(/keystone.goals must be/);
  });
  it('the HUD lists each goal ticked while met (so far), marks one met before, and escapes text', () => {
    const html = goalsHudHtml(goals);
    expect(html).toMatch(/Lot sheet/);
    expect(html).toMatch(/1\/3 so far/);
    expect(html).toMatch(/☑<\/span>All crowns with the &#60;first&#62; shot/);
    expect(html).toMatch(/class=" before"[^>]*><span class="tick">☒/);
    expect(goalsHudHtml([])).toBe('');
  });
  it('the result card counts the goals met, marks first-time ones new, and shows the grade when the level has grades', () => {
    const html = goalsResultHtml(goals, 'B', true);
    expect(html).toMatch(/1 \/ 3/);
    expect(html).toMatch(/shot<\/span>|shot <b class="new">new<\/b>/);
    expect(html).toMatch(/class="g g-B"[^>]*>B</);
    expect(goalsResultHtml(goals, null, false)).not.toMatch(/Grade/);
    expect(goalsResultHtml([], null, true)).toMatch(/g-none[^>]*>–/);
    expect(goalsResultHtml([], null, false)).toBe('');
  });
  it('progress keeps every goal met on a hash, across plays and whichever play was best, and drops them with the hash', () => {
    const score = (stars: 0 | 1 | 2 | 3) => outcomeScore({ met: stars > 0, collapse: 0.5, leverage: 1, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0 }, { metric: 'collapse', t2: 0.4, t3: 0.9 });
    let p = recordPlay(emptyProgress(), 'L1', 'h', score(2), new Date(0), ['ace']);
    p = recordPlay(p, 'L1', 'h', score(1), new Date(1), ['tidy', 'ace']);
    expect(p.levels.L1).toMatchObject({ plays: 2, goals: ['ace', 'tidy'] });
    p = recordPlay(p, 'L1', 'h2', score(1), new Date(2));
    expect(p.levels.L1!.goals).toBeUndefined();
    expect(parseProgress(JSON.stringify({ version: 1, levels: { L1: { ...p.levels.L1, goals: [1] } } })).levels.L1).toBeUndefined();
    expect(parseProgress(JSON.stringify({ version: 1, levels: { L1: { ...p.levels.L1, goals: ['a'] } } })).levels.L1!.goals).toEqual(['a']);
  });
});

describe('siege table on the page', () => {
  const shotAt = (az: number): Shot => ({ ammo: 'cannonball', az, y: 8, yaw: 0, pitch: 100, power: 100 });
  const fresh = () => {
    const c = compileLevel(duelLevel(D1)), s = emptySnapshot(c.meta.n);
    s.pos.set(c.meta.home);
    for (let i = 0; i < c.meta.n; i++) s.rot[4 * i + 3] = 1;
    return { c, s, d: new Duel(D1, c) };
  };

  it('?duel picks a table by id or ruleset and checks a line against the duel level; unknown refused', () => {
    expect(duelOf(null)).toBeNull();
    expect(duelOf('d1')).toBe(D1);
    expect(duelOf('heraldry')).toBe(D2);
    expect(() => duelOf('chess')).toThrow(/unknown duel chess; known: D1 \(keeps\), D2 \(heraldry\)/);
    expect(parseGameParams(q('duel=D1')).duel).toBe(D1);
    expect(() => parseGameParams(q('duel=D1&keystone.shots=marble.360.8.0.100.100'))).toThrow(/fires 1 marble but D1's rack holds 0/);
    expect(parseGameParams(q('duel=D1&keystone.shots=cannonball.360.8.0.100.100')).shots).toHaveLength(1);
  });

  it('sides are named by their arcs', () => {
    expect(D1.sides.map((s) => sideOf(s.arc))).toEqual(['west', 'east']);
  });

  it("the HUD names the ruleset, whose turn and from where, each side's keep and shots left; a shot from the wrong side says so", () => {
    const { d } = fresh();
    const block = duelHudHtml(d, d.refuse(shotAt(0)));
    expect(block).toMatch(/Siege Table · Two Keeps/);
    expect(block).toMatch(/Gold to fire, from the west/);
    expect(block).toMatch(/duel-side on[^]*Gold ◂/);
    expect(block).toMatch(/4 left/);
    expect(block).toMatch(/Gold fires from its own side: turn the view/);
    // With the view's azimuth: off Gold's side the block says which way to drag (on a mouse; two fingers on touch), in place of the refusal.
    const off = duelHudHtml(d, d.refuse(shotAt(0)), 0);
    expect(off).toMatch(/turn-cue[^]*Drag (left ◂|right ▸)<\/span><span class="kg-tch">Two fingers (left ◂|right ▸)<\/span> to turn to Gold's side/);
    expect(off).not.toMatch(/turn the view/);
    expect(duelHudHtml(d, null, 199)).toMatch(/Drag right ▸/);
    expect(duelHudHtml(d, null, 521)).toMatch(/Drag left ◂/);
    // On Gold's side, no cue.
    expect(duelHudHtml(d, null, 360)).not.toMatch(/turn-cue/);
    const hud = hudHtml({ level: d.level.def, strokes: 0, crownsDown: 0, crownsTotal: 2, heritageBroken: 0, heritageTotal: 0, chips: rackChips(D1.sides[0].rack, D1.sides[0].rack, 'cannonball'), power: 100, liveLeverage: 0, phase: 'aiming', reachable: null, duel: block });
    expect(hud).toMatch(/Two Keeps<\/div>/);
    expect(hud).not.toMatch(/Leverage|Objective|Crowns/);
    expect(hud).toMatch(/Cannonball <b>3<\/b>\/3/);
  });

  it('the result card names the winner and why, offers Rematch and Same start, and nothing before the end', () => {
    const { c, s, d } = fresh();
    expect(duelResultHtml(d)).toBe('');
    d.fired(shotAt(360));
    for (let i = 0; i < c.meta.n; i++) if (c.meta.part[i] === 3) s.pos[3 * i + 1] = 0.5 * c.frame.unit;
    d.settled(s);
    const html = duelResultHtml(d);
    expect(html).toMatch(/Gold wins/);
    expect(html).toMatch(/Blue&#39;s keep fell · 1 shot/);
    expect(html).toMatch(/data-act="rematch"/);
    expect(html).toMatch(/data-act="again"/);
  });

  it('the door shows a Two players section with every table unless ?duels=0, and a duel URL keeps the door shut on auto', () => {
    expect(duelsOnDoor(q(''))).toBe(true);
    expect(duelsOnDoor(q('duels=0'))).toBe(false);
    expect(() => duelsOnDoor(q('duels=yes'))).toThrow(/duels must be 0 or 1/);
    const duels = doorDuels(DUELS, 'D2');
    expect(duels.map((x) => [x.id, x.ruleset, x.current])).toEqual([['D1', 'Two Keeps', false], ['D2', 'Heraldry', true]]);
    const html = doorHtml({ levels: [], current: -1, settings: DEFAULT_SETTINGS, howTo: false, advanced: false, duels });
    expect(html).toMatch(/Siege Table · two players/);
    expect(html).toMatch(/data-act="duel" data-arg="D1"/);
    expect(html).toMatch(/card duel current[^]*D2/);
    expect(doorHtml({ levels: [], current: -1, settings: DEFAULT_SETTINGS, howTo: false, advanced: false })).not.toMatch(/two players/);
    expect(doorOnLoad('auto', q('duel=D1'))).toBe(false);
    expect(doorOnLoad('auto', q(''))).toBe(true);
  });

});

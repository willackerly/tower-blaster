// The dud note's pure parts (PT31, dud.ts): what counts as a shot that did nothing, how hard each rack item hits,
// what the note says to try, and when a shot gave way inside. The note on screen after a real dud is in dud-e2e.test.ts.
import { compileLevel, L1, L2, L4, RL1, type RackItem, U3, A1 } from '@tb/keystone';
import { describe, expect, it } from 'vitest';
import { DUD_SHARE, dudNote, INNER_SHARE, INNER_SKYLINE, innerNote, isDud, itemPunch } from '../src/dud.ts';
import { itemLabel } from '../src/hud.ts';

describe('a dud (PT31)', () => {
  it('is a shot that moved under 1% of the structure and brought no crown down', () => {
    const n = 139; // L2's blocks: 1% is 1.39
    expect(DUD_SHARE).toBe(0.01);
    expect(isDud({ displaced: 0, crownsDown: 0 }, 0, n)).toBe(true);
    expect(isDud({ displaced: 1, crownsDown: 0 }, 0, n)).toBe(true);
    expect(isDud({ displaced: 2, crownsDown: 0 }, 0, n)).toBe(false);
    // displaced counts from the structure's start: only this shot's share counts.
    expect(isDud({ displaced: 41, crownsDown: 0 }, 40, n)).toBe(true);
    expect(isDud({ displaced: 42, crownsDown: 0 }, 40, n)).toBe(false);
    // A crown down is never a dud, however little else moved.
    expect(isDud({ displaced: 0, crownsDown: 1 }, 0, n)).toBe(false);
  });

  it('ranks a launched item by its energy at full power and a drop by its weight over the height; nothing for what fires no body', () => {
    const l2 = compileLevel(L2), l4 = compileLevel(L4);
    const marble = itemPunch(l2, 'marble')!, cannon = itemPunch(l2, 'cannonball')!, anvil = itemPunch(l4, 'drop')!;
    expect(marble).toBeGreaterThan(0);
    expect(cannon).toBeGreaterThan(1.5 * marble);
    expect(anvil).toBeGreaterThan(1.5 * itemPunch(l4, 'marble')!);
    expect(itemPunch(l2, 'marble')).toBe(itemPunch(compileLevel(L1), 'marble')); // the same item hits the same on the same frame
    for (const [d, item] of [[U3, 'pull'], [RL1, 'plunger'], [A1, 'quake']] as const) expect(itemPunch(compileLevel(d), item as RackItem), d.id).toBeNull();
  });

  it('names the hardest-hitting item left when it hits clearly harder, else says try another spot', () => {
    const l2 = compileLevel(L2), l4 = compileLevel(L4);
    const p2 = (i: RackItem) => itemPunch(l2, i), p4 = (i: RackItem) => itemPunch(l4, i);
    // L2 (J1 #6): three marbles that moved nothing, a cannonball still in the rack.
    expect(dudNote('marble', ['marble', 'cannonball'], p2, itemLabel)).toBe('Nothing moved: try the cannonball');
    // The cannonball itself, or a marble with only marbles left: another spot.
    expect(dudNote('cannonball', ['marble', 'cannonball'], p2, itemLabel)).toBe('Nothing moved: try another spot');
    expect(dudNote('marble', ['marble', 'marble'], p2, itemLabel)).toBe('Nothing moved: try another spot');
    expect(dudNote('marble', [], p2, itemLabel)).toBe('Nothing moved: try another spot');
    // L4 (J1 #6): the anvil on the fulcrum; a marble hits softer, so another spot, never "try the marble".
    expect(dudNote('drop', ['marble', 'drop'], p4, itemLabel)).toBe('Nothing moved: try another spot');
    // Items that fire no body are never suggested.
    expect(dudNote('marble', ['pull'], () => null, itemLabel)).toBe('Nothing moved: try another spot');
  });
});

describe('an inner collapse (PT31, J3 #20)', () => {
  it('says how much gave way when the top stood and nothing spilled, and nothing when the change shows', () => {
    const n = 100;
    // T-X2: 12% down, the shell standing, nothing out of the lot.
    expect(innerNote(0.12, 0, 0, n)).toBe('Gave way inside: 12% down');
    expect(innerNote(INNER_SHARE, INNER_SKYLINE / 2, 0, n)).toBe('Gave way inside: 5% down');
    // Small: no note (the HUD's Down figure is enough).
    expect(innerNote(INNER_SHARE - 1e-9, 0, 0, n)).toBeNull();
    // The top came down, or debris spilled out of the lot: the picture shows it.
    expect(innerNote(0.3, INNER_SKYLINE, 0, n)).toBeNull();
    expect(innerNote(0.3, 0, 1, n)).toBeNull();
    // Not a number (no settle to compare with): no note.
    expect(innerNote(Number.NaN, 0, 0, n)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { L1, L2, levelScore, tier } from '@tb/keystone';
import { esc, fmtLeverage, fmtPoints, hudHtml, nextSelection, rackChips, resultHtml, starsText } from '../src/hud.ts';

describe('rack', () => {
  it('groups by kind in first-seen order with counts and keys', () => {
    expect(rackChips(['cannonball', 'cannonball', 'marble', 'marble'], ['cannonball', 'marble', 'marble'], 'marble')).toEqual([
      { ammo: 'cannonball', key: '1', total: 2, left: 1, selected: false },
      { ammo: 'marble', key: '2', total: 2, left: 2, selected: true },
    ]);
  });
  it('keeps the selection while ammo is left, else moves to the first kind left', () => {
    const rack = ['marble', 'marble', 'cannonball'] as const;
    expect(nextSelection(rack, ['marble', 'cannonball'], 'marble')).toBe('marble');
    expect(nextSelection(rack, ['cannonball'], 'marble')).toBe('cannonball');
    expect(nextSelection(rack, [], 'marble')).toBeNull();
    expect(nextSelection(rack, rack, null)).toBe('marble');
  });
});

describe('formatting', () => {
  it('leverage, stars, points and escaping', () => {
    expect([0.123, 4.5, 12.34, 150.2].map(fmtLeverage)).toEqual(['×0.12', '×4.50', '×12.3', '×150']);
    expect([0, 2, 3].map(starsText)).toEqual(['☆☆☆', '★★☆', '★★★']);
    expect(fmtPoints(-1000)).toBe('−1,000');
    expect(fmtPoints(12345)).toBe('12,345');
    expect(esc('<a href="x">&</a>')).toBe('&#60;a href=&#34;x&#34;&#62;&#38;&#60;/a&#62;');
  });
  it('the HUD hides the power bar for an anvil and flags an unreachable aim', () => {
    const base = { level: L2, strokes: 0, crownsDown: 1, crownsTotal: 6, heritageBroken: 0, heritageTotal: 36, power: 60, liveLeverage: 0, phase: 'aiming', reachable: null };
    const marble = hudHtml({ ...base, chips: rackChips(L2.rack, L2.rack, 'marble') });
    expect(marble).toMatch(/W1-2 · Lintel/);
    expect(marble).toMatch(/1 \/ 6/);
    expect(marble).toMatch(/intact/);
    expect(marble).toMatch(/width:60%/);
    expect(hudHtml({ ...base, chips: [{ ammo: 'drop', key: '1', left: 1, total: 1, selected: true }] })).not.toMatch(/Power/);
    expect(hudHtml({ ...base, chips: [], reachable: false })).toMatch(/Out of reach/);
  });
  it('the result card lists every score line in order, then the total, stamp and stars', () => {
    const shot = { ke: 1000, dPE_mJ: 2_000_000, leverage: 2, crownsDown: 4, crownsTotal: 4, heritageNew: 0, displaced: 30, outOfLot: 0, spawnStep: 0, settleStep: 100 };
    const score = levelScore(L1, [shot], true, 40);
    const html = resultHtml(L1, score, 1, true);
    const labels = [...html.matchAll(/<div class="line[^"]*"[^>]*><span>([^<]+)<\/span>/g)].map((m) => m[1]);
    expect(labels).toEqual([...score.lines.map((l) => l.label), 'Total']);
    expect(html).toMatch(/>PAR</);
    expect(html).toContain(starsText(score.stars));
    expect(html).toMatch(/data-act="next"/);
    expect(resultHtml(L1, score, 1, false)).not.toMatch(/data-act="next"/);
    expect(html).toContain(`(${['Brute', 'Clean', 'Elegant', 'Keystone'][tier(score.leverage)]})`);
  });
  it('before the score, the card tallies: name, strokes and par, and the actions, no score lines or stamp', () => {
    const html = resultHtml(L1, null, 1, true);
    expect(html).toContain(L1.name);
    expect(html).toMatch(/1 stroke · par 1/);
    expect(html).toMatch(/tallying/);
    expect(html).toMatch(/data-act="retry"/);
    expect(html).toMatch(/data-act="next"/);
    expect(html).not.toMatch(/class="stamp|Total/);
  });
});

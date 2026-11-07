// The phone HUD and the result card's place and buttons (docs/game/phone-hud.md; agent playtest PT3 and PT4):
// the pure parts. The browser checks are in phone-hud-e2e.test.ts.
import { describe, expect, it } from 'vitest';
import { AFTERSHOCK_LEVELS, B1, B3, compileLevel, FUSE_LEVELS, L1, L5, levelScore, LEVELS, BIG_LEVELS, outcomeScore, RUBE_LEVELS, U1, UNDERCUT_LEVELS, TRIAL_LEVELS, WAVE_LEVELS } from '@tb/keystone';
import { cardActions, failedRound, hudHtml, meterTicks, rackChips, resultHtml, slotAction, tallyHtml } from '../src/hud.ts';
import { CARD_DELAY_S, layoutFor, layoutOf, MAX_CARD_DELAY_S } from '../src/layout.ts';
import { seriesForward } from '../src/door.ts';
import { GAME_SERIES } from '../src/params.ts';

const q = (s: string) => new URLSearchParams(s);
const shot = { ke: 1000, yield: 0, dPE_mJ: 2_000_000, leverage: 2, crownsDown: 4, crownsTotal: 4, heritageNew: 0, displaced: 30, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 100 };
const cleared = levelScore(L1, [shot], true, 40);
const missed = levelScore(L1, [{ ...shot, crownsDown: 1 }], false, 40);

describe('layout (keystone.hud, keystone.card, keystone.carddelay)', () => {
  it('docked by default: the phone HUD docked, the card aside after 1.2 s; classic: the panel and the centred card at once', () => {
    expect(layoutFor('docked')).toEqual({ hud: 'dock', card: 'strip', cardDelay: CARD_DELAY_S });
    expect(CARD_DELAY_S).toBe(1.2);
    expect(layoutFor('classic')).toEqual({ hud: 'panel', card: 'center', cardDelay: 0 });
  });
  it('each URL key wins over the setting for its part, and a bad value is refused naming the key', () => {
    expect(layoutOf(q(''), 'docked')).toEqual(layoutFor('docked'));
    expect(layoutOf(q('keystone.hud=panel'), 'docked')).toEqual({ hud: 'panel', card: 'strip', cardDelay: 1.2 });
    expect(layoutOf(q('keystone.card=dock&keystone.carddelay=0.5'), 'classic')).toEqual({ hud: 'panel', card: 'dock', cardDelay: 0.5 });
    expect(layoutOf(q('keystone.carddelay=0'), 'docked').cardDelay).toBe(0);
    // PT30: a phone's strip is the docked default; keystone.card=dock is the whole docked card of PT4, and strip works from classic too.
    expect(layoutOf(q('keystone.card=dock'), 'docked').card).toBe('dock');
    expect(layoutOf(q('keystone.card=strip'), 'classic')).toEqual({ hud: 'panel', card: 'strip', cardDelay: 0 });
    expect(() => layoutOf(q('keystone.hud=strip'), 'docked')).toThrow(/keystone\.hud must be dock or panel: strip/);
    expect(() => layoutOf(q('keystone.card=left'), 'docked')).toThrow(/keystone\.card must be strip, dock or center/);
    for (const bad of ['-1', 'x', '1e3', String(MAX_CARD_DELAY_S + 1)]) expect(() => layoutOf(q(`keystone.carddelay=${bad}`), 'docked')).toThrow(/keystone\.carddelay must be seconds/);
  });
});

describe('the HUD keeps one shape through a round (PT3)', () => {
  const b1 = compileLevel(B1);
  const base = { level: B1, crownsDown: 0, crownsTotal: 0, heritageBroken: 0, heritageTotal: 0, power: 100, launch: 13.5, leverage: { round: 0.26, shot: 0.26 }, phase: 'aiming', reachable: null, chips: rackChips(B1.rack, B1.rack, B1.rack[0]!), collapse: 0, ticks: meterTicks(b1) };
  /** The HUD's rows and controls, by class and data-act, with their text taken out: what decides its size. */
  const shape = (html: string) => [...html.matchAll(/<(div|span|button)( class="([^"]*)")?( data-act="(\w+)")?/g)].map((m) => `${m[1]}.${(m[3] ?? '').replace(/\b(pre|held|on|spent|got|none|empty|idle|ok|bad)\b/g, '').trim()}${m[5] ? `[${m[5]}]` : ''}`);
  it('in two groups, the status (.st) then the aim tray (.tray), the slot and the icons in the tray', () => {
    const html = hudHtml({ ...base, strokes: 0, opener: true });
    expect(html.indexOf('class="st"')).toBeLessThan(html.indexOf('class="tray"'));
    for (const part of ['class="chips"', 'class="ctl"', 'class="above"', 'slot-row', 'data-act="undo"', 'data-act="restart"']) expect(html.indexOf(part)).toBeGreaterThan(html.indexOf('class="tray"'));
    for (const part of ['class="title"', 'class="meter"', 'row obj', 'row lev']) expect(html.indexOf(part)).toBeLessThan(html.indexOf('class="tray"'));
  });
  it('the same rows before the first shot (opener in the slot, hint shown) and after it (Bank in the slot), apart from the hint above the tray', () => {
    const before = hudHtml({ ...base, strokes: 0, opener: true });
    const after = hudHtml({ ...base, strokes: 1, collapse: 0.17, canBank: true });
    // The hint and the slot's note (hidden when docked: its desktop and touch spans) aside.
    const drop = (xs: string[]) => xs.filter((x) => !x.startsWith('div.tch-hint') && x !== 'span.kg-desk' && x !== 'span.kg-tch').map((x) => x.replace(/\[(opener|bank|freeze)\]$/, '[slot]').replace(/^button\.(opener|bank|freeze)/, 'button.slotbtn'));
    expect(drop(shape(after))).toEqual(drop(shape(before)));
    // From the second shot this shot's leverage shows beside the round's, in the place held for it from the first frame.
    const second = hudHtml({ ...base, strokes: 2, collapse: 0.3, canBank: true, leverage: { round: 1.1, shot: 2.2 } });
    expect(drop(shape(second))).toEqual(drop(shape(after)));
    expect(after).toMatch(/class="small shot held"/);
    expect(second).toMatch(/class="small shot">this shot ×2\.20/);
    expect(before).toMatch(/class="tch-hint"/);
    expect(after).not.toMatch(/class="tch-hint"/);
    // Nothing to offer: the slot keeps its place, empty.
    const idle = hudHtml({ ...base, strokes: 1, collapse: 0.17 });
    expect(idle).toMatch(/class="row slot-row idle"><span class="slot empty"><\/span>/);
  });
  it('the slot offers one thing at a time: Resume, Freeze, the opener, Bank, by priority', () => {
    const fz = (frozen: boolean, can: boolean) => ({ left: 1, total: 2, frozen, can });
    expect(slotAction({ level: B1, freezes: fz(true, false), opener: true, canBank: true })).toBe('resume');
    expect(slotAction({ level: B1, freezes: fz(false, true), canBank: true })).toBe('freeze');
    expect(slotAction({ level: B1, opener: true, canBank: true })).toBe('opener');
    expect(slotAction({ level: B1, canBank: true })).toBe('bank');
    expect(slotAction({ level: L1, canBank: true })).toBeNull(); // a par level never banks
    expect(slotAction({ level: B1, duel: '', opener: true })).toBeNull();
    const html = hudHtml({ ...base, strokes: 1, collapse: 0.4, canBank: true, freezes: fz(false, true) });
    expect([...html.matchAll(/data-act="(freeze|bank|opener)"/g)].map((m) => m[1])).toEqual(['freeze']);
    // Skip (PT6) shares a running shot's moment: after Freeze, before the opener and Bank; then a note while it skips.
    expect(slotAction({ level: B1, canSkip: true, opener: true, canBank: true })).toBe('skip');
    expect(slotAction({ level: L1, skipping: true })).toBe('skipping');
    expect(slotAction({ level: B1, freezes: fz(false, true), canSkip: true })).toBe('freeze');
    expect(slotAction({ level: B1, freezes: fz(true, false), canSkip: false })).toBe('resume');
    expect(slotAction({ level: B1, duel: '', canSkip: true })).toBeNull();
  });
  it('the slot holds Skip, Freeze with Skip beside it on a Bullet Time level, and the skipping note, in the same place', () => {
    const fz = { left: 1, total: 2, frozen: false, can: true };
    const slot = (html: string) => html.match(/<span class="slot[^"]*">(.*?)<\/span><span class="small note">/)![1]!;
    const running = { ...base, strokes: 1, collapse: 0.2, phase: 'running' };
    expect([...slot(hudHtml({ ...running, canSkip: true })).matchAll(/data-act="(\w+)"/g)].map((m) => m[1])).toEqual(['skip']);
    expect([...slot(hudHtml({ ...running, canSkip: true, freezes: fz })).matchAll(/data-act="(\w+)"/g)].map((m) => m[1])).toEqual(['freeze', 'skip']);
    expect(slot(hudHtml({ ...running, skipping: true }))).toMatch(/class="small skipping">skipping to the settle…/);
    // Skip shows nowhere else in the HUD.
    expect([...hudHtml({ ...running, canSkip: true }).matchAll(/data-act="skip"/g)]).toHaveLength(1);
  });
});

describe('the result card (PT4)', () => {
  const acts = (html: string) => [...html.matchAll(/<button data-act="(\w+)"( class="primary")?/g)].map((m) => `${m[1]}${m[2] ? '*' : ''}`);
  it('a cleared round: the way forward is primary; a failed one: Retry is', () => {
    expect(failedRound(cleared)).toBe(false);
    expect(failedRound(missed)).toBe(true);
    expect(failedRound(null)).toBe(false);
    expect(acts(cardActions(cleared, 1, { act: 'next' }, false, true))).toEqual(['undo', 'retry', 'next*']);
    expect(acts(cardActions(missed, 1, { act: 'next' }, false, true))).toEqual(['undo', 'retry*', 'next']);
    const outcomeMiss = outcomeScore({ met: false, collapse: 0.17, leverage: 1, comboMax: 1, hasCrowns: false, rackLeft: 1, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0 }, undefined);
    expect(outcomeMiss.stamp).toBe('INCOMPLETE');
    expect(acts(resultHtml(B1, outcomeMiss, 3, true, true, '', true))).toEqual(['card', 'undo', 'retry*', 'save', 'next']);
  });
  it('a series\' last level offers the next series, or Levels; true and false still mean Next and none', () => {
    expect(cardActions(cleared, 1, { act: 'series', label: 'Next: Chamber' }, false, false)).toMatch(/<button data-act="series" class="primary">Next: Chamber →<\/button>/);
    expect(acts(cardActions(cleared, 1, { act: 'levels' }, false, false))).toEqual(['retry', 'levels*']);
    expect(acts(cardActions(cleared, 1, true, false, false))).toEqual(['retry', 'next*']);
    expect(acts(cardActions(cleared, 1, false, false, false))).toEqual(['retry']);
    expect(acts(cardActions(cleared, 1, null, false, false))).toEqual(['retry']);
  });
  it('the game page\'s series lead on: Spectacle to Chamber to Undercut to Rube Lab to Fuse & Fold to Aftershock to Wavefront, then the trials are not offered (Levels instead)', () => {
    const levels = GAME_SERIES.flat(), series = GAME_SERIES.flatMap((s, k) => s.map(() => k));
    const at = (id: string) => seriesForward(series, levels.findIndex((l) => l.id === id), levels);
    expect(at(B1.id)).toBeNull(); // not a series' end: Next
    expect(at(B3.id)).toEqual({ index: levels.findIndex((l) => l.id === LEVELS[0]!.id), label: 'Next: Chamber' });
    expect(at(L5.id)).toEqual({ index: levels.findIndex((l) => l.id === UNDERCUT_LEVELS[0]!.id), label: 'Next: Undercut' });
    expect(at(UNDERCUT_LEVELS.at(-1)!.id)).toEqual({ index: levels.findIndex((l) => l.id === RUBE_LEVELS[0]!.id), label: 'Next: Rube Lab' });
    expect(at(RUBE_LEVELS.at(-1)!.id)).toEqual({ index: levels.findIndex((l) => l.id === FUSE_LEVELS[0]!.id), label: 'Next: Fuse & Fold' });
    expect(at(FUSE_LEVELS.at(-1)!.id)).toEqual({ index: levels.findIndex((l) => l.id === AFTERSHOCK_LEVELS[0]!.id), label: 'Next: Aftershock' });
    expect(at(AFTERSHOCK_LEVELS.at(-1)!.id)).toEqual({ index: levels.findIndex((l) => l.id === WAVE_LEVELS[0]!.id), label: 'Next: Wavefront' });
    expect(at(WAVE_LEVELS.at(-1)!.id)).toBeNull();
    expect(at(TRIAL_LEVELS.at(-1)!.id)).toBeNull();
    expect(at(U1.id)).toBeNull();
    expect(BIG_LEVELS.at(-1)!.id).toBe(B3.id);
  });
  it('two groups: name, lines and total; then stamp, stars, badge, sheet and the buttons', () => {
    const html = resultHtml(L1, cleared, 1, true, false, '<div class="lot">sheet</div>', true);
    const c2 = html.indexOf('class="c2"');
    expect(html.indexOf('class="c1"')).toBeLessThan(c2);
    for (const part of ['class="name"', 'class="line total"']) expect(html.indexOf(part)).toBeLessThan(c2);
    for (const part of ['class="stamp', 'class="stars"', 'class="lot"', 'class="actions"']) expect(html.indexOf(part)).toBeGreaterThan(c2);
  });
  it('the tallying banner: the level, what is known (crowns down, or the stamp and stars once scored)', () => {
    expect(tallyHtml(L1, null)).toMatch(/All crowns down<\/b> <span class="small">tallying…/);
    expect(tallyHtml(B1, null)).toMatch(/Round over/);
    expect(tallyHtml(L1, cleared)).toContain(`<b>${cleared.stamp}</b>`);
    expect(tallyHtml(L1, cleared)).toMatch(/★/);
    expect(tallyHtml(L1, null, 'Round over')).toMatch(/^<b>Round over<\/b>/);
    expect(tallyHtml({ ...L1, name: '<x>' }, null)).toContain('&#60;x&#62;');
  });
});

describe('the HUD\'s insets for the opening camera', () => {
  it('upright: the strip is the top inset, the tray and its hint the bottom; sideways: the rail is the left', async () => {
    const { hudInsets } = await import('../src/layout.ts');
    // Measured at 390 x 844 (B1): strip, tray, hint above the tray.
    const up = hudInsets([{ x: 8, y: 8, w: 298, h: 92 }, { x: 8, y: 684, w: 374, h: 152 }, { x: 8, y: 639, w: 374, h: 39 }], 390, 844);
    expect(up.top).toBeCloseTo(100 / 844, 9);
    expect(up.bottom).toBeCloseTo((844 - 639) / 844, 9);
    expect([up.left, up.right]).toEqual([0, 0]);
    // 844 x 390: the rail's status and tray on the left.
    const side = hudInsets([{ x: 8, y: 8, w: 220, h: 123 }, { x: 8, y: 180, w: 220, h: 202 }], 844, 390);
    expect(side).toEqual({ top: 0, bottom: 0, left: 228 / 844, right: 0 });
    // Nothing shown, nothing taken.
    expect(hudInsets([{ x: 0, y: 0, w: 0, h: 0 }], 390, 844)).toEqual({ top: 0, bottom: 0, left: 0, right: 0 });
  });
});

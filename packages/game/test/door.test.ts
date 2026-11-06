// The front door's formatting (door.ts) and the settings it edits (settings.ts): pure.
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, BIG_LEVELS, compileLevel, L1, L3, type LevelDef, LEVELS, SERIES, TRIAL_LEVELS, U1, U2, UNDERCUT_LEVELS } from '@tb/keystone';
import { bestText, doorHtml, doorLevels, doorMode, doorOnLoad, nextLevel, openerFor, preaimMode, rackText, seriesTitle, starTargets, thresholdText, TRIALS_BLURB } from '../src/door.ts';
import { GAME_SERIES } from '../src/params.ts';
import type { LevelRecord } from '../src/progress.ts';
import { cameraFeel, DEFAULT_SETTINGS, launchFeel, marksFeel, parseSettings, rapidFeel, SETTINGS_KEY, SettingsStore, turnViewFeel, urlSettings } from '../src/settings.ts';

import { paceFeel } from '../src/pacing.ts';
import { memoryKeyValue } from '../src/progress.ts';

/** B3 as it was before its cast landed: no stars and no recorded line (the door's uncast case). */
const UNCAST: LevelDef = { ...B3, stars: undefined, solutions: undefined };

const q = (s: string) => new URLSearchParams(s);
const rec = (stars: 0 | 1 | 2 | 3, extra: Partial<LevelRecord> = {}): LevelRecord => ({ hash: 'h', plays: 1, stars, total: 1200, at: '2026-11-02T00:00:00Z', ...extra });

describe('door options', () => {
  it('door=auto shows it on a URL without a level; 1 always; 0 never; anything else refused', () => {
    expect(doorOnLoad(doorMode(q('')), q(''))).toBe(true);
    expect(doorOnLoad(doorMode(q('level=B2')), q('level=B2'))).toBe(false);
    expect(doorOnLoad(doorMode(q('level=B2&door=1')), q('level=B2&door=1'))).toBe(true);
    expect(doorOnLoad(doorMode(q('door=0')), q('door=0'))).toBe(false);
    expect(() => doorMode(q('door=yes'))).toThrow(/door must be auto, 1 or 0: yes/);
  });
  it('keystone.preaim: auto offers the first level\'s opener on a first visit only; 1 every level with a line; 0 none', () => {
    const ace0 = B1.solutions!.ace![0];
    expect(openerFor(B1, 0, 'auto', false)).toBe(ace0);
    expect(openerFor(B1, 0, 'auto', true)).toBeNull();
    expect(openerFor(B2, 1, 'auto', false)).toBeNull();
    expect(openerFor(B2, 1, '1', true)).toBe(B2.solutions!.ace![0]);
    expect(openerFor(L1, 0, '1', false)).toBe(L1.solutions!.par![0]);
    expect(openerFor(UNCAST, 2, '1', false)).toBeNull(); // no recorded line
    expect(openerFor(B3, 2, '1', false)).toBe(B3.solutions!.ace![0]);
    expect(openerFor(B1, 0, '0', false)).toBeNull();
    expect(preaimMode(q(''))).toBe('auto');
    expect(() => preaimMode(q('keystone.preaim=on'))).toThrow(/keystone.preaim must be auto, 1 or 0/);
  });
});

describe('door text', () => {
  it('thresholds in each metric\'s words', () => {
    expect(thresholdText('collapse', 0.7)).toBe('70% down');
    expect(thresholdText('score', 3200)).toBe('3,200 points');
    expect(thresholdText('crowns', 1)).toBe('1 crown down');
    expect(thresholdText('skyline', 0.4)).toBe('skyline at 40% of its height');
  });
  it('the rack grouped and counted', () => {
    expect(rackText(B1.rack)).toBe('3 bombs');
    expect(rackText(B2.rack)).toBe('1 bomb, 2 rams');
  });
  it('star targets: objective, then the cast T2 and T3; uncast levels the objective alone; heritage named for three stars', () => {
    expect(starTargets(compileLevel(B1), B1.stars)).toEqual({ targets: ['Bring 40% down', '70% down', '94% down'], short: ['40%', '70%', '94%'], cast: true });
    const b2 = starTargets(compileLevel(B2), B2.stars);
    expect(b2.targets).toEqual(['Fell every crown', '770 points', '3,200 points, heritage intact']);
    expect(b2.short).toEqual(['all crowns', '770', '3,200']);
    expect(starTargets(compileLevel(B3), undefined)).toEqual({ targets: ['Bring 40% down', '', ''], short: ['40%', '', ''], cast: false });
    // Par levels (parStars): two stars one shot over par, three in par; heritage named where the level has some.
    expect(starTargets(compileLevel(L1), undefined)).toMatchObject({ targets: [expect.any(String), '…in 2 shots', '…in par (1 shot)'], short: [expect.any(String), '2 shots', 'par 1'], cast: true });
    expect(starTargets(compileLevel(L3), undefined).targets.slice(1)).toEqual(['…in 3 shots', '…in par (2 shots), heritage intact']);
    // Undercut's par puzzles count pulls.
    expect(starTargets(compileLevel(U1), undefined)).toEqual({ targets: ['Fell every crown', '…in 3 pulls', '…in par (2 pulls)'], short: ['all crowns', '3 pulls', 'par 2'], cast: true });
    expect(starTargets(compileLevel(U2), undefined).targets[2]).toBe('…in par (2 pulls), heritage intact');
  });
  it('B3\'s stars show from stars.json the moment they land (simulated drop-in, then the landed stars)', () => {
    const cast = { ...UNCAST, stars: { metric: 'collapse' as const, t2: 0.5, t3: 0.62, hash: compileLevel(B3).hash } };
    const [l] = doorLevels([cast], () => null);
    expect(l).toMatchObject({ cast: true, targets: ['Bring 40% down', '50% down', '62% down'] });
    expect(doorLevels([B3], () => null)[0]).toMatchObject({ cast: true, targets: ['Bring 40% down', '53% down', '63% down'] });
  });
  it('best play text', () => {
    expect(bestText(null)).toBe('Not played yet');
    expect(bestText(rec(2, { metric: 'collapse', value: 0.81, collapse: 0.81, plays: 3 }))).toBe('Best 81% down · 3 plays');
    expect(bestText(rec(1, { metric: 'score', value: 900, total: 900, collapse: 0.3 }))).toBe('Best 900 points · 1 play');
    expect(bestText(rec(3, { metric: 'collapse', collapse: 0.97, beatBot: true }))).toBe('Best 97% down · 1 play · beat the bot');
    expect(bestText(rec(2, { total: 340 }))).toBe('Best 340 points · 1 play');
    expect(bestText(rec(3, { total: 5200, gold: true }))).toBe('Best 5,200 points · 1 play · gold leverage');
  });
});

describe('door levels', () => {
  it('one per level with blocks, rack and the best play on the level\'s current hash only', () => {
    const hashB1 = compileLevel(B1).hash;
    const ls = doorLevels(BIG_LEVELS, (id, h) => (id === 'B1' && h === hashB1 ? rec(2, { hash: h }) : null));
    expect(ls.map((l) => [l.id, l.blocks, l.rack, l.best?.stars ?? null])).toEqual([['B1', 1000, '3 bombs', 2], ['B2', 5184, '1 bomb, 2 rams', null], ['B3', 10000, '3 bombs', null]]);
  });
  it('a custom level shows the note and no best', () => {
    const [l] = doorLevels([{ ...B1, custom: true }], () => rec(3));
    expect(l).toMatchObject({ custom: true, best: null, cast: false });
  });
  it('Play opens the first level without a star, else the first', () => {
    const mk = (s: Array<0 | 1 | null>, trials = 0) => s.map((x, i) => ({ id: `B${i}`, name: '', blocks: 0, rack: '', targets: ['', '', ''] as [string, string, string], short: ['', '', ''] as [string, string, string], cast: true, custom: false, best: x === null ? null : rec(x), index: i, series: '', trial: i < trials }));
    expect(nextLevel(mk([1, null, null]))).toBe(1);
    expect(nextLevel(mk([1, 0, null]))).toBe(1);
    expect(nextLevel(mk([1, 1, 1]))).toBe(0);
    // Never a trial: the first rated level uncleared, else the first rated one.
    expect(nextLevel(mk([null, null, 1], 2))).toBe(2);
    expect(nextLevel(mk([null, 1, 1], 1))).toBe(1);
    expect(nextLevel(mk([null, null], 2))).toBe(0);
  });
  it('every series shows under its title, in the game\'s order; the trials behind a toggle, closed and uncompiled until opened', () => {
    expect(GAME_SERIES.flat().map((d) => d.id).sort()).toEqual(SERIES.flat().map((d) => d.id).sort());
    expect([seriesTitle('b2'), seriesTitle('L1'), seriesTitle('U3'), seriesTitle('t-s4'), seriesTitle('S4')]).toEqual(['Spectacle', 'Chamber', 'Undercut', 'Trials · unrated', '']);
    const all = GAME_SERIES.flat(), compiled: string[] = [];
    const compile = (d: (typeof all)[number]) => { compiled.push(d.id); return compileLevel(d); };
    const closed = doorLevels(all, () => null, compile, (d) => d.id.startsWith('T-'));
    expect(compiled).toEqual([...BIG_LEVELS, ...LEVELS, ...UNDERCUT_LEVELS].map((d) => d.id));
    // A card's data-arg is its index in the page's whole list, skipped trials or not.
    expect(closed.map((l) => l.index)).toEqual(compiled.map((_, i) => i));
    const shut = doorHtml({ levels: closed, current: 3, settings: DEFAULT_SETTINGS, howTo: false, advanced: false, trials: { count: TRIAL_LEVELS.length, open: false } });
    expect([...shut.matchAll(/<h2 class="series-head">([^<]*)</g)].map((x) => x[1])).toEqual(['Spectacle', 'Chamber', 'Undercut']);
    expect(shut.match(/class="card[ "]/g)).toHaveLength(11);
    expect(shut).toContain(`data-act="trials" class="series-head trials-head" aria-expanded="false">Trials · unrated (${TRIAL_LEVELS.length}) ▸</button>`);
    expect(shut).not.toContain(TRIALS_BLURB.slice(0, 20));
    expect(shut).toContain('class="card current" data-act="level" data-arg="3"');
    const open = doorLevels(all, () => null);
    expect(open.length).toBe(all.length);
    const t = all.findIndex((d) => d.id === 'T-X1');
    const html = doorHtml({ levels: open, current: t, settings: DEFAULT_SETTINGS, howTo: false, advanced: false, trials: { count: TRIAL_LEVELS.length, open: true } });
    expect(html).toContain('aria-expanded="true">Trials · unrated');
    expect(html.match(/class="card[^"]* trial"/g)).toHaveLength(TRIAL_LEVELS.length);
    expect(html).toContain(`class="card current trial" data-act="level" data-arg="${t}" aria-label="T-X1 Domino Run"`);
    // Play still opens the first rated level (B1), though a trial is loaded; Back names the trial.
    expect(html).toContain(`Play · ${B1.name}`);
    expect(html).toContain('Back to Domino Run');
    // A trial is uncast: the objective's row alone.
    expect(open.find((l) => l.id === 'T-S4')).toMatchObject({ trial: true, cast: false, series: 'Trials · unrated', blocks: 10000 });
  });
  it('markup: a card per level marking earned stars, the next and the loaded one, every action wired', () => {
    const levels = doorLevels(LEVELS, (id) => (id === 'L1' ? rec(2) : null));
    const html = doorHtml({ levels, current: 0, settings: DEFAULT_SETTINGS, howTo: true, advanced: true });
    expect(html.match(/class="card[ "]/g)).toHaveLength(5);
    expect(html).toContain('class="card current" data-act="level" data-arg="0"');
    expect(html).toContain('class="card next" data-act="level" data-arg="1"');
    expect(html).toContain(`Play · ${LEVELS[1]!.name}`);
    expect(html).toContain(`Back to ${LEVELS[0]!.name}`);
    expect(html.match(/<li class="got/g)).toHaveLength(2);
    expect(html).toContain('<span class="earned">★★</span><span class="unearned">☆</span>');
    for (const act of ['how', 'advanced', 'sound', 'look', 'sharp', 'camera', 'rapid', 'duelview', 'launch', 'marks', 'reset', 'close']) expect(html).toContain(`data-act="${act}"`);
    expect(html).toContain('class="how"');
    expect(html).toContain('data-act="advanced" class="howlink advlink on" aria-expanded="true"');
    expect(doorHtml({ levels, current: -1, settings: DEFAULT_SETTINGS, howTo: false, advanced: false })).not.toContain('data-act="close"');
    // Back to the level is the Play button already when the next level is the loaded one.
    expect(doorHtml({ levels, current: 1, settings: DEFAULT_SETTINGS, howTo: false, advanced: false })).not.toContain('data-act="close"');
  });
  it('the settings sit behind Advanced settings, closed by default', () => {
    const closed = doorHtml({ levels: doorLevels(LEVELS, () => null), current: 0, settings: DEFAULT_SETTINGS, howTo: false, advanced: false });
    expect(closed).toContain('data-act="advanced" class="howlink advlink" aria-expanded="false">Advanced settings</button>');
    for (const act of ['sound', 'look', 'sharp', 'camera', 'rapid', 'duelview', 'launch', 'marks', 'quality', 'reset']) expect(closed).not.toContain(`data-act="${act}"`);
    expect(closed).not.toContain('class="advanced"');
    // The rest of the door is the same either way.
    expect(closed).toContain('data-act="how"');
    expect(closed.match(/class="card[ "]/g)).toHaveLength(5);
  });
  it('an uncast level shows the objective\'s row and one star slot, and no placeholder (PT7)', () => {
    const html = doorHtml({ levels: doorLevels([UNCAST], () => null), current: 0, settings: DEFAULT_SETTINGS, howTo: false, advanced: false });
    expect(html.match(/<li /g)).toHaveLength(1);
    expect(html).toContain('<span class="earned"></span><span class="unearned">☆</span>');
    expect(html).not.toMatch(/coming soon|★★/);
  });
  it('no card on the door, rated or trial, says "coming soon" or shows a "?" target (PT7)', () => {
    const levels = doorLevels(SERIES.flat(), () => null);
    const html = doorHtml({ levels, current: 0, settings: DEFAULT_SETTINGS, howTo: false, advanced: false, trials: { count: TRIAL_LEVELS.length, open: true } });
    const cards = html.match(/<button class="card[\s\S]*?<\/button>/g)!;
    expect(cards.length).toBe(SERIES.flat().length);
    for (const card of cards) {
      expect(card, card.slice(0, 120)).not.toMatch(/coming soon/i);
      const targets = card.match(/<ul class="targets">([\s\S]*?)<\/ul>/)![1]! + card.match(/<div class="short">([\s\S]*?)<\/div>/)![1]!;
      expect(targets, card.slice(0, 120)).not.toContain('?');
    }
  });
  it('escapes level text', () => {
    const [l] = doorLevels([{ ...L1, name: '<b>x</b>' }], () => null);
    expect(doorHtml({ levels: [l!], current: 0, settings: DEFAULT_SETTINGS, howTo: false, advanced: false })).toContain('&#60;b&#62;x&#60;/b&#62;');
  });
});

describe('settings', () => {
  it('parse field by field, defaults for anything bad', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"sound":false,"look":"nope","sharp":3}')).toEqual({ ...DEFAULT_SETTINGS, sound: false });
    expect(parseSettings('{"look":"real","sharp":1}')).toEqual({ sound: true, look: 'real', sharp: 1, camera: 'still', rapid: true, duelView: true, launch: 'high', marks: true, quality: 'auto' });
    // Settings stored before the Camera setting open still, as does anything but its two values.
    expect(DEFAULT_SETTINGS.camera).toBe('still');
    expect(parseSettings('{"camera":"dynamic"}')).toEqual({ ...DEFAULT_SETTINGS, camera: 'dynamic' });
    expect(parseSettings('{"camera":true}')).toEqual(DEFAULT_SETTINGS);
  });
  it('the camera motions: the URL\'s keystone.follow and keystone.shake each where they say, else the Camera setting', () => {
    const at = (search: string, camera: 'still' | 'dynamic') => { const u = q(search); return cameraFeel(paceFeel(u), u, camera); };
    expect(at('', 'still')).toEqual({ follow: false, shake: false });
    expect(at('', 'dynamic')).toEqual({ follow: true, shake: true });
    expect(at('keystone.follow=1', 'still')).toEqual({ follow: true, shake: false });
    expect(at('keystone.shake=0', 'dynamic')).toEqual({ follow: true, shake: false });
    expect(at('keystone.follow=0&keystone.shake=1', 'dynamic')).toEqual({ follow: false, shake: true });
    const html = (camera: 'still' | 'dynamic') => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, camera }, howTo: false, advanced: true });
    expect(html('still')).toContain('data-act="camera" data-arg="still" class="on"');
    expect(html('dynamic')).toContain('data-act="camera" data-arg="dynamic" class="on"');
  });
  it('rapid fire: on by default; the URL\'s keystone.rapid where it says, else the setting', () => {
    expect(DEFAULT_SETTINGS.rapid).toBe(true);
    // Settings stored before the setting existed open with it on; only a boolean is taken.
    expect(parseSettings('{"look":"real"}').rapid).toBe(true);
    expect(parseSettings('{"rapid":false}')).toEqual({ ...DEFAULT_SETTINGS, rapid: false });
    expect(parseSettings('{"rapid":"off"}')).toEqual(DEFAULT_SETTINGS);
    const at = (search: string, rapid: boolean) => { const u = q(search); return rapidFeel(paceFeel(u), u, rapid); };
    expect(at('', true)).toEqual({ rapid: true });
    expect(at('', false)).toEqual({ rapid: false });
    expect(at('keystone.rapid=0', true)).toEqual({ rapid: false });
    expect(at('keystone.rapid=1', false)).toEqual({ rapid: true });
    const html = (rapid: boolean) => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, rapid }, howTo: false, advanced: true });
    expect(html(true)).toContain('data-act="rapid" data-arg="on" class="on"');
    expect(html(false)).toContain('data-act="rapid" data-arg="off" class="on"');
  });
  it('launch height: high by default; the URL\'s keystone.launch where it says, else the setting', () => {
    expect(DEFAULT_SETTINGS.launch).toBe('high');
    // Settings stored before the setting existed open with it high; only a known mode is taken.
    expect(parseSettings('{"look":"real"}').launch).toBe('high');
    expect(parseSettings('{"launch":"level"}')).toEqual({ ...DEFAULT_SETTINGS, launch: 'level' });
    expect(parseSettings('{"launch":"low"}')).toEqual(DEFAULT_SETTINGS);
    const at = (search: string, launch: 'high' | 'level') => { const u = q(search); return launchFeel(paceFeel(u), u, launch); };
    expect(at('', 'high')).toEqual({ launch: 'high' });
    expect(at('', 'level')).toEqual({ launch: 'level' });
    expect(at('keystone.launch=level', 'high')).toEqual({ launch: 'level' });
    expect(at('keystone.launch=high', 'level')).toEqual({ launch: 'high' });
    const html = (launch: 'high' | 'level') => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, launch }, howTo: false, advanced: true });
    expect(html('high')).toContain('data-act="launch" data-arg="high" class="on"');
    expect(html('level')).toContain('data-act="launch" data-arg="level" class="on"');
  });
  it('stone marks: carved by default; the URL\'s keystone.marks where it says, else the setting', () => {
    expect(DEFAULT_SETTINGS.marks).toBe(true);
    // Settings stored before the setting existed open with marks carved; only a boolean is taken.
    expect(parseSettings('{"look":"real"}').marks).toBe(true);
    expect(parseSettings('{"marks":false}')).toEqual({ ...DEFAULT_SETTINGS, marks: false });
    expect(parseSettings('{"marks":"off"}')).toEqual(DEFAULT_SETTINGS);
    const at = (search: string, on: boolean) => { const u = q(search); return marksFeel(paceFeel(u), u, on); };
    expect(at('', true)).toEqual({ marks: true });
    expect(at('', false)).toEqual({ marks: false });
    expect(at('keystone.marks=0', true)).toEqual({ marks: false });
    expect(at('keystone.marks=1', false)).toEqual({ marks: true });
    const html = (marks: boolean) => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, marks }, howTo: false, advanced: true });
    expect(html(true)).toContain('data-act="marks" data-arg="on" class="on"');
    expect(html(false)).toContain('data-act="marks" data-arg="off" class="on"');
  });
  it('duel turns: the turn view on by default; the URL\'s keystone.turnview where it says, else the setting', () => {
    expect(DEFAULT_SETTINGS.duelView).toBe(true);
    // Settings stored before the setting existed open with it on; only a boolean is taken.
    expect(parseSettings('{"rapid":false}').duelView).toBe(true);
    expect(parseSettings('{"duelView":false}')).toEqual({ ...DEFAULT_SETTINGS, duelView: false });
    expect(parseSettings('{"duelView":0}')).toEqual(DEFAULT_SETTINGS);
    const at = (search: string, on: boolean) => { const u = q(search); return turnViewFeel(paceFeel(u), u, on); };
    expect(at('', true)).toEqual({ turnView: true });
    expect(at('', false)).toEqual({ turnView: false });
    expect(at('keystone.turnview=0', true)).toEqual({ turnView: false });
    expect(at('keystone.turnview=1', false)).toEqual({ turnView: true });
    const html = (duelView: boolean) => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, duelView }, howTo: false, advanced: true });
    expect(html(true)).toContain('data-act="duelview" data-arg="on" class="on"');
    expect(html(false)).toContain('data-act="duelview" data-arg="off" class="on"');
    expect(html(true)).toMatch(/Duel turns/);
  });
  it('URL keys: sound=on|off, sharp=1|2, look (checked by the page); bad values refused', () => {
    expect(urlSettings(q('sound=off&sharp=1&look=candy'))).toEqual({ sound: false, sharp: 1, look: 'candy' });
    expect(() => urlSettings(q('sound=0'))).toThrow(/sound must be on or off: 0/);
    expect(() => urlSettings(q('sharp=3'))).toThrow(/sharp must be 1 or 2: 3/);
  });
  it('the URL wins for the visit; a change is stored and replaces the URL\'s say on that field', () => {
    const kv = memoryKeyValue({ [SETTINGS_KEY]: '{"look":"real"}' });
    const s = new SettingsStore(kv, q('look=candy&sound=off'));
    expect(s.current).toEqual({ sound: false, look: 'candy', sharp: 2, camera: 'still', rapid: true, duelView: true, launch: 'high', marks: true, quality: 'auto' });
    expect(s.set({ look: 'hazy' })).toEqual({ sound: false, look: 'hazy', sharp: 2, camera: 'still', rapid: true, duelView: true, launch: 'high', marks: true, quality: 'auto' });
    expect(JSON.parse(kv.getItem(SETTINGS_KEY)!)).toEqual({ sound: true, look: 'hazy', sharp: 2, camera: 'still', rapid: true, duelView: true, launch: 'high', marks: true, quality: 'auto' });
    expect(new SettingsStore(kv).current).toEqual({ sound: true, look: 'hazy', sharp: 2, camera: 'still', rapid: true, duelView: true, launch: 'high', marks: true, quality: 'auto' });
  });
  it('storage that throws keeps settings in memory', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
    const s = new SettingsStore(bad);
    expect(s.set({ sound: false }).sound).toBe(false);
  });
});

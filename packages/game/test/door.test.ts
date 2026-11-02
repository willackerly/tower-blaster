// The front door's formatting (door.ts) and the settings it edits (settings.ts): pure.
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, BIG_LEVELS, compileLevel, L1, LEVELS } from '@tb/keystone';
import { bestText, doorHtml, doorLevels, doorMode, doorOnLoad, nextLevel, openerFor, preaimMode, rackText, starTargets, thresholdText } from '../src/door.ts';
import type { LevelRecord } from '../src/progress.ts';
import { cameraFeel, DEFAULT_SETTINGS, parseSettings, SETTINGS_KEY, SettingsStore, urlSettings } from '../src/settings.ts';
import { paceFeel } from '../src/pacing.ts';
import { memoryKeyValue } from '../src/progress.ts';

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
    expect(openerFor(B3, 2, '1', false)).toBeNull(); // no recorded line
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
  it('star targets: objective, then the cast T2 and T3; uncast levels say so; heritage named for three stars', () => {
    expect(starTargets(compileLevel(B1), B1.stars)).toEqual({ targets: ['Bring 40% down', '70% down', '94% down'], short: ['40%', '70%', '94%'], cast: true });
    const b2 = starTargets(compileLevel(B2), B2.stars);
    expect(b2.targets).toEqual(['Fell every crown', '770 points', '3,200 points, heritage intact']);
    expect(b2.short).toEqual(['all crowns', '770', '3,200']);
    expect(starTargets(compileLevel(B3), undefined)).toEqual({ targets: ['Bring 40% down', 'targets coming soon', 'targets coming soon'], short: ['40%', '?', '?'], cast: false });
    expect(starTargets(compileLevel(L1), undefined).targets[1]).toBe(`…in par (${L1.par})`);
  });
  it('B3\'s stars show from stars.json the moment they land (simulated drop-in)', () => {
    const cast = { ...B3, stars: { metric: 'collapse' as const, t2: 0.5, t3: 0.62, hash: compileLevel(B3).hash } };
    const [l] = doorLevels([cast], () => null);
    expect(l).toMatchObject({ cast: true, targets: ['Bring 40% down', '50% down', '62% down'] });
  });
  it('best play text', () => {
    expect(bestText(null)).toBe('Not played yet');
    expect(bestText(rec(2, { metric: 'collapse', value: 0.81, collapse: 0.81, plays: 3 }))).toBe('Best 81% down · 3 plays');
    expect(bestText(rec(1, { metric: 'score', value: 900, total: 900, collapse: 0.3 }))).toBe('Best 900 points · 1 play');
    expect(bestText(rec(3, { metric: 'collapse', collapse: 0.97, beatBot: true }))).toBe('Best 97% down · 1 play · beat the bot');
    expect(bestText(rec(2, { total: 340 }))).toBe('Best 340 points · 1 play');
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
    const mk = (s: Array<0 | 1 | null>) => s.map((x, i) => ({ id: `B${i}`, name: '', blocks: 0, rack: '', targets: ['', '', ''] as [string, string, string], short: ['', '', ''] as [string, string, string], cast: true, custom: false, best: x === null ? null : rec(x) }));
    expect(nextLevel(mk([1, null, null]))).toBe(1);
    expect(nextLevel(mk([1, 0, null]))).toBe(1);
    expect(nextLevel(mk([1, 1, 1]))).toBe(0);
  });
  it('markup: a card per level marking earned stars, the next and the loaded one, every action wired', () => {
    const levels = doorLevels(LEVELS, (id) => (id === 'L1' ? rec(2) : null));
    const html = doorHtml({ levels, current: 0, settings: DEFAULT_SETTINGS, howTo: true });
    expect(html.match(/class="card[ "]/g)).toHaveLength(5);
    expect(html).toContain('class="card current" data-act="level" data-arg="0"');
    expect(html).toContain('class="card next" data-act="level" data-arg="1"');
    expect(html).toContain(`Play · ${LEVELS[1]!.name}`);
    expect(html).toContain(`Back to ${LEVELS[0]!.name}`);
    expect(html.match(/<li class="got/g)).toHaveLength(2);
    expect(html).toContain('<span class="earned">★★</span><span class="unearned">☆</span>');
    for (const act of ['how', 'sound', 'look', 'sharp', 'camera', 'reset', 'close']) expect(html).toContain(`data-act="${act}"`);
    expect(html).toContain('class="how"');
    expect(doorHtml({ levels, current: -1, settings: DEFAULT_SETTINGS, howTo: false })).not.toContain('data-act="close"');
    // Back to the level is the Play button already when the next level is the loaded one.
    expect(doorHtml({ levels, current: 1, settings: DEFAULT_SETTINGS, howTo: false })).not.toContain('data-act="close"');
  });
  it('an uncast level shows one row for two and three stars', () => {
    const html = doorHtml({ levels: doorLevels([B3], () => null), current: 0, settings: DEFAULT_SETTINGS, howTo: false });
    expect(html.match(/<li /g)).toHaveLength(2);
    expect(html.match(/targets coming soon/g)).toHaveLength(1);
  });
  it('escapes level text', () => {
    const [l] = doorLevels([{ ...L1, name: '<b>x</b>' }], () => null);
    expect(doorHtml({ levels: [l!], current: 0, settings: DEFAULT_SETTINGS, howTo: false })).toContain('&#60;b&#62;x&#60;/b&#62;');
  });
});

describe('settings', () => {
  it('parse field by field, defaults for anything bad', () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('nope')).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings('{"sound":false,"look":"nope","sharp":3}')).toEqual({ ...DEFAULT_SETTINGS, sound: false });
    expect(parseSettings('{"look":"real","sharp":1}')).toEqual({ sound: true, look: 'real', sharp: 1, camera: 'still' });
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
    const html = (camera: 'still' | 'dynamic') => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, camera }, howTo: false });
    expect(html('still')).toContain('data-act="camera" data-arg="still" class="on"');
    expect(html('dynamic')).toContain('data-act="camera" data-arg="dynamic" class="on"');
  });
  it('URL keys: sound=on|off, sharp=1|2, look (checked by the page); bad values refused', () => {
    expect(urlSettings(q('sound=off&sharp=1&look=candy'))).toEqual({ sound: false, sharp: 1, look: 'candy' });
    expect(() => urlSettings(q('sound=0'))).toThrow(/sound must be on or off: 0/);
    expect(() => urlSettings(q('sharp=3'))).toThrow(/sharp must be 1 or 2: 3/);
  });
  it('the URL wins for the visit; a change is stored and replaces the URL\'s say on that field', () => {
    const kv = memoryKeyValue({ [SETTINGS_KEY]: '{"look":"real"}' });
    const s = new SettingsStore(kv, q('look=candy&sound=off'));
    expect(s.current).toEqual({ sound: false, look: 'candy', sharp: 2, camera: 'still' });
    expect(s.set({ look: 'hazy' })).toEqual({ sound: false, look: 'hazy', sharp: 2, camera: 'still' });
    expect(JSON.parse(kv.getItem(SETTINGS_KEY)!)).toEqual({ sound: true, look: 'hazy', sharp: 2, camera: 'still' });
    expect(new SettingsStore(kv).current).toEqual({ sound: true, look: 'hazy', sharp: 2, camera: 'still' });
  });
  it('storage that throws keeps settings in memory', () => {
    const bad = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); }, removeItem: () => {} };
    const s = new SettingsStore(bad);
    expect(s.set({ sound: false }).sound).toBe(false);
  });
});

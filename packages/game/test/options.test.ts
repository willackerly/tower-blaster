// The option registry's own rules (O4, docs/design/options.md): every module is listed once, names
// are unique, the parts hang together, and the door's buttons change what they did before the registry.
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { OPTIONS } from '../src/options/index.ts';
import { FEEL_OPTIONS, SETTING_OPTIONS } from '../src/options/registry.ts';
import { DEFAULT_FEEL, paceFeel } from '../src/pacing.ts';
import { DEFAULT_SETTINGS, doorChange, settingRows, settingUrlKeys, type Settings } from '../src/settings.ts';

const dir = new URL('../src/options/', import.meta.url);
const unique = (xs: readonly string[]) => expect(new Set(xs).size, xs.join(' ')).toBe(xs.length);

describe('the option registry', () => {
  it('lists every option module once, and each has a feel part or a setting part', () => {
    const modules = readdirSync(dir).filter((f) => f.endsWith('.ts') && !['option.ts', 'index.ts', 'registry.ts'].includes(f));
    const index = readFileSync(new URL('index.ts', dir), 'utf8');
    for (const m of modules) expect(index, `options/${m} is not imported in options/index.ts`).toContain(`from './${m}'`);
    expect(OPTIONS.length).toBe(modules.length);
    expect(new Set(OPTIONS).size).toBe(OPTIONS.length);
    for (const o of OPTIONS) expect('feel' in o || 'setting' in o).toBe(true);
  });

  it('merges by union, so two branches that each add an option do not conflict', () => {
    expect(readFileSync(new URL('../../../.gitattributes', import.meta.url), 'utf8')).toMatch(/^packages\/game\/src\/options\/index\.ts merge=union$/m);
  });

  it('names each field, URL key, scene key and door act once', () => {
    unique(FEEL_OPTIONS.map((o) => o.field));
    unique(FEEL_OPTIONS.map((o) => o.url));
    unique(FEEL_OPTIONS.flatMap((o) => (o.scene ? [o.scene.key] : [])));
    unique(SETTING_OPTIONS.map((o) => o.field));
    unique(SETTING_OPTIONS.map((o) => o.door.act));
    for (const o of FEEL_OPTIONS) expect(o.url, o.field).toMatch(/^keystone\.[a-z]+$/);
  });

  it('a panel control needs a scene key (its name), and its kind matches the value', () => {
    for (const o of FEEL_OPTIONS) {
      if (!o.panel) continue;
      expect(o.scene, o.field).toBeDefined();
      expect(o.scene!.json, o.field).toBe(o.panel.choices ? 'string' : typeof o.default);
    }
    for (const o of FEEL_OPTIONS) if (o.scene) expect(typeof o.default, o.field).toBe(o.scene.json);
  });

  it('each default reads back from its own URL text, and every choice a panel offers is a value it takes', () => {
    for (const o of FEEL_OPTIONS) {
      expect(o.parse(o.write(o.default)), o.field).toEqual(o.default);
      o.check?.(o.default);
      for (const [v] of o.panel?.choices ?? []) expect(paceFeel(new URLSearchParams({ [o.url]: v }))[o.field as keyof typeof DEFAULT_FEEL], o.field).toBe(v);
    }
  });

  it('a setting drives only feel fields that exist, with values they take, and each door choice is a value it stores', () => {
    for (const s of SETTING_OPTIONS) {
      expect(s.stored(s.default), s.field).toEqual(s.default);
      for (const f of s.drives?.fields ?? []) expect(Object.keys(DEFAULT_FEEL), s.field).toContain(f);
      const door = s.door;
      if ('choices' in door) for (const c of door.choices) {
        expect(s.stored(c.value), `${s.field} ${c.arg}`).toEqual(c.value);
        if (s.drives) { const to = s.drives.feel(c.value); expect(Object.keys(to).sort()).toEqual([...s.drives.fields].sort()); }
      }
    }
    expect(settingUrlKeys('sound')).toEqual(['sound']);
    expect(settingUrlKeys('layout')).toEqual(['keystone.hud', 'keystone.card', 'keystone.carddelay']);
  });

  it('one door row per setting, in order', () => {
    const rows = settingRows(DEFAULT_SETTINGS, { detected: null, esc: (s) => s });
    expect(rows.length).toBe(SETTING_OPTIONS.length);
    rows.forEach((r, i) => expect(r).toContain(`data-act="${SETTING_OPTIONS[i]!.door.act}"`));
  });

  it("the door's buttons change what door-page.ts's switch changed (before the registry)", () => {
    const now: Settings = { ...DEFAULT_SETTINGS, sound: true };
    // [act, arg, the change door-page.ts made at 1d7158e]
    const cases: [string, string, Partial<Settings>][] = [
      // Sound was one toggle ('' flipped it); PT37 made it an On/Off pair.
      ['sound', 'on', { sound: true }], ['sound', 'off', { sound: false }],
      ['look', 'hazy', { look: 'hazy' }], ['look', 'real', { look: 'real' }], ['look', 'candy', { look: 'candy' }],
      ['sharp', '1', { sharp: 1 }], ['sharp', '2', { sharp: 2 }],
      ['quality', 'auto', { quality: 'auto' }], ['quality', 'high', { quality: 'high' }], ['quality', 'mid', { quality: 'mid' }], ['quality', 'low', { quality: 'low' }],
      ['camera', 'still', { camera: 'still' }], ['camera', 'dynamic', { camera: 'dynamic' }],
      ['rapid', 'on', { rapid: true }], ['rapid', 'off', { rapid: false }],
      ['duelview', 'on', { duelView: true }], ['duelview', 'off', { duelView: false }],
      ['handoff', 'on', { handoff: true }], ['handoff', 'off', { handoff: false }],
      ['duellead', 'on', { duelLead: true }], ['duellead', 'off', { duelLead: false }],
      ['launch', 'high', { launch: 'high' }], ['launch', 'level', { launch: 'level' }],
      ['marks', 'on', { marks: true }], ['marks', 'off', { marks: false }],
      ['view', 'goals', { view: 'goals' }], ['view', 'classic', { view: 'classic' }],
      ['impact', 'on', { impact: true }], ['impact', 'off', { impact: false }],
      ['xray', 'off', { xray: 'off' }], ['xray', 'auto', { xray: 'auto' }], ['xray', 'on', { xray: 'on' }],
      ['layout', 'docked', { layout: 'docked' }], ['layout', 'classic', { layout: 'classic' }],
    ];
    for (const [act, arg, want] of cases) expect(doorChange(act, arg, now), `${act} ${arg}`).toEqual(want);
    expect(doorChange('sound', '', { ...now, sound: false })).toBeNull(); // a pair now: a click names its side
    // Every button the door draws is one of these, and nothing else on the door is a setting.
    const html = settingRows(DEFAULT_SETTINGS, { detected: 'mid', esc: (s) => s }).join('');
    const drawn = [...html.matchAll(/data-act="([a-z]+)"(?: data-arg="([^"]*)")?/g)].map((m) => `${m[1]} ${m[2] ?? ''}`);
    expect(drawn.sort()).toEqual(cases.map(([a, g]) => `${a} ${g}`).sort());
    for (const act of ['level', 'close', 'how', 'howmode', 'advanced', 'developer', 'trials', 'reset', 'reset-yes', 'reset-no', 'duel', undefined]) expect(doorChange(act, '', now)).toBeNull();
    expect(doorChange('quality', 'ultra', now)).toBeNull();
  });
});

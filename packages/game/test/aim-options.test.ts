// The three options of PT1 and PT14 (options/openview.ts, impact.ts, xray.ts): the opening view, the impact
// marker and the hidden-goals x-ray. Each as a URL key (read, refused, written back only off its default) and as
// a setting (stored, shown on the door, in effect unless the URL says otherwise).
import { describe, expect, it } from 'vitest';
import { doorHtml } from '../src/door.ts';
import { DEFAULT_FEEL, paceFeel, writePaceFeel } from '../src/pacing.ts';
import { DEFAULT_SETTINGS, parseSettings, settingFeel, settingUrlKeys } from '../src/settings.ts';

const q = (s: string) => new URLSearchParams(s);
const written = (patch: object) => { const w = new URLSearchParams(); writePaceFeel({ ...DEFAULT_FEEL, ...patch }, w); return w.toString(); };
const door = (patch: object) => doorHtml({ levels: [], current: -1, settings: { ...DEFAULT_SETTINGS, ...patch }, howTo: false, advanced: true, developer: true });

describe('the opening view, the impact marker and hidden goals as URL keys', () => {
  it('defaults: the goals view, the marker on, the x-ray off', () => {
    expect(DEFAULT_FEEL).toMatchObject({ view: 'goals', impact: true, xray: 'off' });
    expect(paceFeel(q(''))).toMatchObject({ view: 'goals', impact: true, xray: 'off' });
    expect(written({})).toBe('');
  });

  it('keystone.view: goals or classic, anything else refused; written only when classic', () => {
    expect(paceFeel(q('keystone.view=classic'))).toEqual({ ...DEFAULT_FEEL, view: 'classic' });
    expect(() => paceFeel(q('keystone.view=top'))).toThrow(/keystone.view must be goals or classic: top/);
    expect(written({ view: 'classic' })).toBe('keystone.view=classic');
  });

  it('keystone.impact: 0 or 1; written only when off', () => {
    expect(paceFeel(q('keystone.impact=0'))).toEqual({ ...DEFAULT_FEEL, impact: false });
    expect(() => paceFeel(q('keystone.impact=yes'))).toThrow(/keystone.impact must be 0 or 1: yes/);
    expect(written({ impact: false })).toBe('keystone.impact=0');
  });

  it('keystone.xray: auto, on or off; written only when not off', () => {
    expect(paceFeel(q('keystone.xray=on'))).toEqual({ ...DEFAULT_FEEL, xray: 'on' });
    expect(paceFeel(q('keystone.xray=auto'))).toEqual({ ...DEFAULT_FEEL, xray: 'auto' });
    expect(() => paceFeel(q('keystone.xray=1'))).toThrow(/keystone.xray must be auto, on, off: 1/);
    expect(written({ xray: 'auto' })).toBe('keystone.xray=auto');
    expect(written({ xray: 'off' })).toBe('');
  });
});

describe('the Opening view, Impact marker and Hidden goals settings', () => {
  it('defaults, and settings stored before them open on the defaults; only a valid value is taken', () => {
    expect(DEFAULT_SETTINGS).toMatchObject({ view: 'goals', impact: true, xray: 'off' });
    expect(parseSettings('{"look":"real"}')).toMatchObject({ view: 'goals', impact: true, xray: 'off' });
    expect(parseSettings('{"view":"classic","impact":false,"xray":"auto"}')).toEqual({ ...DEFAULT_SETTINGS, view: 'classic', impact: false, xray: 'auto' });
    expect(parseSettings('{"view":"top","impact":"off","xray":true}')).toEqual(DEFAULT_SETTINGS);
  });

  it('each sets its feel field unless the URL says it; a change drops its URL key', () => {
    const at = (field: string, search: string, v: unknown) => { const u = q(search); return settingFeel(field, paceFeel(u), u, v); };
    expect(at('view', '', 'classic')).toEqual({ view: 'classic' });
    expect(at('view', 'keystone.view=goals', 'classic')).toEqual({ view: 'goals' });
    expect(at('impact', '', false)).toEqual({ impact: false });
    expect(at('impact', 'keystone.impact=1', false)).toEqual({ impact: true });
    expect(at('xray', '', 'on')).toEqual({ xray: 'on' });
    expect(at('xray', 'keystone.xray=off', 'on')).toEqual({ xray: 'off' });
    expect([settingUrlKeys('view'), settingUrlKeys('impact'), settingUrlKeys('xray')]).toEqual([['keystone.view'], ['keystone.impact'], ['keystone.xray']]);
  });

  it('the door shows each with the chosen button lit, after Stone marks (under Developer settings since PT37)', () => {
    for (const v of ['goals', 'classic'] as const) expect(door({ view: v })).toContain(`data-act="view" data-arg="${v}" class="on"`);
    expect(door({ impact: true })).toContain('data-act="impact" data-arg="on" class="on"');
    expect(door({ impact: false })).toContain('data-act="impact" data-arg="off" class="on"');
    for (const x of ['auto', 'on', 'off'] as const) expect(door({ xray: x })).toContain(`data-act="xray" data-arg="${x}" class="on"`);
    const html = door({}), at = (act: string) => html.indexOf(`data-act="${act}"`);
    expect(at('marks')).toBeLessThan(at('view'));
    expect(at('view')).toBeLessThan(at('impact'));
    expect(at('impact')).toBeLessThan(at('xray'));
  });
});

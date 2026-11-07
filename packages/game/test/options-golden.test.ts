// O4's golden test (docs/design/options.md): what every game option does today, recorded from main
// at 1d7158e before the options moved to one module each, so the move can be checked to change
// nothing. Outputs live in golden/options-golden.json and inputs in golden/options-cases.ts; never
// regenerate the outputs. An option added later is not in the record: each comparison takes the
// recorded fields, keys and rows only, so a new option leaves this file and its record alone.
//
// Deliberate changes since the record, each edited into the record by hand (never regenerated), with its reason:
//   - 2026-11-07, PT37 (agent playtest 2, J1 #19): the Sound row is an On/Off pair; it was one toggle reading "On" or
//     "Off", which the judges read as a label with no other side. The four recorded Sound rows were edited to the pair.
//   - 2026-11-07, PT37 (J2 #19): Advanced settings shows six rows and puts the rest under a Developer settings
//     disclosure. The rows are rendered with it open and compared in the registry's order (SETTING_OPTIONS), which
//     the door keeps within each part; their markup is unchanged.
import { describe, expect, it } from 'vitest';
import { doorHtml } from '../src/door.ts';
import { SETTING_OPTIONS } from '../src/options/registry.ts';
import { checkPaceFeel, DEFAULT_FEEL, paceFeel, writePaceFeel } from '../src/pacing.ts';
import * as S from '../src/settings.ts';
import { CHECK_PATCHES, FEEL_SEARCHES, FLIPPED_FEEL_SEARCH, FLIPPED_SETTINGS, STORED, URL_SETTINGS } from './golden/options-cases.ts';
import golden from './golden/options-golden.json' with { type: 'json' };

type Obj = Record<string, unknown>;
/** o's fields that the record has, in the record's order. */
const pick = (o: object, like: object): Obj => Object.fromEntries(Object.keys(like).map((k) => [k, (o as Obj)[k]]));
const run = <T>(f: () => T): { ok: T } | { error: string } => { try { return { ok: f() }; } catch (e) { return { error: (e as Error).message }; } };
/** Whether `want` appears in `have` in order (other entries may sit between). */
const subsequence = (want: readonly string[], have: readonly string[]) => { let i = 0; for (const h of have) if (h === want[i]) i++; return i === want.length; };
const doorRows = (html: string) => html.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('<span class="group">'));
/** Rows back in the registry's order (the door shows the player's rows, then the Developer ones, each part in this order). */
const actOf = (row: string) => SETTING_OPTIONS.findIndex((o) => row.includes(`data-act="${o.door.act}"`));
const inListOrder = (rows: readonly string[]) => [...rows].sort((a, b) => actOf(a) - actOf(b));

describe('game options, as recorded before the registry (O4)', () => {
  it('the feel defaults, field by field and in order', () => {
    expect(pick(DEFAULT_FEEL, golden.DEFAULT_FEEL)).toEqual(golden.DEFAULT_FEEL);
    expect(Object.keys(DEFAULT_FEEL).filter((k) => golden.feelKeyOrder.includes(k))).toEqual(golden.feelKeyOrder);
    expect(pick(paceFeel(new URLSearchParams()), golden.DEFAULT_FEEL)).toEqual(golden.DEFAULT_FEEL);
  });

  it('every keystone.* key: read, refused with the same words, and written back as it was', () => {
    expect(FEEL_SEARCHES.length).toBe(golden.feel.length);
    FEEL_SEARCHES.forEach((search, i) => {
      const want = golden.feel[i]!;
      expect(want.search).toBe(search);
      const got = run(() => paceFeel(new URLSearchParams(search)));
      if ('error' in want) { expect(got, search).toEqual({ error: want.error }); return; }
      if (!('ok' in got)) throw new Error(`${search}: ${got.error}`);
      expect(pick(got.ok, want.feel!), search).toEqual(want.feel);
      const q = new URLSearchParams();
      writePaceFeel(got.ok, q);
      expect(q.toString(), search).toBe(want.written);
      expect(pick(paceFeel(q), want.feel!), search).toEqual(want.feel);
    });
  });

  it('every feel off its default at once: the URL in the same order', () => {
    const f = paceFeel(new URLSearchParams(FLIPPED_FEEL_SEARCH));
    expect(pick(f, golden.flipped.feel)).toEqual(golden.flipped.feel);
    const q = new URLSearchParams();
    writePaceFeel(f, q);
    expect(q.toString()).toBe(golden.flipped.written);
  });

  it('checkPaceFeel refuses what it refused', () => {
    expect(CHECK_PATCHES.length).toBe(golden.check.length);
    CHECK_PATCHES.forEach((patch, i) => {
      const got = run(() => checkPaceFeel({ ...DEFAULT_FEEL, ...patch } as typeof DEFAULT_FEEL));
      expect('error' in got ? got.error : null, JSON.stringify(patch)).toBe(golden.check[i]!.error);
    });
  });

  it('the settings defaults and the stored settings, field by field', () => {
    expect(S.SETTINGS_KEY).toBe(golden.SETTINGS_KEY);
    expect(pick(S.DEFAULT_SETTINGS, golden.DEFAULT_SETTINGS)).toEqual(golden.DEFAULT_SETTINGS);
    expect(STORED.length).toBe(golden.stored.length);
    STORED.forEach((text, i) => {
      expect(golden.stored[i]!.text).toBe(text);
      expect(pick(S.parseSettings(text), golden.stored[i]!.settings), String(text)).toEqual(golden.stored[i]!.settings);
    });
  });

  it("the URL's say over settings (look, sound, sharp, quality)", () => {
    expect(URL_SETTINGS.length).toBe(golden.urls.length);
    URL_SETTINGS.forEach((search, i) => {
      const want = golden.urls[i]!;
      expect(want.search).toBe(search);
      expect(run(() => S.urlSettings(new URLSearchParams(search))), search).toEqual('error' in want ? { error: want.error } : { ok: want.ok });
    });
  });

  it('a setting gives way to its URL keys, key by key, and names the keys it drops', () => {
    const fns: Record<string, (f: typeof DEFAULT_FEEL, q: URLSearchParams, v: never) => object> = {
      camera: S.cameraFeel, rapid: S.rapidFeel, duelView: S.turnViewFeel, handoff: S.handoffFeel, launch: S.launchFeel, marks: S.marksFeel,
    };
    for (const c of golden.settingFeel) {
      const q = new URLSearchParams(c.search);
      const f = run(() => paceFeel(q));
      expect(fns[c.setting]!('ok' in f ? f.ok : DEFAULT_FEEL, q, c.value as never), `${c.setting}=${c.value} ${c.search}`).toEqual(c.out);
    }
    const keys = { CAMERA_KEYS: S.CAMERA_KEYS, RAPID_KEYS: S.RAPID_KEYS, TURN_VIEW_KEYS: S.TURN_VIEW_KEYS, HANDOFF_KEYS: S.HANDOFF_KEYS, LAUNCH_KEYS: S.LAUNCH_KEYS, MARKS_KEYS: S.MARKS_KEYS };
    expect(keys).toEqual(golden.keys);
  });

  it("the door's Advanced settings rows, markup and order", () => {
    const settings: Record<string, S.Settings> = { default: S.DEFAULT_SETTINGS, flipped: { ...S.DEFAULT_SETTINGS, ...FLIPPED_SETTINGS } as S.Settings, candy: { ...S.DEFAULT_SETTINGS, look: 'candy', quality: 'mid', sharp: 2 } };
    for (const c of golden.doorCases) {
      const rows = inListOrder(doorRows(doorHtml({ levels: [], current: -1, settings: settings[c.settings]!, howTo: false, advanced: true, developer: true, detected: c.detected as never })));
      expect(subsequence(c.rows, rows), `${c.settings} ${c.detected}:\n${rows.join('\n')}`).toBe(true);
    }
  });
});

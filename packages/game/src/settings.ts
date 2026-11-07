// The player's settings (roadmap G7: sound and quality), kept in the browser beside progress. Each is an
// option with a setting part in ./options (O4, docs/design/options.md): its module says its values, its
// default, its door row, the URL keys that say it for a visit and the feel fields it sets. The URL wins
// for that visit, so every link and test opens as it says whatever the browser has stored. In the door's
// order: sound, look, camera (keystone.follow and keystone.shake), rapid (keystone.rapid), duelView
// (keystone.turnview), handoff (keystone.handoff), launch (keystone.launch), marks (keystone.marks), layout
// (keystone.hud, keystone.card, keystone.carddelay, layout.ts layoutOf), sharp, quality (?quality=).
import { feelOf, type PaceFeel, SETTING_OPTIONS, type Settings } from './options/registry.ts';
import type { DoorContext, SettingOption } from './options/option.ts';
import type { KeyValue } from './progress.ts';
import type { LaunchMode } from './aim.ts';
import type { CameraSetting } from './options/camera.ts';

export type { Settings } from './options/registry.ts';
export type { CameraSetting } from './options/camera.ts';
export { LOOK_CHOICES } from './options/look.ts';
export { QUALITY_CHOICES } from './options/quality.ts';

export const SETTINGS_KEY = 'tb.settings.v1';

/** Every setting's default: rapid fire on (Will, 2026-11-05), a duel's turn view and hand-over card, shots from high, stone marks (Will, 2026-11-06), the docked layout (PT3 and PT4), quality from the probe (P1). */
export const DEFAULT_SETTINGS: Settings = Object.fromEntries(SETTING_OPTIONS.map((o) => [o.field, o.default])) as Settings;

/** A setting part by its Settings field. */
export function settingOf(field: string): SettingOption {
  const s = SETTING_OPTIONS.find((o) => o.field === field);
  if (!s) throw new Error(`no setting ${field}`);
  return s;
}

/** Stored settings, field by field: a field that is absent or not valid takes its default. */
export function parseSettings(text: string | null): Settings {
  let o: Record<string, unknown> = {};
  try { const x = text ? JSON.parse(text) : {}; if (x && typeof x === 'object' && !Array.isArray(x)) o = x; } catch { /* defaults */ }
  return Object.fromEntries(SETTING_OPTIONS.map((s) => {
    const v = s.stored(o[s.field]);
    return [s.field, v === undefined ? s.default : v];
  })) as Settings;
}

/** The URL keys that say what a setting says, dropped from the page's URL when the player changes it. */
export function settingUrlKeys(field: string): readonly string[] {
  const s = settingOf(field);
  return s.urlKeys ?? (s.drives ? s.drives.fields.map((f) => feelOf(f).url) : [field]);
}

/**
 * The feel fields a setting sets, as in effect: each where its URL key says it (feel was read from that URL),
 * else what the setting's value means. Nothing for a setting that sets no feel.
 */
export function settingFeel(field: string, feel: PaceFeel, q: URLSearchParams, value: unknown): Partial<PaceFeel> {
  const d = settingOf(field).drives;
  if (!d) return {};
  const to = d.feel(value);
  return Object.fromEntries(d.fields.map((f) => [f, q.has(feelOf(f).url) ? (feel as Record<string, unknown>)[f] : to[f]])) as Partial<PaceFeel>;
}

/** Every setting's say over feel (main.ts, on load: q is the page's URL; on a change, an empty one). */
export function feelFromSettings(feel: PaceFeel, q: URLSearchParams, settings: Settings): void {
  for (const s of SETTING_OPTIONS) if (s.drives) Object.assign(feel, settingFeel(s.field, feel, q, (settings as Record<string, unknown>)[s.field]));
}

/** The URL's say over settings: ?look=, ?sound=on|off, ?sharp=1|2, ?quality=auto|high|mid|low (bad values are refused, as every game key is). */
export function urlSettings(q: URLSearchParams): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const s of SETTING_OPTIONS) {
    const v = s.url?.(q);
    if (v !== undefined) out[s.field] = v;
  }
  return out as Partial<Settings>;
}

/** The door's Advanced settings rows, in order (door.ts). */
export function settingRows(settings: Settings, ctx: DoorContext, part: 'player' | 'developer' | 'all' = 'all'): string[] {
  // PT37: the rows a player sees first (DoorRow.player), or the rest (the Developer settings disclosure), or all, in the list's order.
  return SETTING_OPTIONS.filter((s) => part === 'all' || (part === 'player') === (s.door.player === true)).map((s) => {
    const v = (settings as Record<string, unknown>)[s.field], r = s.door;
    const buttons = 'choices' in r
      ? r.choices.map((c) => `<button data-act="${r.act}" data-arg="${c.arg}" class="${c.value === v ? 'on' : ''}"${c.title === undefined ? '' : ` title="${c.title}"`}>${c.text}</button>`).join('')
      : r.buttons(v, ctx);
    return `<span class="group"><span class="lbl">${r.label}</span><span class="seg">${buttons}</span></span>`;
  });
}

/** What a door button (data-act, data-arg) changes, given the settings now; null when it is no setting's or names no value. */
export function doorChange(act: string | undefined, arg: string, settings: Settings): Partial<Settings> | null {
  const s = SETTING_OPTIONS.find((o) => o.door.act === act);
  if (!s) return null;
  const r = s.door, now = (settings as Record<string, unknown>)[s.field];
  const v = 'choices' in r ? r.choices.find((c) => c.arg === arg)?.value : r.click(arg, now);
  return v === undefined ? null : ({ [s.field]: v } as Partial<Settings>);
}

// The setting-to-feel pairs by name, as before the registry (O4 keeps them for their callers and tests).
export const CAMERA_KEYS = settingUrlKeys('camera');
export const RAPID_KEYS = settingUrlKeys('rapid');
export const LAUNCH_KEYS = settingUrlKeys('launch');
export const MARKS_KEYS = settingUrlKeys('marks');
export const TURN_VIEW_KEYS = settingUrlKeys('duelView');
export const HANDOFF_KEYS = settingUrlKeys('handoff');
export const cameraFeel = (feel: PaceFeel, q: URLSearchParams, camera: CameraSetting) => settingFeel('camera', feel, q, camera) as Pick<PaceFeel, 'follow' | 'shake'>;
export const rapidFeel = (feel: PaceFeel, q: URLSearchParams, rapid: boolean) => settingFeel('rapid', feel, q, rapid) as Pick<PaceFeel, 'rapid'>;
export const launchFeel = (feel: PaceFeel, q: URLSearchParams, launch: LaunchMode) => settingFeel('launch', feel, q, launch) as Pick<PaceFeel, 'launch'>;
export const marksFeel = (feel: PaceFeel, q: URLSearchParams, marks: boolean) => settingFeel('marks', feel, q, marks) as Pick<PaceFeel, 'marks'>;
export const turnViewFeel = (feel: PaceFeel, q: URLSearchParams, duelView: boolean) => settingFeel('duelView', feel, q, duelView) as Pick<PaceFeel, 'turnView'>;
export const handoffFeel = (feel: PaceFeel, q: URLSearchParams, handoff: boolean) => settingFeel('handoff', feel, q, handoff) as Pick<PaceFeel, 'handoff'>;

/** Settings on a KeyValue: stored ones under the URL's, saved on every change (memory only when storage throws). */
export class SettingsStore {
  private stored: Settings;
  private url: Partial<Settings>;
  constructor(private readonly kv: KeyValue, q: URLSearchParams = new URLSearchParams()) {
    let text: string | null = null;
    try { text = kv.getItem(SETTINGS_KEY); } catch { /* defaults */ }
    this.stored = parseSettings(text);
    this.url = urlSettings(q);
  }
  /** In effect now: the URL's for this visit where it says, else the stored. */
  get current(): Settings { return { ...this.stored, ...this.url }; }
  /** Change and store some settings. A change replaces the URL's say on that field too (the page drops the key from its URL). */
  set(change: Partial<Settings>): Settings {
    this.stored = parseSettings(JSON.stringify({ ...this.stored, ...change }));
    this.url = Object.fromEntries(Object.entries(this.url).filter(([k]) => !(k in change)));
    try { this.kv.setItem(SETTINGS_KEY, JSON.stringify(this.stored)); } catch { /* memory only */ }
    return this.current;
  }
}

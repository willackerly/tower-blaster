// The player's settings (roadmap G7: sound and quality), kept in the browser
// beside progress. Each one is also a URL key, and the URL wins for that visit,
// so every link and test opens as it says whatever the browser has stored:
//   sound: on | off            (the M key toggles it in play)
//   look:  hazy | real | candy (the URL's ?look=)
//   sharp: 2 | 1               (the most device pixels per CSS pixel the canvas draws; 1 halves the work on a 2x screen)
//   camera: still | dynamic    (dynamic: the camera follows the collapse and shakes on hits; the URL's say is
//                               keystone.follow and keystone.shake, one each, see cameraFeel)
//   rapid: true | false        (rapid fire: shoot before the last shot settles; on by default; the URL's say
//                               is keystone.rapid, see rapidFeel)
//   duelView: true | false     (a duel's turn view: the camera swings to the next player's side; on by default;
//                               the URL's say is keystone.turnview, see turnViewFeel)
//   handoff: true | false      (a duel's hand-over card between turns; on by default; the URL's say is
//                               keystone.handoff, see handoffFeel)
//   launch: high | level       (where shots leave from, aim.ts LaunchMode; high by default; the URL's say is
//                               keystone.launch, see launchFeel)
//   marks: true | false        (stone marks: a crosshair carved on blocks to bring down, a shield on blocks to
//                               keep, scene.ts markOf; on by default; the URL's say is keystone.marks, see marksFeel)
//   layout: docked | classic   (where the HUD and result card sit, layout.ts; docked by default; the URL's say
//                               is keystone.hud, keystone.card and keystone.carddelay, see layoutOf)
//   quality: auto | high | mid | low (the quality tier, quality.ts: auto takes the probe's on load; the URL's
//                               ?quality= for a visit; docs/game/quality-tiers.md)
import { LOOKS } from '@tb/render';
import { LAUNCH_MODES, type LaunchMode } from './aim.ts';
import { LAYOUT_SETTINGS, type LayoutSetting } from './layout.ts';
import type { PaceFeel } from './pacing.ts';
import { GAME_LOOK } from './params.ts';
import type { KeyValue } from './progress.ts';
import { QUALITY_SETTINGS, qualityParam, type QualitySetting } from './quality.ts';

export const SETTINGS_KEY = 'tb.settings.v1';

/** still: the camera moves only when the player moves it (the default since the 2026-11-02 playtest); dynamic: it follows and shakes too. */
export type CameraSetting = 'still' | 'dynamic';

export interface Settings { sound: boolean; look: string; sharp: 1 | 2; camera: CameraSetting; rapid: boolean; duelView: boolean; handoff: boolean; launch: LaunchMode; marks: boolean; layout: LayoutSetting; quality: QualitySetting }

/** Rapid fire on (Will, 2026-11-05: in Advanced settings, defaulting to on); a duel's turn view on (Will, 2026-11-06); shots from high (Will, 2026-11-06); stone marks on (Will, 2026-11-06); quality from the probe (P1, 2026-11-06); the docked layout (PT3 and PT4, 2026-11-06). */
export const DEFAULT_SETTINGS: Settings = { sound: true, look: GAME_LOOK, sharp: 2, camera: 'still', rapid: true, duelView: true, handoff: true, launch: 'high', marks: true, layout: 'docked', quality: 'auto' };

/** The quality choices the front door offers, in its order, with their names there. */
export const QUALITY_CHOICES: ReadonlyArray<{ quality: QualitySetting; label: string }> = [
  { quality: 'auto', label: 'Auto' },
  { quality: 'high', label: 'High' },
  { quality: 'mid', label: 'Medium' },
  { quality: 'low', label: 'Low' },
];

/** The looks the front door offers, in its order, with their names there. */
export const LOOK_CHOICES: ReadonlyArray<{ look: string; label: string }> = [
  { look: 'hazy', label: 'Maquette' },
  { look: 'real', label: 'Photoreal' },
  { look: 'candy', label: 'Candy' },
];

/** Stored settings, field by field: a field that is absent or not valid takes its default. */
export function parseSettings(text: string | null): Settings {
  let o: Record<string, unknown> = {};
  try { const x = text ? JSON.parse(text) : {}; if (x && typeof x === 'object' && !Array.isArray(x)) o = x; } catch { /* defaults */ }
  return {
    sound: typeof o.sound === 'boolean' ? o.sound : DEFAULT_SETTINGS.sound,
    look: typeof o.look === 'string' && LOOKS[o.look] ? o.look : DEFAULT_SETTINGS.look,
    sharp: o.sharp === 1 || o.sharp === 2 ? o.sharp : DEFAULT_SETTINGS.sharp,
    camera: o.camera === 'still' || o.camera === 'dynamic' ? o.camera : DEFAULT_SETTINGS.camera,
    rapid: typeof o.rapid === 'boolean' ? o.rapid : DEFAULT_SETTINGS.rapid,
    duelView: typeof o.duelView === 'boolean' ? o.duelView : DEFAULT_SETTINGS.duelView,
    handoff: typeof o.handoff === 'boolean' ? o.handoff : DEFAULT_SETTINGS.handoff,
    launch: (LAUNCH_MODES as readonly unknown[]).includes(o.launch) ? (o.launch as LaunchMode) : DEFAULT_SETTINGS.launch,
    marks: typeof o.marks === 'boolean' ? o.marks : DEFAULT_SETTINGS.marks,
    layout: (LAYOUT_SETTINGS as readonly unknown[]).includes(o.layout) ? (o.layout as LayoutSetting) : DEFAULT_SETTINGS.layout,
    quality: (QUALITY_SETTINGS as readonly unknown[]).includes(o.quality) ? (o.quality as QualitySetting) : DEFAULT_SETTINGS.quality,
  };
}

/** The URL keys that say what the camera setting says (cameraFeel), dropped from the URL when the setting changes. */
export const CAMERA_KEYS = ['keystone.follow', 'keystone.shake'] as const;

/**
 * The camera motions in effect: each of keystone.follow and keystone.shake where the URL says it (feel was read
 * from that URL), else the Camera setting's (dynamic: both on, still: both off).
 */
export function cameraFeel(feel: PaceFeel, q: URLSearchParams, camera: CameraSetting): Pick<PaceFeel, 'follow' | 'shake'> {
  const on = camera === 'dynamic';
  return { follow: q.has('keystone.follow') ? feel.follow : on, shake: q.has('keystone.shake') ? feel.shake : on };
}

/** The URL key that says what the Rapid fire setting says (rapidFeel), dropped from the URL when the setting changes. */
export const RAPID_KEYS = ['keystone.rapid'] as const;

/** Rapid fire in effect: keystone.rapid where the URL says it (feel was read from that URL), else the setting. */
export function rapidFeel(feel: PaceFeel, q: URLSearchParams, rapid: boolean): Pick<PaceFeel, 'rapid'> {
  return { rapid: q.has('keystone.rapid') ? feel.rapid : rapid };
}

/** The URL key that says what the Launch height setting says (launchFeel), dropped from the URL when the setting changes. */
export const LAUNCH_KEYS = ['keystone.launch'] as const;

/** Where shots leave from: keystone.launch where the URL says it (feel was read from that URL), else the setting. */
export function launchFeel(feel: PaceFeel, q: URLSearchParams, launch: LaunchMode): Pick<PaceFeel, 'launch'> {
  return { launch: q.has('keystone.launch') ? feel.launch : launch };
}

/** The URL key that says what the Stone marks setting says (marksFeel), dropped from the URL when the setting changes. */
export const MARKS_KEYS = ['keystone.marks'] as const;

/** Stone marks in effect: keystone.marks where the URL says it (feel was read from that URL), else the setting. */
export function marksFeel(feel: PaceFeel, q: URLSearchParams, marks: boolean): Pick<PaceFeel, 'marks'> {
  return { marks: q.has('keystone.marks') ? feel.marks : marks };
}

/** The URL key that says what the Duel turns setting says (turnViewFeel), dropped from the URL when the setting changes. */
export const TURN_VIEW_KEYS = ['keystone.turnview'] as const;

/** A duel's turn view in effect: keystone.turnview where the URL says it (feel was read from that URL), else the setting. */
export function turnViewFeel(feel: PaceFeel, q: URLSearchParams, duelView: boolean): Pick<PaceFeel, 'turnView'> {
  return { turnView: q.has('keystone.turnview') ? feel.turnView : duelView };
}

/** The URL key that says what the Hand-over setting says (handoffFeel), dropped from the URL when the setting changes. */
export const HANDOFF_KEYS = ['keystone.handoff'] as const;

/** A duel's hand-over card in effect: keystone.handoff where the URL says it (feel was read from that URL), else the setting. */
export function handoffFeel(feel: PaceFeel, q: URLSearchParams, handoff: boolean): Pick<PaceFeel, 'handoff'> {
  return { handoff: q.has('keystone.handoff') ? feel.handoff : handoff };
}

/** The URL's say over settings: ?look=, ?sound=on|off, ?sharp=1|2, ?quality=auto|high|mid|low (bad values are refused, as every game key is). */
export function urlSettings(q: URLSearchParams): Partial<Settings> {
  const out: Partial<Settings> = {};
  const look = q.get('look'), sound = q.get('sound'), sharp = q.get('sharp');
  if (look !== null) out.look = look; // checked by parseGameParams (lookName)
  if (sound !== null) {
    if (sound !== 'on' && sound !== 'off') throw new Error(`sound must be on or off: ${sound}`);
    out.sound = sound === 'on';
  }
  if (sharp !== null) {
    if (sharp !== '1' && sharp !== '2') throw new Error(`sharp must be 1 or 2: ${sharp}`);
    out.sharp = sharp === '1' ? 1 : 2;
  }
  const quality = qualityParam(q);
  if (quality !== null) out.quality = quality;
  return out;
}

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

// The player's settings (roadmap G7: sound and quality), kept in the browser
// beside progress. Each one is also a URL key, and the URL wins for that visit,
// so every link and test opens as it says whatever the browser has stored:
//   sound: on | off            (the M key toggles it in play)
//   look:  hazy | real | candy (the URL's ?look=)
//   sharp: 2 | 1               (the most device pixels per CSS pixel the canvas draws; 1 halves the work on a 2x screen)
import { LOOKS } from '@tb/render';
import { GAME_LOOK } from './params.ts';
import type { KeyValue } from './progress.ts';

export const SETTINGS_KEY = 'tb.settings.v1';

export interface Settings { sound: boolean; look: string; sharp: 1 | 2 }

export const DEFAULT_SETTINGS: Settings = { sound: true, look: GAME_LOOK, sharp: 2 };

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
  };
}

/** The URL's say over settings: ?look=, ?sound=on|off, ?sharp=1|2 (bad values are refused, as every game key is). */
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

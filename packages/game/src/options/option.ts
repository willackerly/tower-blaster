// One game option, declared once (O4, docs/design/options.md). An option may have a feel part (a
// PaceFeel field read from its keystone.* URL key, written back, carried in the viewer's scene file
// and shown in its Scene panel) and a setting part (a Settings field kept in the browser, shown in the
// door's Advanced settings, and in effect over the feel unless the URL says otherwise). pacing.ts and
// settings.ts derive their types, defaults, readers and writers from the list in ./index.ts; nothing
// else lists the options.
//
// Option modules import only leaf modules (aim, scene, frame-rate, quality, layout, @tb/*), never
// pacing.ts, settings.ts, params.ts or door.ts, which import the list: that would be a cycle.

/** The feel part: one PaceFeel field and its URL key. */
export interface FeelOption<F extends string = string, T = unknown> {
  /** The PaceFeel field. */
  readonly field: F;
  /** Its URL key, keystone.<name>. */
  readonly url: string;
  /** Its value when the URL does not say. */
  readonly default: T;
  /** A value present in the URL, or a refusal that names the key. */
  parse(text: string): T;
  /** The URL's text for a value (written only when it is off the default). */
  write(v: T): string;
  /** Throws unless v is a value this option takes (checkPaceFeel: the viewer's Scene panel can hold anything). */
  check?(v: T): void;
  /** Carried in the viewer's scene file under rules.<key>, as JSON of this kind; written when off the default, or always. */
  readonly scene?: { readonly key: string; readonly json: 'boolean' | 'number' | 'string'; readonly always?: boolean };
  /**
   * A control in the viewer's Scene panel (its name is the scene key, so scene is required): a checkbox for a
   * boolean, a number field (with these input attributes) for a number, a select of [value, text] choices for a string.
   */
  readonly panel?: { readonly label: string; readonly attrs?: string; readonly choices?: readonly (readonly [string, string])[] };
}

/** One button of a door row: its data-arg, the value it sets, its text and its title (HTML, not escaped). */
export interface DoorChoice<V> { readonly arg: string; readonly value: V; readonly text: string; readonly title?: string }

/** What a door row may know beyond its setting: the tier the load probe picked (quality.ts), if one ran. */
export interface DoorContext { readonly detected: string | null; readonly esc: (s: string) => string }

/** A row of the door's Advanced settings: a label and buttons, data-act="<act>" each. */
export type DoorRow<V> =
  | { readonly act: string; readonly label: string; readonly choices: readonly DoorChoice<V>[] }
  | { readonly act: string; readonly label: string; buttons(v: V, ctx: DoorContext): string; click(arg: string, v: V): V | undefined };

/** The setting part: one Settings field, stored in the browser and shown on the door. */
export interface SettingOption<S extends string = string, V = unknown> {
  /** The Settings field (and its key in the stored JSON). */
  readonly field: S;
  readonly default: V;
  /** A stored value, or undefined when it is absent or not valid (the default then). */
  stored(v: unknown): V | undefined;
  /** The URL's say over the setting for a visit (?look=, ?sound=...), or undefined; throws on a bad value. */
  url?(q: URLSearchParams): V | undefined;
  /** The PaceFeel fields this setting sets, each unless its own URL key says otherwise, and what it sets them to. */
  readonly drives?: { readonly fields: readonly string[]; feel(v: V): Readonly<Record<string, unknown>> };
  /** The URL keys dropped from the page's URL when the player changes this setting (default: the driven fields' keys, else the field). */
  readonly urlKeys?: readonly string[];
  readonly door: DoorRow<V>;
}

/** A game option: a feel part, a setting part, or both. */
export interface GameOption { readonly feel?: FeelOption; readonly setting?: SettingOption }

/** A 0-or-1 URL flag. */
export function flag<const F extends string>(o: Omit<FeelOption<F, boolean>, 'parse' | 'write'>): FeelOption<F, boolean> {
  return {
    ...o,
    parse(v) {
      if (v !== '0' && v !== '1') throw new Error(`${o.url} must be 0 or 1: ${v}`);
      return v === '1';
    },
    write: (v) => (v ? '1' : '0'),
  };
}

/** One of some words, read (and checked) by `of`, which throws with the option's own words (its type is of's). */
export function choice<const F extends string, T extends string>(o: Omit<FeelOption<F, T>, 'parse' | 'write' | 'check' | 'default'> & { default: NoInfer<T>; of(text: string): T }): FeelOption<F, T> {
  const { of, ...rest } = o;
  return { ...rest, parse: of, write: (v) => v, check: (v) => void of(v) };
}

/** A stored boolean. */
export const storedBoolean = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
/** A stored value that is one of `values`. */
export const storedOneOf = <V>(values: readonly V[]) => (v: unknown): V | undefined => ((values as readonly unknown[]).includes(v) ? (v as V) : undefined);

/** A door row of buttons that set an on/off setting. */
export function onOffRow(act: string, label: string, on: { text: string; title: string }, off: { text: string; title: string }): DoorRow<boolean> {
  return { act, label, choices: [{ arg: 'on', value: true, ...on }, { arg: 'off', value: false, ...off }] };
}

/** A feel part as written (its type names the field and the value: feelOption<'budgetMs', number>({...})). */
export const feelOption = <const F extends string, T>(o: FeelOption<F, T>): FeelOption<F, T> => o;
/** A setting part as written (settingOption<'launch', LaunchMode>({...})). */
export const settingOption = <const S extends string, V>(o: SettingOption<S, V>): SettingOption<S, V> => o;

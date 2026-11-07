// What the option list derives (O4, docs/design/options.md): the feel and setting parts in order,
// and the PaceFeel and Settings types. pacing.ts and settings.ts build on these.
import { OPTIONS } from './index.ts';
import type { FeelOption, SettingOption } from './option.ts';

type Option = (typeof OPTIONS)[number];
type FeelPart = Extract<Option, { feel: unknown }>['feel'];
type SettingPart = Extract<Option, { setting: unknown }>['setting'];

/** The sim's pace and the game's feel, one field per option with a feel part (each option's module says what it does). */
export type PaceFeel = { [P in FeelPart as P['field']]: P['default'] };
/** The player's settings, one field per option with a setting part. */
export type Settings = { [P in SettingPart as P['field']]: P['default'] };

/** The feel parts, in the URL's order. */
export const FEEL_OPTIONS: readonly FeelOption[] = OPTIONS.flatMap((o) => ('feel' in o ? [o.feel as FeelOption] : []));
/** The setting parts, in the door's order. */
export const SETTING_OPTIONS: readonly SettingOption[] = OPTIONS.flatMap((o) => ('setting' in o ? [o.setting as SettingOption] : []));
/** A feel part by its PaceFeel field. */
export const feelOf = (field: string): FeelOption => {
  const f = FEEL_OPTIONS.find((o) => o.field === field);
  if (!f) throw new Error(`no feel option ${field}`);
  return f;
};

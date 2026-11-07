// The Sound setting (O4: one module per option; docs/design/options.md). The M key toggles it in play.
import { type GameOption, settingOption, storedBoolean } from './option.ts';

/** Sound on or off; ?sound=on|off says it for a visit. */
export const sound = {
  setting: settingOption<'sound', boolean>({
    field: 'sound',
    default: true,
    stored: storedBoolean,
    url(q) {
      const v = q.get('sound');
      if (v === null) return undefined;
      if (v !== 'on' && v !== 'off') throw new Error(`sound must be on or off: ${v}`);
      return v === 'on';
    },
    door: {
      act: 'sound',
      label: 'Sound',
      buttons: (v) => `<button data-act="sound" class="${v ? 'on' : ''}">${v ? 'On' : 'Off'}</button>`,
      click: (_arg, v) => !v,
    },
  }),
} satisfies GameOption;

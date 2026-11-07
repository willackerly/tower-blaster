// The Sound setting (O4: one module per option; docs/design/options.md). The M key toggles it in play.
import { type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

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
    // On and Off as a pair (PT37, J1 #19: a lone button read as a label, "Sound: On", with no way to see the other side).
    door: { ...onOffRow('sound', 'Sound', { text: 'On', title: 'Impacts and collapses make a sound' }, { text: 'Off', title: 'Silent (the M key also toggles it in play)' }), player: true },
  }),
} satisfies GameOption;

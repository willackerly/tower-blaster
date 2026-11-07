// The Sharpness setting (O4: one module per option; docs/design/options.md): ?sharp=1|2 for a visit.
import { type GameOption, settingOption } from './option.ts';

/** The most device pixels per CSS pixel the canvas draws; 1 halves the work on a 2x screen. */
export const sharp = {
  setting: settingOption<'sharp', 1 | 2>({
    field: 'sharp',
    default: 2,
    stored: (v) => (v === 1 || v === 2 ? v : undefined),
    url(q) {
      const v = q.get('sharp');
      if (v === null) return undefined;
      if (v !== '1' && v !== '2') throw new Error(`sharp must be 1 or 2: ${v}`);
      return v === '1' ? 1 : 2;
    },
    door: { act: 'sharp', label: 'Sharpness', choices: [{ arg: '2', value: 2, text: 'Full' }, { arg: '1', value: 1, text: 'Fast' }] },
  }),
} satisfies GameOption;

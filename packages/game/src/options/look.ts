// The Look setting (O4: one module per option; docs/design/options.md): the URL's ?look= for a visit.
import { LOOKS } from '@tb/render';
import { type GameOption, settingOption } from './option.ts';

/** The game's look when the URL and the settings name none (params.ts re-exports it). */
export const GAME_LOOK = 'hazy';

/** The looks the front door offers, in its order, with their names there. */
export const LOOK_CHOICES: ReadonlyArray<{ look: string; label: string }> = [
  { look: 'hazy', label: 'Maquette' },
  { look: 'real', label: 'Photoreal' },
  { look: 'candy', label: 'Candy' },
];

/** The look, by its @tb/render LOOKS name: hazy (Maquette), real (Photoreal) or candy. */
export const look = {
  setting: settingOption<'look', string>({
    field: 'look',
    default: GAME_LOOK,
    stored: (v) => (typeof v === 'string' && LOOKS[v] ? v : undefined),
    // Checked by parseGameParams (lookName), as every game key is.
    url: (q) => q.get('look') ?? undefined,
    door: { act: 'look', label: 'Look', choices: LOOK_CHOICES.map((c) => ({ arg: c.look, value: c.look, text: c.label })) },
  }),
} satisfies GameOption;

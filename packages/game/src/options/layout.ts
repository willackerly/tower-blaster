// The Layout setting (O4: one module per option; docs/design/options.md): where the HUD and the result card
// sit (layout.ts). Its URL keys, keystone.hud, keystone.card and keystone.carddelay, are read by layoutOf.
import { LAYOUT_KEYS, LAYOUT_SETTINGS, type LayoutSetting } from '../layout.ts';
import { type GameOption, settingOption, storedOneOf } from './option.ts';

/** Docked by default (PT3 and PT4, 2026-11-06), or classic. */
export const layout = {
  setting: settingOption<'layout', LayoutSetting>({
    field: 'layout',
    default: 'docked',
    stored: storedOneOf(LAYOUT_SETTINGS),
    urlKeys: LAYOUT_KEYS,
    door: {
      act: 'layout',
      label: 'Layout',
      player: true,
      choices: [
        { arg: 'docked', value: 'docked', text: 'Docked', title: "On a phone the HUD docks to the screen's edges; the result card waits a moment after the round, then docks aside so the collapse stays in view" },
        { arg: 'classic', value: 'classic', text: 'Classic', title: 'One HUD panel at the top left, and the result card in the middle as soon as the round ends' },
      ],
    },
  }),
} satisfies GameOption;

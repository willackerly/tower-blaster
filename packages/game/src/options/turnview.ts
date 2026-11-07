// The keystone.turnview option and the Duel turns setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * A duel's turn view (duel-view.ts): when the turn passes, the camera swings to the middle of the next player's
 * side. On by default (Will, 2026-11-06), the one camera move the player does not make; keystone.turnview=0 (or
 * the door's Duel turns setting, duelView) leaves the camera where it is. Nothing outside a duel reads it.
 */
export const turnView = {
  feel: flag({
    field: 'turnView',
    url: 'keystone.turnview',
    default: true,
  }),
  setting: settingOption<'duelView', boolean>({
    field: 'duelView',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['turnView'], feel: (v) => ({ turnView: v }) },
    door: onOffRow('duelview', 'Duel turns', { text: 'Turn the view', title: 'The camera turns to the side whose turn it is' }, { text: 'Leave it', title: 'The camera stays where the last player left it' }),
  }),
} satisfies GameOption;

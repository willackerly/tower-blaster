// The keystone.handoff option and the Hand-over setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * A duel's hand-over card (PT5, agent playtest 1: no "pass the device" moment): when the turn passes, a band in
 * the next player's ink says whose turn it is, over the turn view's swing, until a tap. On by default;
 * keystone.handoff=0 (or the door's Hand-over setting) goes straight on with a banner, as before.
 */
export const handoff = {
  feel: flag({
    field: 'handoff',
    url: 'keystone.handoff',
    default: true,
  }),
  setting: settingOption<'handoff', boolean>({
    field: 'handoff',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['handoff'], feel: (v) => ({ handoff: v }) },
    door: onOffRow('handoff', 'Hand-over', { text: 'Card', title: 'Between duel turns a card says whose turn it is: tap it to start' }, { text: 'Skip', title: 'The next turn starts at once, with a banner' }),
  }),
} satisfies GameOption;

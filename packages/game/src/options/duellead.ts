// The keystone.lead option and the Duel aim setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * A duel table's launcher lead (DuelDef.lead; PT34): the launcher stands that far round the ring from the view, to its
 * right, so the shot's arc crosses the screen instead of running straight away from the eye. On D2, whose shared tower
 * stands at the ring's centre, the arc was a vertical stack of dots (4% of the width); 20 deg round it spans about 45%.
 * On by default; keystone.lead=0 (or the door's Duel aim setting) puts the launcher behind the camera, as everywhere else.
 * Nothing outside a duel with a lead reads it.
 */
export const duelLead = {
  feel: flag({
    field: 'duelLead',
    url: 'keystone.lead',
    default: true,
  }),
  setting: settingOption<'duelLead', boolean>({
    field: 'duelLead',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['duelLead'], feel: (v) => ({ duelLead: v }) },
    door: onOffRow('duellead', 'Duel aim', { text: 'From the side', title: 'On a table with a lead (Heraldry) the launcher stands to the right of your view, so you see the shot cross' }, { text: 'From behind', title: 'The launcher stands behind the camera, as in every other mode' }),
  }),
} satisfies GameOption;

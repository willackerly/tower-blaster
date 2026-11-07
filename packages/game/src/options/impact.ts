// The keystone.impact option and the Impact marker setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * The impact marker (PT14, docs/game/aim-clarity.md): a reticle on the face the aimed shot's flight first touches
 * (aim.ts arcContact), for every shot, not only a blast weapon's zone. On by default; keystone.impact=0 off. The
 * Impact marker setting says it unless the URL does; read live, at each aim.
 */
export const impact = {
  feel: flag({
    field: 'impact',
    url: 'keystone.impact',
    default: true,
    scene: { key: 'impact', json: 'boolean' },
    panel: { label: 'impact marker where the aimed shot will hit' },
  }),
  setting: settingOption<'impact', boolean>({
    field: 'impact',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['impact'], feel: (v) => ({ impact: v }) },
    door: onOffRow('impact', 'Impact marker', { text: 'On', title: "A mark on the face your shot's flight will meet first" }, { text: 'Off', title: 'Only the dotted flight' }),
  }),
} satisfies GameOption;

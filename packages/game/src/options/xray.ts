// The keystone.xray option and the Hidden goals setting (O4: one module per option; docs/design/options.md).
import { choice, type GameOption, settingOption, storedOneOf } from './option.ts';

/** When the objectives show through what hides them (PaceFeel.xray). */
export type XrayMode = 'auto' | 'on' | 'off';
export const XRAY_MODES: readonly XrayMode[] = ['auto', 'on', 'off'];

/** keystone.xray: auto, on or off (absent: off; the look review, docs/game/opening-view.md). */
export function xrayMode(text: string | null): XrayMode {
  if (text === null) return 'off';
  if (!(XRAY_MODES as readonly string[]).includes(text)) throw new Error(`keystone.xray must be ${XRAY_MODES.join(', ')}: ${text}`);
  return text as XrayMode;
}

/**
 * The objectives through what hides them (Renderer.xray, PT1): a hidden crown's or heritage block's faces drawn
 * faintly with an outline in their colour. 'auto' shows it on city-scale levels (scene.ts xrayOn: CITY_BODIES or
 * more, with crowns or heritage), 'on' everywhere, 'off' never. Off by default: the look review said no to this
 * look as a default (PT1b, docs/game/opening-view.md). The Hidden goals setting says it unless the URL does; read
 * live, each frame.
 */
export const xray = {
  feel: choice({
    field: 'xray',
    url: 'keystone.xray',
    default: 'off',
    of: xrayMode,
    scene: { key: 'xray', json: 'string' },
    panel: { label: 'crowns and heritage through what hides them', choices: [['off', 'never'], ['auto', 'on the city levels'], ['on', 'always']] },
  }),
  setting: settingOption<'xray', XrayMode>({
    field: 'xray',
    default: 'off',
    stored: storedOneOf(XRAY_MODES),
    drives: { fields: ['xray'], feel: (v) => ({ xray: v }) },
    door: {
      act: 'xray',
      label: 'Hidden goals',
      choices: [
        { arg: 'off', value: 'off', text: 'Never', title: 'Only what is in plain sight' },
        { arg: 'auto', value: 'auto', text: 'Cities', title: 'Crowns and blocks to spare show through what hides them on the city levels' },
        { arg: 'on', value: 'on', text: 'Always', title: 'Crowns and blocks to spare show through what hides them on every level' },
      ],
    },
  }),
} satisfies GameOption;

// The keystone.launch option and the Launch height setting (O4: one module per option; docs/design/options.md).
import { LAUNCH_MODES, type LaunchMode } from '../aim.ts';
import { choice, type GameOption, settingOption, storedOneOf } from './option.ts';

/** keystone.launch: high or level (absent: high). */
export function launchMode(text: string | null): LaunchMode {
  if (text === null) return 'high';
  if (!(LAUNCH_MODES as readonly string[]).includes(text)) throw new Error(`keystone.launch must be ${LAUNCH_MODES.join(' or ')}: ${text}`);
  return text as LaunchMode;
}

/**
 * Where shots leave from (aim.ts LaunchMode): high over the structure's top (the default since Will's
 * 2026-11-06 playtest: shots from the level's own launcher ran into the rubble on the ground), or the
 * level's own launcher height (keystone.launch=level). A shot records its height, so this changes
 * only the shots aimed, never a replay. The Launch height setting says it unless the URL does; read live:
 * a change moves the launcher at once.
 */
export const launch = {
  feel: choice({
    field: 'launch',
    url: 'keystone.launch',
    default: 'high',
    of: launchMode,
    scene: { key: 'launch', json: 'string' },
    panel: { label: 'launch height (keys W, S move it)', choices: [['high', "high: over the structure's top"], ['level', "the level's own launcher"]] },
  }),
  setting: settingOption<'launch', LaunchMode>({
    field: 'launch',
    default: 'high',
    stored: storedOneOf(LAUNCH_MODES),
    drives: { fields: ['launch'], feel: (v) => ({ launch: v }) },
    door: {
      act: 'launch',
      label: 'Launch height',
      choices: [
        { arg: 'high', value: 'high', text: 'High', title: "Shots leave from over the structure's top, clear of the rubble (keys W and S move it)" },
        { arg: 'level', value: 'level', text: "Level's", title: "Shots leave from the level's own launcher, near the ground, where its par lines were recorded" },
      ],
    },
  }),
} satisfies GameOption;

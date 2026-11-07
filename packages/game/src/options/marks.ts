// The keystone.marks option and the Stone marks setting (O4: one module per option; docs/design/options.md).
import { flag, type GameOption, onOffRow, settingOption, storedBoolean } from './option.ts';

/**
 * Engraved stones (scene.ts structureMarks): a crosshair carved on every block to bring down, a shield on every
 * block to keep up (Will, 2026-11-06), so which is which reads without the colours. On by default; keystone.marks=0 off.
 * The Stone marks setting says it unless the URL does; read live: a change recarves the stones at once.
 */
export const marks = {
  feel: flag({
    field: 'marks',
    url: 'keystone.marks',
    default: true,
    scene: { key: 'marks', json: 'boolean' },
    panel: { label: 'stone marks: crosshair on crowns, shield on what to keep, crown on a crown to hold' },
  }),
  setting: settingOption<'marks', boolean>({
    field: 'marks',
    default: true,
    stored: storedBoolean,
    drives: { fields: ['marks'], feel: (v) => ({ marks: v }) },
    door: onOffRow('marks', 'Stone marks', { text: 'Carved', title: 'A crosshair carved on the blocks to bring down, a shield on the blocks to keep' }, { text: 'Off', title: 'Plain stones: only their colour says which are which' }),
  }),
} satisfies GameOption;

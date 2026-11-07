// The keystone.sun option (O4: one module per option; docs/design/options.md).
import { SUN_MODES, type SunMode } from '../light.ts';
import { choice, type GameOption } from './option.ts';

/** keystone.sun: view or look (absent: view). */
export function sunMode(text: string | null): SunMode {
  if (text === null) return 'view';
  if (!(SUN_MODES as readonly string[]).includes(text)) throw new Error(`keystone.sun must be ${SUN_MODES.join(' or ')}: ${text}`);
  return text as SunMode;
}

/**
 * Where the real look's sun stands (light.ts SunMode): 'view' (the default since PT15) counts the look's sun
 * azimuth from the level's opening view, so every level is lit from the same side of the player's eye;
 * 'look' keeps the look's own, fixed in the world (keystone.sun=look).
 */
export const sun = {
  feel: choice({
    field: 'sun',
    url: 'keystone.sun',
    default: 'view',
    of: sunMode,
    scene: { key: 'sun', json: 'string' },
    panel: { label: "real look's sun", choices: [['view', 'from the opening view'], ['look', "the look's own (fixed)"]] },
  }),
} satisfies GameOption;

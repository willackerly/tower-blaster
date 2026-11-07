// The keystone.openaim option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * The opening aim (PT29, opening-aim.ts; docs/game/aim-clarity.md): before the first shot, while the player has not
 * aimed, the aim rests on a point chosen for the view (reachable, on the structure, clear of heritage), its flight and
 * marker shown, so a tap or click there fires a shot that does something. On by default; keystone.openaim=0 shows
 * nothing until the player aims, as before. Not in a duel, and not where the level's pre-aimed opener shows.
 */
export const openAim = {
  feel: flag({
    field: 'openAim',
    url: 'keystone.openaim',
    default: true,
    scene: { key: 'openaim', json: 'boolean' },
    panel: { label: 'opening aim: the aim rests on a sensible shot until you aim' },
  }),
} satisfies GameOption;

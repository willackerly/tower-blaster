// The keystone.quakeground option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Aftershock's ground moves with a quake (PT25, quake-ground.ts): the site, its ground and grid and every body on it,
 * is drawn displaced by the ground's motion at true scale, and the eye stays where the player put it. On by default;
 * keystone.quakeground=0 draws the ground still (the towers rock on it, as before).
 */
export const quakeGround = {
  feel: flag({
    field: 'quakeGround',
    url: 'keystone.quakeground',
    default: true,
    scene: { key: 'quakeground', json: 'boolean' },
    panel: { label: 'the ground moves with a quake' },
  }),
} satisfies GameOption;

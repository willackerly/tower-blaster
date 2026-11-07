// The keystone.frozenlook option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** Bullet Time's frozen look (frozen-look.ts, playtest PT8): while a shot is frozen the scene is graded cold and grey with a frosted blue edge, sparks hang and thin out, and a large label says what to do. On by default; keystone.frozenlook=0 off (only the HUD's FROZEN tag says so). */
export const frozenLook = {
  feel: flag({
    field: 'frozenLook',
    url: 'keystone.frozenlook',
    default: true,
    scene: { key: 'frozenlook', json: 'boolean' },
    panel: { label: 'Bullet Time: frozen look (cold grade and rim, label, sparks held and thinned)' },
  }),
} satisfies GameOption;

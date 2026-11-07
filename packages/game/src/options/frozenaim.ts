// The keystone.frozenaim option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Bullet Time keeps what you aim at (playtest PT33, frozen-look.ts): under the frozen grade the crowns, heritage,
 * the fired ball and the aim's preview (arc, reach, impact marker) keep their colour, and with the cursor off the
 * world (on the Freeze button, or a finger lifted) the preview stays where you last aimed. On by default;
 * keystone.frozenaim=0 off (the grade drains everything, and the preview needs the cursor on the world).
 */
export const frozenAim = {
  feel: flag({
    field: 'frozenAim',
    url: 'keystone.frozenaim',
    default: true,
    scene: { key: 'frozenaim', json: 'boolean' },
    panel: { label: 'Bullet Time: what you aim at keeps its colour, and the aim stays up' },
  }),
} satisfies GameOption;

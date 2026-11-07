// The keystone.dudnote option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * The dud note (PT31): after a shot that moved under 1% of the structure and brought no crown down, one line floats
 * over where it was aimed, saying so and what to try (dud.ts). On by default; keystone.dudnote=0 off.
 */
export const dudNote = {
  feel: flag({
    field: 'dudNote',
    url: 'keystone.dudnote',
    default: true,
    scene: { key: 'dudNote', json: 'boolean' },
    panel: { label: 'a note after a shot that moved nothing, with what to try' },
  }),
} satisfies GameOption;

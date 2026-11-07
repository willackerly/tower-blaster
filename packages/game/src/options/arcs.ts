// The keystone.arcs option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/** A duel's arc on the ground: the player to fire's half of the launcher ring, dotted in their ink (keystone.arcs=0 hides it). */
export const arcs = {
  feel: flag({
    field: 'arcs',
    url: 'keystone.arcs',
    default: true,
  }),
} satisfies GameOption;

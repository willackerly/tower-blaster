// The keystone.coats option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Coats (scene.ts structureCoats, @tb/render coats.ts): crowns gilded and heritage glazed, their own colour in
 * every look (PT15), instead of a tint multiplying the look's palette. On by default; keystone.coats=0 off.
 */
export const coats = {
  feel: flag({
    field: 'coats',
    url: 'keystone.coats',
    default: true,
    scene: { key: 'coats', json: 'boolean' },
    panel: { label: 'coats: crowns gilded, heritage glazed in every look' },
  }),
} satisfies GameOption;

// The keystone.chorusview option (O4: one module per option; docs/design/options.md).
import { choice, type GameOption } from './option.ts';

/** How a Chorus level shows its other worlds (chorus-view.ts, docs/game/chorus.md): a grid of thumbnails, a heat strip, or not at all. */
export const CHORUS_VIEWS = ['grid', 'strip', 'off'] as const;
export type ChorusView = (typeof CHORUS_VIEWS)[number];

/** keystone.chorusview: grid, strip or off (absent: grid). */
export function chorusView(text: string | null): ChorusView {
  if (text === null) return 'grid';
  if (!(CHORUS_VIEWS as readonly string[]).includes(text)) throw new Error(`keystone.chorusview must be ${CHORUS_VIEWS.join(', ')}: ${text}`);
  return text as ChorusView;
}

/**
 * The other worlds of a Chorus level, beside the hero world (world 0, framed as usual): an 8 x 8 grid of live
 * side-view thumbnails, each edged green once it clears (the default); a heat strip of one cell per world; or
 * nothing but the count. Only Chorus levels show it; the camera never moves for it.
 */
export const chorusViewOption = {
  feel: choice({ field: 'chorusView', url: 'keystone.chorusview', default: 'grid', of: chorusView }),
} satisfies GameOption;

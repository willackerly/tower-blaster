// The keystone.space option (O4: one module per option; docs/design/options.md).
import { flag, type GameOption } from './option.ts';

/**
 * Where an impact is heard (A8a, @tb/audio engine.setSpace): the sound bank's stereo sectors play at their
 * impacts' own pan instead of at fixed centres (a centred tower is no longer split into two points), and the
 * room hears each impact by its distance, so a far tower sounds far. On by default; keystone.space=0 plays it
 * as before. The classic sound set (keystone.sound=classic) never uses it, as G6 did not.
 */
export const space = {
  feel: flag({
    field: 'space',
    url: 'keystone.space',
    default: true,
    scene: { key: 'space', json: 'boolean' },
    panel: { label: 'sound space: stereo by impact, room by distance' },
  }),
} satisfies GameOption;

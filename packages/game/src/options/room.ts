// The keystone.room option (O4: one module per option; docs/design/options.md).
import { type Room, ROOMS } from '@tb/audio';
import { choice, type GameOption } from './option.ts';

/** keystone.room: outdoor, hall or off (absent: outdoor). */
export function roomSoundOf(text: string): Room {
  if (!(ROOMS as readonly string[]).includes(text)) throw new Error(`keystone.room must be ${ROOMS.join(', ')}: ${text}`);
  return text as Room;
}

/**
 * Where the collapse is heard (A5, @tb/audio room.ts): 'outdoor' (the default) adds a tree line's and a
 * building's echo and a little foliage scatter, as the game's open field would; 'hall' a glass-and-iron
 * exhibition hall (3 s); 'off' the dry sound, as before. The classic sound set (keystone.sound=classic)
 * always plays dry, as G6 did.
 */
export const room = {
  feel: choice({
    field: 'room',
    url: 'keystone.room',
    default: 'outdoor',
    of: roomSoundOf,
    scene: { key: 'room', json: 'string' },
    panel: { label: 'Room sound', choices: [['outdoor', 'outdoor: echoes off the field'], ['hall', 'hall: a big glass hall'], ['off', 'off: dry, as before']] },
  }),
} satisfies GameOption;

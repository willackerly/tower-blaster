// The keystone.kaplasound option (O4: one module per option; docs/design/options.md).
import { choice, type GameOption } from './option.ts';

export const KAPLA_SOUNDS = ['pine', 'plaster'] as const;
export type KaplaSound = (typeof KAPLA_SOUNDS)[number];

/** keystone.kaplasound: pine or plaster (absent: pine). */
export function kaplaSoundOf(text: string): KaplaSound {
  if (!(KAPLA_SOUNDS as readonly string[]).includes(text)) throw new Error(`keystone.kaplasound must be ${KAPLA_SOUNDS.join(' or ')}: ${text}`);
  return text as KaplaSound;
}

/**
 * What a Kapla plank sounds like (A9, sound-map.ts KAPLA_SLOT): 'pine' (the default) is a real Kapla plank of
 * maritime pine at its own size, as loud as the plank on screen; 'plaster' (keystone.kaplasound=plaster) is the
 * old sound, the plank's material as a cube of the level's edge. The classic sound set (keystone.sound=classic)
 * always plays plaster, as G6 did.
 */
export const kaplaSound = {
  feel: choice({
    field: 'kaplaSound',
    url: 'keystone.kaplasound',
    default: 'pine',
    of: kaplaSoundOf,
    scene: { key: 'kaplasound', json: 'string' },
    panel: { label: 'Kapla sound', choices: [['pine', 'pine: a Kapla plank'], ['plaster', 'plaster: a block, as before']] },
  }),
} satisfies GameOption;

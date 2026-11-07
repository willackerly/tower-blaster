// The keystone.launchsound option (O4: one module per option; docs/design/options.md).
import { choice, type GameOption } from './option.ts';

export const LAUNCH_SOUNDS = ['whump', 'glide'] as const;
export type LaunchSound = (typeof LAUNCH_SOUNDS)[number];

/** keystone.launchsound: whump or glide (absent: whump). */
export function launchSoundOf(text: string): LaunchSound {
  if (!(LAUNCH_SOUNDS as readonly string[]).includes(text)) throw new Error(`keystone.launchsound must be ${LAUNCH_SOUNDS.join(' or ')}: ${text}`);
  return text as LaunchSound;
}

/**
 * The sound of a shot leaving the launcher (A10, launch-sound.ts): 'whump' (the default) is a gas
 * launcher's, from the shot's own size and speed (barrel resonance, muzzle blast, the gas chuffing out);
 * 'glide' (keystone.launchsound=glide) is the old sine sweeping down an octave.
 */
export const launchSound = {
  feel: choice({
    field: 'launchSound',
    url: 'keystone.launchsound',
    default: 'whump',
    of: launchSoundOf,
    scene: { key: 'launchsound', json: 'string' },
    panel: { label: 'launch sound', choices: [['whump', 'whump: the launcher, from the shot'], ['glide', 'glide: the old sine sweep']] },
  }),
} satisfies GameOption;

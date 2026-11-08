// The keystone.launchsound option (O4: one module per option; docs/design/options.md).
import { choice, type GameOption } from './option.ts';

export const LAUNCH_SOUNDS = ['whump', 'dry', 'glide'] as const;
export type LaunchSound = (typeof LAUNCH_SOUNDS)[number];

/** keystone.launchsound: whump, dry or glide (absent: whump). */
export function launchSoundOf(text: string): LaunchSound {
  if (!(LAUNCH_SOUNDS as readonly string[]).includes(text)) throw new Error(`keystone.launchsound must be ${LAUNCH_SOUNDS.join(', ')}: ${text}`);
  return text as LaunchSound;
}

/**
 * The sound of a shot leaving the launcher (A10, launch-sound.ts): 'whump' (the default) is a gas
 * launcher's, from the shot's own size and speed (barrel resonance, muzzle blast, the gas chuffing out), under
 * its report (A10b: the muzzle blast and its echoes, tuned against real launch recordings); 'dry' is A10's
 * whump without the report; 'glide' (keystone.launchsound=glide) is the old sine sweeping down an octave.
 */
export const launchSound = {
  feel: choice({
    field: 'launchSound',
    url: 'keystone.launchsound',
    default: 'whump',
    of: launchSoundOf,
    scene: { key: 'launchsound', json: 'string' },
    panel: { label: 'launch sound', choices: [['whump', 'whump: the launcher and its report, from the shot'], ['dry', 'dry: the whump without its report (A10)'], ['glide', 'glide: the old sine sweep']] },
  }),
} satisfies GameOption;

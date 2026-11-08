// The keystone.blastsound option (O4: one module per option; docs/design/options.md).
import { choice, type GameOption } from './option.ts';

export const BLAST_SOUNDS = ['boom', 'short', 'none'] as const;
export type BlastSound = (typeof BLAST_SOUNDS)[number];

/** keystone.blastsound: boom, short or none (absent: boom). */
export function blastSoundOf(text: string): BlastSound {
  if (!(BLAST_SOUNDS as readonly string[]).includes(text)) throw new Error(`keystone.blastsound must be ${BLAST_SOUNDS.join(', ')}: ${text}`);
  return text as BlastSound;
}

/**
 * The sound of a weapon going off (A6, blast-sound.ts): 'boom' (the default) is a blast wave and its
 * rumble, from the blast's reach and the camera's distance (its pulse and rumble tuned against real explosion
 * recordings, A6b); 'short' is A6's first boom, a shorter pulse and darker rumble; 'none' (keystone.blastsound=none)
 * is the old silence (the blocks it throws are still heard).
 */
export const blastSound = {
  feel: choice({
    field: 'blastSound',
    url: 'keystone.blastsound',
    default: 'boom',
    of: blastSoundOf,
    scene: { key: 'blastsound', json: 'string' },
    panel: { label: 'blast sound', choices: [['boom', 'boom: the blast and its rumble'], ['short', 'short: the first boom (A6), sharper and darker'], ['none', 'none: silent, as before']] },
  }),
} satisfies GameOption;

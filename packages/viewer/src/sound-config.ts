// What the viewer's sound plays for a config: the material (snd.mat, or the
// scene's own for auto) tuned by the knobs, and which body slots sound. Pure,
// so node tests cover it; sound.ts runs it.
import { SOUND_MATERIALS, type SoundMaterial, type SoundMaterialName, tunedMaterial } from '@tb/audio';
import { type BodyDesc, TAG_BALL } from '@tb/engine-api';
import type { ViewerConfig } from './params.ts';

/**
 * snd.mat=auto: Kapla planks (S15) are pine whatever the look; the real look's
 * blocks are its stone (pine planks, else stone); every other look's bright
 * blocks are acrylic.
 */
export function autoSoundMaterial(c: Pick<ViewerConfig, 'scenario' | 'level' | 'look' | 'real'>): SoundMaterialName {
  if (!c.level && c.scenario === 'S15') return 'pine';
  if (c.look === 'real') return c.real.stone === 'pine' ? 'pine' : 'stone';
  return 'acrylic';
}

export const soundMaterialName = (c: Pick<ViewerConfig, 'scenario' | 'level' | 'look' | 'real' | 'sound'>): SoundMaterialName =>
  c.sound.material === 'auto' ? autoSoundMaterial(c) : c.sound.material;

/** The material the engine gets: the named one with the knobs applied. */
export const soundMaterial = (c: Pick<ViewerConfig, 'scenario' | 'level' | 'look' | 'real' | 'sound'>): SoundMaterial =>
  tunedMaterial(SOUND_MATERIALS[soundMaterialName(c)], c.sound);

/** Sound material slot per body: 0 for blocks, -1 (silent) for fired balls, whose own sound is not modelled yet. */
export const soundSlot = (b: BodyDesc): number => (b.tag === TAG_BALL ? -1 : 0);

/** Master gain (linear) for snd.volume (dB). */
export const soundGain = (c: Pick<ViewerConfig, 'sound'>): number => 10 ** (c.sound.volume / 20);

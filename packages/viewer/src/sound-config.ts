// What the viewer's sound plays for a config: the material (snd.mat, or the
// scene's own for auto) tuned by the knobs, and which body slots sound. Pure,
// so node tests cover it; sound.ts runs it.
import { type Room, type SoundMaterial, type SoundMaterialName, soundMaterials, tunedMaterial } from '@tb/audio';
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

/** The material the engine gets: the named one of the set (snd.set) with the knobs applied. */
export const soundMaterial = (c: Pick<ViewerConfig, 'scenario' | 'level' | 'look' | 'real' | 'sound'>): SoundMaterial =>
  tunedMaterial(soundMaterials(c.sound.set)[soundMaterialName(c)], c.sound);

/** Sound material slot per body: 0 for blocks, -1 (silent) for fired balls, whose own sound is not modelled yet. */
export const soundSlot = (b: BodyDesc): number => (b.tag === TAG_BALL ? -1 : 0);

/** Master gain (linear) for snd.volume (dB). */
export const soundGain = (c: Pick<ViewerConfig, 'sound'>): number => 10 ** (c.sound.volume / 20);

/**
 * The room the sound plays in (snd.room, @tb/audio room.ts). auto: the real look's hall (at its hallSize) when
 * the scene is in it, else outdoor. The classic set plays dry, as G6 did (as the game's keystone.sound=classic).
 */
export function soundRoom(c: Pick<ViewerConfig, 'look' | 'real' | 'sound'>): { room: Room; size: number } {
  if (c.sound.set === 'classic') return { room: 'off', size: 1 };
  const inHall = c.look === 'real' && c.real.env === 'hall', size = inHall ? (c.real.hallSize ?? 1) : 1;
  const room = c.sound.room === 'auto' ? (inHall ? 'hall' : 'outdoor') : c.sound.room;
  return { room, size: room === 'hall' ? size : 1 };
}

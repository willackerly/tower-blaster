// What each Keystone body sounds like in @tb/audio's collapse synth: one
// sound-material slot per Keystone material (the structure), then one per
// ammo kind (all steel, each at its own size: a 20 cm marble knocks, a 50 cm
// cannonball thuds, the cue is a steel rod that rings as a bar). Pure, so
// node tests cover it; collapse-sound.ts runs it.
import { AMMO, AMMO_KINDS, type AmmoKind, type CompiledLevel, MATERIALS, materialId } from '@tb/keystone';
import { SOUND_MATERIALS, type SoundMaterial } from '@tb/audio';
import type { BodyDesc } from '@tb/engine-api';

/** Impacts by @tb/audio's collision sound, or the old pentatonic voices (audio.ts). */
export type GameSoundMode = 'collapse' | 'synth';

/** Keystone material name -> its sound (same names in @tb/audio). */
export const KEYSTONE_SOUNDS: Record<(typeof MATERIALS)[number]['name'], SoundMaterial> = {
  plaster: SOUND_MATERIALS.plaster,
  stone: SOUND_MATERIALS.stone,
  iron: SOUND_MATERIALS.iron,
  ice: SOUND_MATERIALS.ice,
  rubber: SOUND_MATERIALS.rubber,
  steel: SOUND_MATERIALS.steel,
};

/**
 * The game's master gain over @tb/audio's full scale, dB. The game's camera is ~10 m from 0.5 m
 * blocks (the viewer's city: 75 m from 1 m ones), so at the viewer's level every par line's
 * collapse limits by 18-19 dB (sound-cli.ts). At -22 the loudest peak at about 0.6 (the limiter's
 * ceiling is 0.9), which leaves room for the cues on top.
 */
export const GAME_SOUND_DB = -22;

/** First ammo slot; slot AMMO_SLOT + k is AMMO_KINDS[k]. */
export const AMMO_SLOT = MATERIALS.length;
export const SOUND_SLOTS = AMMO_SLOT + AMMO_KINDS.length;

export interface SlotSound { material: SoundMaterial; edge: number }

/** Steel shear modulus, Pa: the cue rings as a free-free bar (plank model). */
const STEEL_G = 79e9;
const STEEL_DENSITY = MATERIALS[materialId('steel')]!.density, IRON_DENSITY = MATERIALS[materialId('iron')]!.density;

/** The sound of each slot for a level: structure slots at the level's cube edge, ammo at its own size (metres). */
export function slotSounds(c: CompiledLevel): SlotSound[] {
  const h = c.frame.unit;
  const structure = MATERIALS.map((m) => ({ material: KEYSTONE_SOUNDS[m.name], edge: h }));
  const ammo = AMMO_KINDS.map((k): SlotSound => {
    const s = AMMO[k].size, steel = KEYSTONE_SOUNDS[AMMO[k].material];
    if ('radius' in s) return { material: steel, edge: 2 * s.radius * h };
    const [a, b, d] = [...s.half].sort((x, y) => y - x) as [number, number, number];
    if (a > 3 * b) return { material: { ...steel, model: 'plank', dims: [2 * a * h, 2 * b * h, 2 * d * h], G: STEEL_G }, edge: 2 * a * h };
    return { material: steel, edge: 2 * a * h };
  });
  return [...structure, ...ammo];
}

/**
 * The Keystone ammo kind a spawned body is, from its shape, or null for anything else. Keystone's
 * ammo is steel (and a rack grenade flies in an iron marble-sized shell); the rack's real-world
 * projectiles (p-<preset>) have their own materials and are silent until they get sounds.
 */
export function ammoKindOf(b: BodyDesc, h: number): AmmoKind | null {
  if (b.density !== STEEL_DENSITY && b.density !== IRON_DENSITY) return null;
  if (b.shape.kind === 'sphere') return b.shape.radius / h < 0.35 ? 'marble' : 'cannonball';
  const [a, , d] = [...b.shape.half].sort((x, y) => y - x) as [number, number, number];
  return a > 3 * d ? 'cue' : 'drop';
}

/** Sound slot of body i: its Keystone material for the structure (the first c.meta.n), else its ammo kind's (-1: silent). */
export function soundSlotOf(c: CompiledLevel, b: BodyDesc, i: number): number {
  if (i < c.meta.n) return c.meta.material[i]!;
  const k = ammoKindOf(b, c.frame.unit);
  return k ? AMMO_SLOT + AMMO_KINDS.indexOf(k) : -1;
}

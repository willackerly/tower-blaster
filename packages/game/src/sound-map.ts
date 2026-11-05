// What each Keystone body sounds like in @tb/audio's collapse synth: one
// sound-material slot per Keystone material (the structure), then one per
// ammo kind (all steel, each at its own size: a 20 cm marble knocks, a 50 cm
// cannonball thuds, the cue is a steel rod that rings as a bar). Pure, so
// node tests cover it; collapse-sound.ts runs it.
import { AMMO, AMMO_KINDS, type AmmoKind, type CompiledLevel, MATERIALS, materialId } from '@tb/keystone';
import { soundMaterials, type SoundMaterial, type SoundSet } from '@tb/audio';
import type { BodyDesc } from '@tb/engine-api';

/**
 * Impacts by @tb/audio's collision sound with its current materials ('collapse', the default), with
 * G6's materials ('classic': smooth contacts, table modes only), or as the old pentatonic voices (audio.ts).
 */
export type GameSoundMode = 'collapse' | 'classic' | 'synth';
export const GAME_SOUND_MODES = ['collapse', 'classic', 'synth'] as const satisfies readonly GameSoundMode[];

/** The material set a collision-sound mode plays. */
export const soundSetOf = (mode: GameSoundMode): SoundSet => (mode === 'classic' ? 'classic' : 'real');

/** Keystone material name -> its sound in a set (same names in @tb/audio). */
export function keystoneSounds(set: SoundSet = 'real'): Record<(typeof MATERIALS)[number]['name'], SoundMaterial> {
  const s = soundMaterials(set);
  return { plaster: s.plaster, stone: s.stone, iron: s.iron, ice: s.ice, rubber: s.rubber, steel: s.steel };
}
export const KEYSTONE_SOUNDS = keystoneSounds();

/**
 * The game's master gain over @tb/audio's full scale, dB. The game's camera is ~10 m from 0.5 m
 * blocks (the viewer's city: 75 m from 1 m ones), so at the viewer's level every par line's
 * collapse limits by 18-19 dB (sound-cli.ts). At -22 the loudest peak at about 0.6 (the limiter's
 * ceiling is 0.9), which leaves room for the cues on top.
 */
export const GAME_SOUND_DB = -22;

/**
 * The 'real' set's level, from the L1-L5 par lines on the AVBD reference (sound-cli.ts set=real prints
 * the peak and the loudness, ITU-R BS.1770). The real set is transient where the classic one rings, so
 * at the same headroom it reads quieter: at -17 nothing limits (loudest peak 0.81, the ceiling 0.9) and
 * it is 1.1-3.4 LU (mean 2.1) under the classic set at GAME_SOUND_DB. keystone.impacts=3 makes up the rest.
 */
export const GAME_SOUND_DB_REAL = -17;

/** The game's master gain over @tb/audio's full scale for a material set, dB. */
export const gameSoundDb = (set: SoundSet = 'real'): number => (set === 'classic' ? GAME_SOUND_DB : GAME_SOUND_DB_REAL);

/** First ammo slot; slot AMMO_SLOT + k is AMMO_KINDS[k]. */
export const AMMO_SLOT = MATERIALS.length;
export const SOUND_SLOTS = AMMO_SLOT + AMMO_KINDS.length;

export interface SlotSound { material: SoundMaterial; edge: number }

/** Steel shear modulus, Pa: the cue rings as a free-free bar (plank model). */
const STEEL_G = 79e9;
const STEEL_DENSITY = MATERIALS[materialId('steel')]!.density, IRON_DENSITY = MATERIALS[materialId('iron')]!.density;

/** The sound of each slot for a level: structure slots at the level's cube edge, ammo at its own size (metres). */
export function slotSounds(c: CompiledLevel, set: SoundSet = 'real'): SlotSound[] {
  const h = c.frame.unit, sounds = keystoneSounds(set);
  const structure = MATERIALS.map((m) => ({ material: sounds[m.name], edge: h }));
  const ammo = AMMO_KINDS.map((k): SlotSound => {
    const s = AMMO[k].size, steel = sounds[AMMO[k].material];
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

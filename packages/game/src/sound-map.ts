// What each Keystone body sounds like in @tb/audio's collapse synth: one
// sound-material slot per Keystone material (the structure), then one per
// ammo kind (all steel, each at its own size: a 20 cm marble knocks, a 50 cm
// cannonball thuds, the cue is a steel rod that rings as a bar). Pure, so
// node tests cover it; collapse-sound.ts runs it.
import { AMMO, AMMO_KINDS, type AmmoKind, type CompiledLevel, isIcePiece, MATERIALS, materialId, MODEL_DENSITY } from '@tb/keystone';
import { PRESET_NAMES, type PresetName, presetMass, PROJECTILE_PRESETS } from '@tb/weapons';
import { mass, roughTime, soundMaterials, type SoundMaterial, type SoundSet } from '@tb/audio';
import type { BodyDesc } from '@tb/engine-api';

/**
 * Impacts by @tb/audio's collision sound with its current materials ('collapse', the default), with
 * G6's materials ('classic': smooth contacts, table modes only), or as the old pentatonic voices (audio.ts).
 */
export type GameSoundMode = 'collapse' | 'real1' | 'classic' | 'synth';
export const GAME_SOUND_MODES = ['collapse', 'real1', 'classic', 'synth'] as const satisfies readonly GameSoundMode[];

/** The material set a collision-sound mode plays: real1 is the real set before step 2c's stone and ice. */
export const soundSetOf = (mode: GameSoundMode): SoundSet => (mode === 'classic' ? 'classic' : mode === 'real1' ? 'real1' : 'real');

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
 * at the same headroom it reads quieter. Since its plaster turned solid (docs/sound.md, Material
 * identity) L1's loudest hit goes 1.1 dB into the limiter at -17 (nothing else limits; loudest other
 * peak 0.73), and the set is 1.2-4.0 LU (mean 2.4) under the classic set at GAME_SOUND_DB. Kept at -17:
 * at -18 that hit only touches it (0.1 dB) but the set is 3.4 LU under, and catching a rare peak is
 * what the limiter is for. keystone.impacts=3 makes up the rest.
 */
export const GAME_SOUND_DB_REAL = -17;

/** The game's master gain over @tb/audio's full scale for a material set, dB. */
export const gameSoundDb = (set: SoundSet = 'real'): number => (set === 'classic' ? GAME_SOUND_DB : GAME_SOUND_DB_REAL);

/** First ammo slot; slot AMMO_SLOT + k is AMMO_KINDS[k]. */
export const AMMO_SLOT = MATERIALS.length;
/**
 * A shattered ice block's pieces (keystone ice.ts: 2 x 2 x 2, each about half the block's edge and an
 * eighth of its mass): ice at half the edge, so a piece rings an octave up with an eighth of a block's
 * energy. As full blocks, a grenade's thousands of piece impacts went 6-9 dB into the limiter
 * (docs/sound.md, Material identity, step 4).
 */
export const PIECE_SLOT = AMMO_SLOT + AMMO_KINDS.length;
/** First preset slot; slot PRESET_SLOT + k is PRESET_NAMES[k] (the rack's real-world projectiles, p-<preset>). */
export const PRESET_SLOT = PIECE_SLOT + 1;
export const SOUND_SLOTS = PRESET_SLOT + PRESET_NAMES.length;

export interface SlotSound { material: SoundMaterial; edge: number }

/** Steel shear modulus, Pa: the cue rings as a free-free bar (plank model). */
const STEEL_G = 79e9;
const STEEL_DENSITY = MATERIALS[materialId('steel')]!.density, IRON_DENSITY = MATERIALS[materialId('iron')]!.density;

/**
 * The contact modulus a steel ammo slot plays against a structure material: the Hertz pair modulus
 * 1/E* = (1-nu1^2)/E1 + (1-nu2^2)/E2, as the Ec that gives it (modes.ts contactTime takes
 * Ec / (2 (1-nu^2)) for a pair of equals). A steel ball on plaster has plaster's long, soft contact,
 * which barely reaches the ball's own modes; with steel's Ec it rang like a bell on every hit and the
 * judge heard L1-L2 as glass and Ding (docs/sound.md, Material identity).
 */
export function pairEc(ammo: SoundMaterial, struck: SoundMaterial): number {
  const e = (m: SoundMaterial) => (m.Ec ?? m.E) / (1 - m.nu * m.nu) / 2; // each body's own half of an equal pair
  const star = 1 / (1 / (2 * e(ammo)) + 1 / (2 * e(struck)));
  return 2 * (1 - ammo.nu * ammo.nu) * star;
}

/**
 * The ammo against a struck material, in the real set: the pair's contact modulus (pairEc), and the
 * pair's asperity time, an asperity being a Hertz contact too, so it lengthens as (E*)^(-2/5). A steel
 * ball's roughness on steel reaches ~7 kHz and rings it; on plaster ~1.4 kHz, under its modes, so
 * only the plaster crunches (with steel's own the ammo, 28 dB under the blocks, still turned the
 * judge's L1 from Crack to Glass).
 */
export function ammoOn(ammo: SoundMaterial, struck: SoundMaterial): SoundMaterial {
  const Ec = pairEc(ammo, struck);
  return { ...ammo, Ec, roughT: roughTime(ammo) * ((ammo.Ec ?? ammo.E) / Ec) ** 0.4 };
}

/** The level's most common structure material (its first on a tie). */
export function mainMaterial(c: CompiledLevel): (typeof MATERIALS)[number]['name'] {
  const n = new Array<number>(MATERIALS.length).fill(0);
  for (let i = 0; i < c.meta.n; i++) n[c.meta.material[i]!]!++;
  return MATERIALS[n.indexOf(Math.max(...n))]!.name;
}

/**
 * The sound of each slot for a level: structure slots at the level's cube edge, ammo at its own size
 * (metres). In the real set the ammo's contact is the pair's with the level's main material (ammoOn);
 * the classic set keeps G6's steel-on-steel contact.
 */
export function slotSounds(c: CompiledLevel, set: SoundSet = 'real'): SlotSound[] {
  const h = c.frame.unit, sounds = keystoneSounds(set);
  const structure = MATERIALS.map((m) => ({ material: sounds[m.name], edge: h }));
  const struck = sounds[mainMaterial(c)];
  const ammo = AMMO_KINDS.map((k): SlotSound => {
    const s = AMMO[k].size, own = sounds[AMMO[k].material];
    const steel = set === 'real' ? ammoOn(own, struck) : own;
    if ('radius' in s) return { material: steel, edge: 2 * s.radius * h };
    const [a, b, d] = [...s.half].sort((x, y) => y - x) as [number, number, number];
    if (a > 3 * b) return { material: { ...steel, model: 'plank', dims: [2 * a * h, 2 * b * h, 2 * d * h], G: STEEL_G }, edge: 2 * a * h };
    return { material: steel, edge: 2 * a * h };
  });
  const presets = PRESET_NAMES.map((name): SlotSound => {
    const own = presetSound(name, set), hard = name === 'bowlingball' || name === 'cannonball' || name === 'wreckingball';
    return { material: set === 'real' && hard ? ammoOn(own, struck) : own, edge: PROJECTILE_PRESETS[name].diameter };
  });
  return [...structure, ...ammo, { material: sounds.ice, edge: h / 2 }, ...presets];
}

/**
 * The inflated balls' contact times on a hard floor at INFLATED_DV, s. An inflated ball's stiffness is its
 * air pressure's, not its rubber's (Hertz on the wall's modulus gives 3 ms): high-speed video puts a
 * basketball's bounce near 10-15 ms, and a beach ball, at a fraction of the pressure, is softer still.
 */
export const INFLATED_CONTACT = { beachball: 0.025, basketball: 0.012 } as const;
export const INFLATED_DV = 3;

/** The contact modulus that gives a material at `edge` the Hertz contact time T at dv (modes.ts contactTime, solved for Ec). */
export function ecForContact(m: SoundMaterial, edge: number, T: number, dv: number): number {
  const ms = m.mstar * mass(m, edge), Es = Math.sqrt((2.87 ** 5 * ms * ms) / (m.R * dv * T ** 5));
  return Es * 2 * (1 - m.nu * m.nu);
}

/**
 * What a rack preset (@tb/weapons PROJECTILE_PRESETS, at its real size) sounds like: its real material
 * on one of @tb/audio's body models, the contact radius its own (a sphere's Hertz contact is its radius).
 * - beach ball and basketball: hollow (the shell model), vinyl (1300 kg/m^3) and rubber (1100) walls as
 *   thick as their real masses make them (0.25 kg and 0.62 kg over pi d^2), with the contact of an
 *   inflated ball (INFLATED_CONTACT). Their wall modes are off (ringDb -Infinity): a pressurised membrane
 *   is not a clamped plate, and as plates they sit under or just over 20 Hz. What is heard is the soft
 *   contact's thump (a ball's air is not modelled).
 * - bowling ball: solid polyester resin (E 3.5 GPa, 1340 kg/m^3, loss 0.02), its 7.3 kg as a cube of its diameter.
 * - cannonball (24-pounder iron shot) and wrecking ball: solid cast iron and steel, like the steel ammo.
 * - boulder: the level's stone, grit and all, 6.7 m across.
 * In the real set the hard ones take the pair's contact with the struck material (ammoOn), as the ammo does.
 */
export function presetSound(name: PresetName, set: SoundSet = 'real'): SoundMaterial {
  const s = keystoneSounds(set), p = PROJECTILE_PRESETS[name], d = p.diameter, r = d / 2;
  const ball = (rho: number, E: number): SoundMaterial => {
    const m: SoundMaterial = { ...s.rubber, model: 'shell', wall: presetMass(p) / (rho * Math.PI * d * d), E, nu: 0.45, rho, eta: 0.1, R: r, ringDb: -Infinity };
    return { ...m, Ec: ecForContact(m, d, INFLATED_CONTACT[name as keyof typeof INFLATED_CONTACT], INFLATED_DV) };
  };
  switch (name) {
    case 'beachball': return ball(1300, 0.02e9);
    case 'basketball': return ball(1100, 0.05e9);
    case 'bowlingball': return { ...s.rubber, model: 'cube', E: 3.5e9, nu: 0.35, rho: 1340, eta: 0.02, jitter: 0.01, R: r };
    case 'cannonball': return { ...s.steel, E: 170e9, nu: 0.27, rho: 7200, eta: 0.002, R: r };
    case 'wreckingball': return { ...s.steel, R: r };
    case 'boulder': return { ...s.stone, rho: 2700, R: r };
  }
}

/** The rack preset a body is (a sphere at the preset's real diameter and its density at MODEL_DENSITY, rack.ts itemSpec), or null. */
export function presetOf(b: BodyDesc): PresetName | null {
  if (b.shape.kind !== 'sphere') return null;
  const r = b.shape.radius, near = (a: number, x: number) => Math.abs(a - x) <= 1e-9 * Math.max(1, Math.abs(x));
  return PRESET_NAMES.find((n) => near(r, PROJECTILE_PRESETS[n].diameter / 2) && near(b.density, PROJECTILE_PRESETS[n].density * MODEL_DENSITY)) ?? null;
}

/** The steel ammo kind a body's shape is nearest (a sphere: marble or cannonball by size; a box: cue or drop). */
function ammoShapeOf(b: BodyDesc, h: number): AmmoKind {
  if (b.shape.kind === 'sphere') return b.shape.radius / h < 0.35 ? 'marble' : 'cannonball';
  const [a, , d] = [...b.shape.half].sort((x, y) => y - x) as [number, number, number];
  return a > 3 * d ? 'cue' : 'drop';
}

/**
 * The Keystone ammo kind a spawned body is, from its shape, or null for anything else. Keystone's
 * ammo is steel (and a rack grenade flies in an iron marble-sized shell); the rack's real-world
 * projectiles (p-<preset>) have their own materials and are silent until they get sounds.
 */
export function ammoKindOf(b: BodyDesc, h: number): AmmoKind | null {
  if (b.density !== STEEL_DENSITY && b.density !== IRON_DENSITY) return null;
  return ammoShapeOf(b, h);
}

/**
 * Sound slot of body i. The structure (the first c.meta.n) sounds as its Keystone material. Of what is
 * spawned: a shattered ice block's pieces as ice pieces (PIECE_SLOT); a rack preset as itself
 * (PRESET_SLOT + k); Keystone's steel or iron ammo as its kind; a body of a structure material's density
 * (a Mason's Trial probe) as that material; anything else (a weapon's shell or munition, its density
 * scaled to the level's blocks: B1-B3's bomb, the firework, w-grenade) as the steel ammo of its shape,
 * a metal casing. Nothing spawned is silent.
 */
export function soundSlotOf(c: CompiledLevel, b: BodyDesc, i: number): number {
  if (i < c.meta.n) return c.meta.material[i]!;
  if (isIcePiece(b)) return PIECE_SLOT;
  const p = presetOf(b);
  if (p) return PRESET_SLOT + PRESET_NAMES.indexOf(p);
  const k = ammoKindOf(b, c.frame.unit);
  if (k) return AMMO_SLOT + AMMO_KINDS.indexOf(k);
  const m = MATERIALS.findIndex((x) => x.density === b.density);
  if (m >= 0) return m;
  return AMMO_SLOT + AMMO_KINDS.indexOf(ammoShapeOf(b, c.frame.unit));
}

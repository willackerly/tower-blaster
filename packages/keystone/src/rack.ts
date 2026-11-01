// The rack: what a level gives the player to fire (docs/game/spectacle-mode.md, section 7).
// An item has one name, used in level files, shot text and the HUD:
// - Keystone's own ammo, bare: marble, cannonball, cue, drop (AMMO). These names and
//   their bodies are unchanged, so every recorded line replays as it did.
// - p-<preset>: a real thing from @tb/weapons' catalogue (PROJECTILE_PRESETS) at its
//   real diameter, restitution, friction and launch speed, with its density at
//   Keystone's model scale (MODEL_DENSITY). Fired from the launcher ring at 50% to
//   100% of its own speed.
// - w-<key>: a weapon, the level's weapons[key] (a GrenadeSpec in the level's units,
//   levelWeapon), fired in a GRENADE_SHELL from the launcher ring. w-grenade on a level
//   with no weapons.grenade is KEYSTONE_GRENADE. WeaponSpec weapons join under the
//   same names once the language exists (roadmap V3).
import type { Vec3 } from '@tb/engine-api';
import { checkGrenade, type GrenadeSpec, isPreset, PRESET_NAMES, type PresetName, PROJECTILE_PRESETS, STONE_DENSITY } from '@tb/weapons';
import { DEFAULT_UNIT, MATERIALS, materialId, type MaterialName } from './materials.ts';

export type AmmoKind = 'marble' | 'cannonball' | 'cue' | 'drop';
export const AMMO_KINDS: readonly AmmoKind[] = ['marble', 'cannonball', 'cue', 'drop'];

export interface AmmoSpec {
  /** Sphere radius, or box half-extents along (+x, y, z) before turning, in h. */
  size: { radius: number } | { half: Vec3 };
  material: MaterialName;
  /** Launch speed range in m/s, mapped linearly from power 0..100. */
  vMin: number;
  vMax: number;
}

export const AMMO: Record<AmmoKind, AmmoSpec> = {
  // The scalpel: knocks out or shoves one cube.
  marble: { size: { radius: 0.2 }, material: 'steel', vMin: 5, vMax: 15 },
  // Brute force: about 7x the marble's energy, so it costs leverage.
  cannonball: { size: { radius: 0.5 }, material: 'steel', vMin: 5, vMax: 12 },
  // The Jenga push: a rod fired along its own axis at a face.
  cue: { size: { half: [1.2, 0.1, 0.1] }, material: 'steel', vMin: 1.5, vMax: 5 },
  // An anvil released at rest above the structure.
  drop: { size: { half: [0.4, 0.4, 0.4] }, material: 'steel', vMin: 0, vMax: 0 },
};

export type PresetItem = `p-${PresetName}`;
export type WeaponItem = `w-${string}`;
/** Items fired from the launcher ring, whose shots are LaunchShots. */
export type LaunchItem = 'marble' | 'cannonball' | PresetItem | WeaponItem;
export type RackItem = AmmoKind | PresetItem | WeaponItem;

/** A weapon's key in LevelDef.weapons and after `w-`: lower case letters and digits, so shot text's `.` and `_` stay separators. */
export const WEAPON_KEY = /^[a-z][a-z0-9]{0,23}$/;

export type ItemRef = { kind: 'ammo'; ammo: AmmoKind } | { kind: 'preset'; preset: PresetName } | { kind: 'weapon'; key: string };

/** What a rack item name refers to, or null if it names nothing. */
export function itemRef(name: string): ItemRef | null {
  if ((AMMO_KINDS as readonly string[]).includes(name)) return { kind: 'ammo', ammo: name as AmmoKind };
  const rest = name.slice(2);
  if (name.startsWith('p-') && isPreset(rest)) return { kind: 'preset', preset: rest };
  if (name.startsWith('w-') && WEAPON_KEY.test(rest)) return { kind: 'weapon', key: rest };
  return null;
}

export const isRackItem = (name: string): name is RackItem => itemRef(name) !== null;
export const isLaunchItem = (name: string): name is LaunchItem => {
  const r = itemRef(name);
  return r !== null && (r.kind !== 'ammo' || r.ammo === 'marble' || r.ammo === 'cannonball');
};

/** For error messages: every name a rack item may have. */
export const RACK_ITEM_NAMES = `${AMMO_KINDS.join(', ')}, p-<preset> (${PRESET_NAMES.join(', ')}) or w-<weapon>`;

/**
 * Model density per real density. Keystone's structure materials are model-scale (a
 * plaster cube is a hollow 31 kg maquette block, materials.ts) with its stone (625)
 * standing for real stone (STONE_DENSITY, 2400), so a real thing thrown at it keeps its
 * real mass ratio to a stone block: x 0.26. Keystone's own ammo stays solid steel.
 */
export const MODEL_DENSITY = MATERIALS[materialId('stone')]!.density / STONE_DENSITY;

/**
 * The body a rack grenade flies in: as small and as fast as the marble, but iron, so
 * its own impact is a quarter of a plaster cube's mass and the blast does the work.
 */
export const GRENADE_SHELL: AmmoSpec = { size: { radius: 0.2 }, material: 'iron', vMin: 5, vMax: 15 };

/**
 * The grenade a level gets for `w-grenade` when its weapons have none. Lengths (blast
 * radius, prox) are in h, the rest SI, as LevelDef.weapons are (levelWeapon converts).
 * DEFAULT_GRENADE is tuned for the viewer's 1 kg, 1 m scene cubes; at Keystone's scale
 * its core gives a plaster cube (31 kg, A/m 0.012 m^2/kg) only 0.48 m/s. Here a plain
 * plaster cube in the core (0.6 h) gets 640 x 0.012 = 7.7 m/s, a stone one 3.1 m/s, and
 * the blast reaches 3 h (about 110 cubes of a packed block). maxSpeed 20 m/s keeps a
 * kicked half-metre cube to 0.33 m a step, under the tunnelling rule's 0.8 m.
 */
export const KEYSTONE_GRENADE: GrenadeSpec = {
  fuse: 'prox', delay: 1, prox: 0.25, arm: 0.1, ground: true,
  blast: { radius: 3, impulse: 640, falloff: 1, core: 0.2, maxDv: 15, maxSpeed: 20 },
};

/** A rack item resolved to a body and a speed range, in metres and m/s. */
export interface ItemSpec {
  /** Sphere radius, or box half-extents along (+x, y, z) before turning, m. */
  size: { radius: number } | { half: Vec3 };
  density: number;
  friction: number;
  restitution: number;
  /** Launch speed range in m/s, mapped linearly from power 0..100. */
  vMin: number;
  vMax: number;
}

/** What item `name` fires in a level of `unit` metres per h. Throws on a name that is not a rack item. */
export function itemSpec(name: RackItem, unit: number): ItemSpec {
  const r = itemRef(name);
  if (!r) throw new Error(`rack item ${JSON.stringify(name)} is not one of ${RACK_ITEM_NAMES}`);
  if (r.kind === 'preset') {
    const p = PROJECTILE_PRESETS[r.preset];
    return { size: { radius: p.diameter / 2 }, density: p.density * MODEL_DENSITY, friction: p.friction, restitution: p.restitution, vMin: p.speed / 2, vMax: p.speed };
  }
  const a = r.kind === 'ammo' ? AMMO[r.ammo] : GRENADE_SHELL, m = MATERIALS[materialId(a.material)]!;
  const size = 'radius' in a.size ? { radius: a.size.radius * unit } : { half: a.size.half.map((x) => x * unit) as Vec3 };
  return { size, density: m.density, friction: m.friction, restitution: m.restitution, vMin: a.vMin, vMax: a.vMax };
}

/** Launch speed, m/s, of `name` at power 0..100: linear over its speed range. */
export function speedOf(name: RackItem, power: number): number {
  const { vMin, vMax } = itemSpec(name, DEFAULT_UNIT);
  return vMin + ((vMax - vMin) * power) / 100;
}

/**
 * Weapon `key` of a level in world units (lengths times the level's unit), checked
 * (checkGrenade); w-grenade without one is KEYSTONE_GRENADE. Null if the level has no
 * such weapon.
 */
export function levelWeapon(def: { unit?: number; weapons?: Record<string, GrenadeSpec> }, key: string): GrenadeSpec | null {
  const own = def.weapons && Object.hasOwn(def.weapons, key) ? def.weapons[key]! : null;
  const g = own ?? (key === 'grenade' ? KEYSTONE_GRENADE : null);
  if (!g) return null;
  const h = def.unit ?? DEFAULT_UNIT;
  return checkGrenade({ ...g, prox: g.prox * h, blast: { ...g.blast, radius: g.blast.radius * h } });
}

/** Engine bodies an item can add when fired: one for a thrown thing (a WeaponSpec's static budget, after V3). */
export const itemBodies = (_name: RackItem): number => 1;

/** Engine bodies the whole rack can add: what an engine must hold beyond the structure. */
export const rackBodies = (rack: readonly RackItem[]): number => rack.reduce((a, x) => a + itemBodies(x), 0);

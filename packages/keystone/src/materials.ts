// Units, materials and body roles. Lengths in levels are authored in cube
// edges (h); the compiler converts to metres. Densities are real (kg/m^3) so
// masses, energies and the leverage score have physical meaning.
import { TAG_BALL } from '@tb/engine-api';

/** Metres per cube edge. A 12-course column (6 m) falls in about 1.1 s: weighty but readable. */
export const DEFAULT_UNIT = 0.5;
/** Horizontal gap between lattice cells, as a fraction of h. Packed (gap 0) cube lattices never fall asleep in Rapier. */
export const DEFAULT_GAP = 0.02;
export const GRAVITY = 9.81;

export interface Material { name: string; density: number; friction: number; restitution: number }

// Structure materials are model-scale: a plaster cube is a hollow 31 kg
// maquette block, not 125 kg of solid plaster. At solid densities a 33 kg
// steel marble barely shoves a loaded cube and a cannonball moves a whole row
// about 10 cm before friction stops it (measured on Rapier), so nothing is fun.
// Ratios between structure materials are kept; ammo stays solid steel/iron.
export const MATERIALS = [
  { name: 'plaster', density: 250, friction: 0.6, restitution: 0.05 },
  { name: 'stone', density: 625, friction: 0.7, restitution: 0.02 },
  { name: 'iron', density: 1950, friction: 0.5, restitution: 0 },
  { name: 'ice', density: 225, friction: 0.05, restitution: 0.05 },
  { name: 'rubber', density: 275, friction: 0.9, restitution: 0.6 },
  { name: 'steel', density: 7800, friction: 0.5, restitution: 0.1 },
] as const satisfies readonly Material[];

export type MaterialName = (typeof MATERIALS)[number]['name'];
export const materialId = (name: MaterialName): number => MATERIALS.findIndex((m) => m.name === name);

/** What a structure body means to the rules. Ammo is not a structure body. */
export const ROLES = ['plain', 'crown', 'heritage'] as const;
export type Role = (typeof ROLES)[number];
export const AMMO_ROLE = 255;

const PART_LIMIT = 4096;

/**
 * BodyDesc.tag for a structure body: role * 4096 + part (the authored part it
 * came from, for colouring and debugging). Ammo uses TAG_BALL.
 */
export function encodeTag(role: Role, part: number): number {
  if (!Number.isInteger(part) || part < 0 || part >= PART_LIMIT) throw new Error(`part ${part} out of range [0, ${PART_LIMIT})`);
  return ROLES.indexOf(role) * PART_LIMIT + part;
}

export function decodeTag(tag: number): { role: Role | 'ammo'; part: number } {
  if (tag === TAG_BALL) return { role: 'ammo', part: 0 };
  const role = ROLES[Math.floor(tag / PART_LIMIT)];
  if (tag < 0 || !role) throw new Error(`tag ${tag} is not a keystone tag`);
  return { role, part: tag % PART_LIMIT };
}

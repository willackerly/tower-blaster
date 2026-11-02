// Nominal blast yield (docs/game/spectacle-mode.md, section 4): the kinetic energy
// a blast would give a solid fill of one kind of block at rest, filling its sphere.
// The rules charge a blast this static figure in "energy fired" rather than the
// energy it actually injects, which grows with the bodies inside the radius and
// so would make a well-placed grenade (in the dense base) cost more than one
// wasted in the air. Static, so the validator and a weapon's budget can use it.
//
//   Y = integral over the ball of 1/2 rho min(maxDv, maxSpeed, I w(d) A/m)^2 dV
//
// with rho = block mass / the volume of its lattice cell and A/m that block's
// silhouette per mass (engine-api blastArea), w the blast's falloff
// (blastWeight: integer powers by repeated multiply). Evaluated by a fixed
// midpoint rule over YIELD_SHELLS shells of equal thickness, with only + - * /,
// so it is the same number on every machine.
//
// One unit for every weapon (grenadeEnergies): the yield of the viewer's grenade,
// DEFAULT_GRENADE, against the viewer's own world (CUBE_FILL: packed 1 kg cubes of
// edge 1). A weapon in those cube units scales to a level (keystone arsenal.ts
// cubeScale: lengths x h, speeds x sqrt h, densities x the block's) with every blast's
// yield scaled by the same factor, so a weapon's yield over the grenade's is the same
// number on every level: a property of the weapon, not of where it is fired.
import { blastArea, blastWeight, checkBlast } from '@tb/engine-api';
import { DEFAULT_GRENADE, type GrenadeBlast } from './grenade.ts';
import { type MunitionSpec, weaponBudget } from './spec.ts';

export const YIELD_SHELLS = 1024;

/** The block a nominal yield is measured against: a solid fill of it at rest. */
export interface YieldFill {
  /** Block mass per volume of its lattice cell, kg/m^3: a packed fill's bulk density. */
  density: number;
  /** One block's silhouette area per mass (engine-api blastArea / mass), m^2/kg. */
  areaPerMass: number;
}

/** Nominal yield of `blast` against `fill`, J. */
export function nominalYield(blast: GrenadeBlast, fill: YieldFill): number {
  if (!(fill.density >= 0 && fill.areaPerMass >= 0)) throw new Error(`nominalYield: bad fill ${JSON.stringify(fill)}`);
  const b = checkBlast({ centre: [0, 0, 0], ...blast });
  const cap = Math.min(b.maxDv, b.maxSpeed), dr = b.radius / YIELD_SHELLS;
  let sum = 0;
  for (let k = 0; k < YIELD_SHELLS; k++) {
    const d = (k + 0.5) * dr;
    const v = Math.min(cap, b.impulse * blastWeight(b, d) * fill.areaPerMass);
    sum += v * v * d * d;
  }
  // 1/2 rho v^2 over a shell of area 4 pi d^2 and thickness dr.
  return 2 * Math.PI * fill.density * sum * dr;
}

/** The viewer's world: packed scene cubes, 1 kg each, edge 1, pitch 1. */
export const CUBE_FILL: YieldFill = { density: 1, areaPerMass: blastArea({ kind: 'box', half: [0.5, 0.5, 0.5] }) };

/**
 * A weapon's nominal yield against `fill`, J: every blast it can set off (weaponBudget, each
 * as often as it can go off) with the engine's defaults filled in. The rack's charge for it.
 */
export function weaponYield(spec: MunitionSpec, fill: YieldFill): number {
  let y = 0;
  for (const { blast, count } of weaponBudget(spec).blasts) {
    const b = checkBlast({ centre: [0, 0, 0], ...blast });
    y += count * nominalYield({ radius: b.radius, impulse: b.impulse, falloff: b.falloff, core: b.core, maxDv: b.maxDv, maxSpeed: b.maxSpeed }, fill);
  }
  return y;
}

/** One grenade: DEFAULT_GRENADE's nominal yield in the viewer's world (CUBE_FILL), J. */
export const GRENADE_YIELD = nominalYield(DEFAULT_GRENADE.blast, CUBE_FILL);

/** A weapon in the viewer's cube units, in grenades: its yield over GRENADE_YIELD (the same on every level it scales to). */
export const grenadeEnergies = (spec: MunitionSpec): number => weaponYield(spec, CUBE_FILL) / GRENADE_YIELD;

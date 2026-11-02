// Built-in WeaponSpecs, in the units of a scene of 1 m cubes (1 kg each) at
// 60 Hz: the viewer's proj.weapon=<name> (scaled with the world, as the
// grenade is), and examples to copy. Every number is a starting point to tune.
//
// Energy: each built-in carries one grenade (grenadeEnergies, yield.ts: the
// viewer's grenade, which is also B1-B3's bomb), within 1%, so a rack of them is
// a choice of how the energy is spread, not of how much there is. Until
// 2026-11-02 the firework carried 0.39 grenades and the cluster 0.80.
import { DEFAULT_GRENADE } from './grenade.ts';
import { grenadeAsSpec, type WeaponSpec } from './spec.ts';

/** Up and over: at the top of its arc (or after 4 s) 12 stars burst out on a cone round its heading; each blows on touching anything. 12 stars of 1/12 grenade: 1.004 grenades. */
export const FIREWORK: WeaponSpec = {
  version: 1, name: 'firework',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [25, 45] },
  rules: [{ when: { any: [{ apex: true }, { after: 4 }] }, do: [{ split: { into: 12, child: 'star', pattern: 'cone', angle: 50, spread: 10, at: 1.5 } }] }],
  children: {
    star: {
      shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 6 },
      rules: [{ when: { any: [{ near: 0.1, arm: 0.25 }, { after: 5 }] }, do: [{ blast: { radius: 3, impulse: 18.5, core: 0.2 } }, { remove: true }] }],
    },
  },
};

/** Breaks up near its target into 6 bomblets that scatter and go off where they land (or after 3 s). 6 bomblets of 1/6 grenade: 0.994 grenades. */
export const CLUSTER: WeaponSpec = {
  version: 1, name: 'cluster',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 6, speed: [20, 45] },
  rules: [{ when: { any: [{ near: 3, arm: 0.2 }, { after: 6 }] }, do: [{ split: { into: 6, child: 'bomblet', pattern: 'sphere', spread: 5, at: 1 } }] }],
  children: {
    bomblet: {
      shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 8 },
      rules: [{ when: { any: [{ near: 0.15, arm: 0.1 }, { after: 3 }] }, do: [{ blast: { radius: 3, impulse: 30, core: 0.2 } }, { remove: true }] }],
    },
  },
};

/** The built-in grenade as a spec (Grenades' DEFAULT_GRENADE, in a 0.2-radius iron ball). */
export const GRENADE_WEAPON: WeaponSpec = grenadeAsSpec(DEFAULT_GRENADE, { shape: { kind: 'sphere', radius: 0.2 }, density: 8, speed: [5, 40] });

/**
 * The viewer's grenade in sizes, each 4x the energy of the last: S 1/4, M 1, L 4, XL 16 grenades. A
 * bigger one reaches further, not harder: the blast's radius grows as the cube root of the energy
 * (yield goes as radius cubed when the falloff is the same shape) and the kick at a given fraction of
 * the radius stays DEFAULT_GRENADE's, so every size keeps its maxDv and maxSpeed (under the sweep).
 * Radii are written out (5 x 4^(k/3), rounded) since Math.cbrt is not the same on every machine; the
 * shells grow alike. Rack names w-grenades, w-grenadem, w-grenadel, w-grenadexl.
 */
export const GRENADE_SIZES = { grenades: 0.25, grenadem: 1, grenadel: 4, grenadexl: 16 } as const;
const sized = (name: keyof typeof GRENADE_SIZES, radius: number, shell: number): WeaponSpec =>
  grenadeAsSpec({ ...DEFAULT_GRENADE, blast: { ...DEFAULT_GRENADE.blast, radius } }, { shape: { kind: 'sphere', radius: shell }, density: 8, speed: [5, 40] }, name);
export const GRENADE_S = sized('grenades', 3.15, 0.13);
export const GRENADE_M = sized('grenadem', 5, 0.2);
export const GRENADE_L = sized('grenadel', 7.94, 0.32);
export const GRENADE_XL = sized('grenadexl', 12.6, 0.5);

/** By name: the viewer's proj.weapon values besides grenade (which keeps its own grenade.* knobs), and the rack's w-<name> defaults. */
export const BUILTIN_WEAPONS: Readonly<Record<string, WeaponSpec>> = {
  firework: FIREWORK, cluster: CLUSTER, grenades: GRENADE_S, grenadem: GRENADE_M, grenadel: GRENADE_L, grenadexl: GRENADE_XL,
};

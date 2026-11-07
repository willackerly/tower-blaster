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

// Charges (docs/design/charges.md): specs a level attaches to its structure bodies (LevelDef.charges),
// in the same cube units, scaled to the level's blocks as w- items are. Their shell is only their look
// (a charge has no body); speed [0, 0]. Not rack items: a thrown weapon cannot removeTarget.
const CHARGE_SHELL = { shape: { kind: 'box' as const, half: [0.15, 0.1, 0.15] as [number, number, number] }, density: 1, speed: [0, 0] as [number, number] };

/** The demolition cutter: when armed, a small blast at its point (3 m/s to a cube in its core) and its host taken out. */
export const CUTTER: WeaponSpec = {
  version: 1, name: 'cutter', shell: CHARGE_SHELL,
  rules: [{ when: { after: 0 }, do: [{ blast: { radius: 1.5, impulse: 2, core: 0.2 } }, { removeTarget: true }] }],
};

/** A kicker: when armed, a blast at its point that shoves its host (and its neighbours) away from it; the host stays. */
export const KICKER: WeaponSpec = {
  version: 1, name: 'kicker', shell: CHARGE_SHELL,
  rules: [{ when: { after: 0 }, do: [{ blast: { radius: 2, impulse: 4, core: 0.2 } }, { remove: true }] }],
};

/** A sympathetic relay (arm it at start): once its host has moved 5 cm or reaches 0.5 m/s, a cutter's blast and its host out. */
export const RELAY: WeaponSpec = {
  version: 1, name: 'relay', shell: CHARGE_SHELL,
  rules: [{ when: { moved: 0.05, speed: 0.5 }, do: [{ blast: { radius: 1.5, impulse: 2, core: 0.2 } }, { removeTarget: true }] }],
};

/**
 * A release (Rube Lab's start, docs/game/rube-lab.md): when armed, its host is taken out with no blast at all, so a
 * pinned trapdoor or gate opens and what it held starts moving under gravity alone. Charged as a pull is (pullEnergy).
 */
export const RELEASE: WeaponSpec = {
  version: 1, name: 'release', shell: CHARGE_SHELL,
  rules: [{ when: { after: 0 }, do: [{ removeTarget: true }] }],
};

/**
 * How long a detonator waits for its fuse, seconds from the plunger: longer than any fuse a level's budget lays (M5b;
 * keystone fuse-boards.test checks every fuse site: one lane given the whole budget burns in under 11 s).
 */
export const DETONATOR_WAIT = 15;

/**
 * A detonator (Fuse & Fold's domino fuses, M5b; docs/game/fuse-and-fold.md): rides a column and watches the socket
 * domino at the end of a fuse (ChargeDef.watch). Armed by the plunger, it fires as a relay does (5 cm or 0.5 m/s:
 * the socket tipping, the wave arriving), a cutter's blast and its column out; with no wave by DETONATOR_WAIT
 * seconds (a dead fuse) it stands down. Its timer holds the shot open while the fuse burns, which a watching relay
 * never does.
 */
export const DETONATOR: WeaponSpec = {
  version: 1, name: 'detonator', shell: CHARGE_SHELL,
  rules: [
    { when: { moved: 0.05, speed: 0.5 }, do: [{ blast: { radius: 1.5, impulse: 2, core: 0.2 } }, { removeTarget: true }] },
    { when: { after: DETONATOR_WAIT }, do: [{ remove: true }] },
  ],
};

/** By name: the charges a level may name without writing them into its weapons. */
export const BUILTIN_CHARGES: Readonly<Record<string, WeaponSpec>> = { cutter: CUTTER, kicker: KICKER, relay: RELAY, release: RELEASE, detonator: DETONATOR };

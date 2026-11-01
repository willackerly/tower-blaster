// Built-in WeaponSpecs, in the units of a scene of 1 m cubes (1 kg each) at
// 60 Hz: the viewer's proj.weapon=<name> (scaled with the world, as the
// grenade is), and examples to copy. Every number is a starting point to tune.
import { DEFAULT_GRENADE } from './grenade.ts';
import { grenadeAsSpec, type WeaponSpec } from './spec.ts';

/** Up and over: at the top of its arc (or after 4 s) 12 stars burst out on a cone round its heading; each blows on touching anything. */
export const FIREWORK: WeaponSpec = {
  version: 1, name: 'firework',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [25, 45] },
  rules: [{ when: { any: [{ apex: true }, { after: 4 }] }, do: [{ split: { into: 12, child: 'star', pattern: 'cone', angle: 50, spread: 10, at: 1.5 } }] }],
  children: {
    star: {
      shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 6 },
      rules: [{ when: { any: [{ near: 0.1, arm: 0.25 }, { after: 5 }] }, do: [{ blast: { radius: 2.5, impulse: 15, core: 0.2 } }, { remove: true }] }],
    },
  },
};

/** Breaks up near its target into 6 bomblets that scatter and go off where they land (or after 3 s). */
export const CLUSTER: WeaponSpec = {
  version: 1, name: 'cluster',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 6, speed: [20, 45] },
  rules: [{ when: { any: [{ near: 3, arm: 0.2 }, { after: 6 }] }, do: [{ split: { into: 6, child: 'bomblet', pattern: 'sphere', spread: 5, at: 1 } }] }],
  children: {
    bomblet: {
      shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 8 },
      rules: [{ when: { any: [{ near: 0.15, arm: 0.1 }, { after: 3 }] }, do: [{ blast: { radius: 3, impulse: 25, core: 0.2 } }, { remove: true }] }],
    },
  },
};

/** The built-in grenade as a spec (Grenades' DEFAULT_GRENADE, in a 0.2-radius iron ball). */
export const GRENADE_WEAPON: WeaponSpec = grenadeAsSpec(DEFAULT_GRENADE, { shape: { kind: 'sphere', radius: 0.2 }, density: 8, speed: [5, 40] });

/** By name: the viewer's proj.weapon values besides grenade (which keeps its own grenade.* knobs). */
export const BUILTIN_WEAPONS: Readonly<Record<string, WeaponSpec>> = { firework: FIREWORK, cluster: CLUSTER };

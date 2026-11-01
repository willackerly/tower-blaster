// The big levels of the spectacle slice (roadmap G5, spectacle-mode.md
// section 11): outcome levels of 1k to 10k blocks, ids B1 to B5 so they never
// clash with scenario ids. Their racks, objectives and weapons come from
// exploration runs (pnpm keystone:cast --draft <name> --explore 16; keystone-lab
// drafts.ts holds the variants tried) and their stars from casts (section 6).
// The building blocks here (outcomeLevel, thirdBondWall, BOMB, RAM) are shared
// with the drafts so a draft that wins becomes a level unchanged.
import { DEFAULT_GRENADE, grenadeAsSpec, type WeaponSpec } from '@tb/weapons';
import type { LevelDef, Part } from './level.ts';
import type { MaterialName } from './materials.ts';
import type { RackItem } from './rack.ts';

type V2 = [number, number];

/**
 * An outcome level whose lot reaches 3 cells inside the launcher ring (every shot is live from
 * launch: validateLevel's launcher issue) and whose launcher ring clears the structure by 4 cells.
 * `half` is the structure's footprint half-extent in cells (x, z) around the origin.
 */
export function outcomeLevel(id: string, name: string, parts: Part[], half: V2, top: number, rack: RackItem[], extra: Partial<LevelDef> = {}): LevelDef {
  const radius = Math.hypot(half[0], half[1]) + 4, reach = Math.max(radius - 3, half[0] + 2, half[1] + 2);
  return {
    id, name, version: 1, world: 3, scoring: 'outcome', parts,
    lot: { min: [-reach, -reach], max: [reach, reach] },
    crownLine: 2, objective: { kind: 'collapse', min: 0.2 }, par: rack.length, rack,
    launcher: { radius, y: 2, dropY: Math.ceil(top) + 4 },
    ...extra,
  };
}

/**
 * A free-standing wall one cube thick, `w` long and `h` courses high, in third bond: every other
 * course shifted a third of a cube, so joints never line up and the end cubes overhang a third (a
 * half bond's ends overhang half and tip: validateLevel's unsupported issue).
 */
export function thirdBondWall(w: number, h: number, material: MaterialName): Part[] {
  return Array.from({ length: h }, (_, k) => ({ kind: 'block' as const, at: [-w / 2 + (k % 2 ? 1 / 3 : 0) - 1 / 6, k, -0.5] as [number, number, number], size: [w, 1, 1] as [number, number, number], material }));
}

/**
 * The viewer's grenade (DEFAULT_GRENADE, radius 5 cubes) as a WeaponSpec in a fast shell, in the viewer's cube
 * units: scaled to the level it pushes blocks as the viewer's grenade pushes cubes, and its shell (15 to 50
 * cubes/s: 11 to 35 m/s at h 0.5) reaches across a big level's launcher ring, where the Keystone grenade's
 * shell (5 to 15 m/s) falls short.
 */
export const BOMB: WeaponSpec = grenadeAsSpec(DEFAULT_GRENADE, { shape: { kind: 'sphere', radius: 0.4 }, density: 8, speed: [15, 50] }, 'bomb');

/** A battering ball in the viewer's cube units: radius 2 cubes at a quarter of the block's density (about 8 blocks' mass), 15 to 30 cubes/s, no fuse. */
export const RAM: WeaponSpec = { version: 1, name: 'ram', shell: { shape: { kind: 'sphere', radius: 2 }, density: 0.25, speed: [15, 30] }, rules: [] };

/**
 * B1 Long Wall: 1,000 plaster cubes, a wall 40 long and 25 high in third bond, three bombs, collapse 0.4.
 * Chosen from the Metal exploration (drafts B1a-c, 16 competent plays each, M5 Max): three bombs took a
 * competent player's median collapse to 0.42, 0.65, 0.70 shot by shot (objective met by 81%, 100%, 100%) and
 * settled soonest; two wrecking balls and a bomb (B1b) needed the ammo-ratio exception and ran most shots to
 * the settle cap; two rams and a bomb (B1a) reached 0.42 only with the bomb.
 */
export const B1: LevelDef = outcomeLevel('B1', 'Long Wall', thirdBondWall(40, 25, 'plaster'), [20.2, 0.5], 25, ['w-bomb', 'w-bomb', 'w-bomb'], {
  objective: { kind: 'collapse', min: 0.4 },
  weapons: { bomb: BOMB },
});

/** The slice's levels in play order (the game's series when one of them is opened). */
export const BIG_LEVELS: readonly LevelDef[] = [B1];

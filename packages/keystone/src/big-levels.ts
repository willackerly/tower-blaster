// The big levels of the spectacle slice (roadmap G5, spectacle-mode.md
// section 11): outcome levels of 1k to 10k blocks, ids B1 to B5 so they never
// clash with scenario ids. Their racks, objectives and weapons come from
// exploration runs (pnpm keystone:cast --draft <name> --explore 16; keystone-lab
// drafts.ts holds the variants tried) and their stars from casts (section 6).
// The building blocks here (outcomeLevel, thirdBondWall, BOMB, RAM) are shared
// with the drafts so a draft that wins becomes a level unchanged.
import { DEFAULT_GRENADE, grenadeAsSpec, type WeaponSpec } from '@tb/weapons';
import { checkStars, type LevelDef, type Part, type StarsDef } from './level.ts';
import { readShots } from './shots.ts';
import { buildScenario } from '@tb/scenarios';
import type { ScenarioPart } from './scenario-part.ts';
import type { MaterialName } from './materials.ts';
import type { RackItem } from './rack.ts';
import CAST_STARS from './stars.json' with { type: 'json' };

type V2 = [number, number];

/**
 * Every big level's cast stars by id (stars.json): the file a cast writes (pnpm keystone:cast <id>
 * --stars-into packages/keystone/src/stars.json), so new stars drop in without a code change. A
 * level absent from it plays uncast (only the objective's star).
 */
export const STARS_FILE: Readonly<Record<string, StarsDef>> = Object.fromEntries(Object.entries(CAST_STARS as Record<string, unknown>).map(([id, s]) => [id, checkStars(s, `stars.json ${id}`)]));

/** The `stars` field for level `id` from stars.json, or nothing when it has none yet. */
export const castOf = (id: string): { stars?: StarsDef } => (STARS_FILE[id] ? { stars: STARS_FILE[id] } : {});

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
  // Cast on the M5 Max (Metal) at main f5d6e92, short recipe, seeds 1 and 2 pooled (pnpm keystone:cast B1 --pool):
  // every gate passed on both, recast |T3 1 - T3 2| 0.0015 < 0.0044. docs/game/levels/B1.md.
  // The showcase (solutions.ace) is seed 1's best line: its 50 nudges ended at collapse 0.895 to 0.955.
  solutions: { ace: readShots('w-bomb.521.8.54.372.66_w-bomb.607.8.-192.247.95_w-bomb.195.8.-230.127.91') },
  // Cast under settle v3, the outcome default until PT6b made it v4: pinned so the cast stars keep their hash.
  // Unpin (drop this line) together with a v4 recast on Metal (roadmap PT6b, docs/game/settle-v4.md).
  settle: 'v3',
  ...castOf('B1'),
});

/**
 * A city of 10,000 cubes (S4: N 10000, towers F x F and 25 high, `street` cells apart) as an outcome level.
 * S4 lays ceil(sqrt(towers)) towers a side; the footprint half-extent follows from that.
 */
export function cityLevel(id: string, name: string, material: MaterialName, F: number, street: number, rack: RackItem[], extra: Partial<LevelDef> = {}): LevelDef {
  const side = Math.ceil(Math.sqrt(Math.ceil(10000 / (F * F * 25)))), half = (side * (F + street) - street) / 2 + 0.5;
  const part: ScenarioPart = { kind: 'scenario', id: 'S4', params: { N: 10000, F, H: 25, street }, material };
  return outcomeLevel(id, name, [part], [half, half], 25, rack, extra);
}

/**
 * B3 Ten Thousand: the S4 city at 10,000 stone cubes (towers 5 x 5 x 25, streets 3), three bombs, collapse 0.4.
 * From the Metal exploration (drafts B3a-e): a third bomb beats a wrecking ball or a ram after two bombs
 * (which added nothing); the skyline stayed 1.0 in every play (some tower always stands), so the level is
 * judged on collapse; 20 iterations (B3e) ran every shot to settle v2's cap for about the same outcomes, so
 * it keeps the game's 40. Competent median collapse 0.32, 0.46, 0.48 shot by shot (objective met 88%, 100%, 100%).
 */
export const B3: LevelDef = cityLevel('B3', 'Ten Thousand', 'stone', 5, 3, ['w-bomb', 'w-bomb', 'w-bomb'], {
  objective: { kind: 'collapse', min: 0.4 },
  weapons: { bomb: BOMB },
  // Cast on the M5 Max (Metal): seeds 1 (a406519) and 2 (23c0df8), pooled with T3 from the best line found
  // (--t3 best, seed 1's cloud extended to 100 nudges) and the skill gate's shortfall (0.082 of 0.100) waived
  // (docs/game/levels/B3.md: Will delegated the call, 2026-11-06). The showcase (solutions.ace) is seed 1's best line: its 50 nudges ended at collapse 0.375 to 0.794.
  solutions: { ace: readShots('w-bomb.471.8.146.696.89_w-bomb.394.8.-89.565.70_w-bomb.381.8.-183.645.78') },
  // Cast under settle v3, the outcome default until PT6b made it v4: pinned so the cast stars keep their hash.
  // Unpin (drop this line) together with a v4 recast on Metal (roadmap PT6b, docs/game/settle-v4.md).
  settle: 'v3',
  ...castOf('B3'),
});

/** B2's town: S14, 25 towers 4 x 4 cubes and up to 16 high (heights varied 40%), streets 4, seed 3: 5,184 plaster cubes. */
export const B2_TOWN = { params: { towers: 25, W: 4, D: 4, H: 16, street: 4, vary: 0.4 }, seed: 3 } as const;

/** Each tower of B2's town by tag: its centre (x, z) and its height in cubes. */
function townTowers(): Map<number, { x: number; z: number; top: number; k: number }> {
  const towers = new Map<number, { x: number; z: number; top: number; k: number }>();
  for (const b of buildScenario('S14', { ...B2_TOWN.params }, B2_TOWN.seed).bodies) {
    const t = towers.get(b.tag) ?? { x: 0, z: 0, top: 0, k: 0 };
    t.x += b.pos[0]; t.z += b.pos[2]; t.top = Math.max(t.top, b.pos[1] + 0.5); t.k++;
    towers.set(b.tag, t);
  }
  for (const t of towers.values()) { t.x /= t.k; t.z /= t.k; }
  return towers;
}

/**
 * A "Spare the Cathedral" level on B2's town: crowns on the tallest tower's roof (the whole roof course, 16, or
 * the 4 in its middle, `crowns`), heritage on the middle tower's top two courses (the cathedral, 32 watched
 * bodies), objective every crown down, footprint limit 0.05.
 */
export function cathedralLevel(id: string, rack: RackItem[], extra: Partial<LevelDef> = {}, crowns: 'roof' | 'middle' = 'middle'): LevelDef {
  const { params, seed } = B2_TOWN, towers = townTowers();
  let tag = 0;
  for (const [t, v] of towers) if (v.top > towers.get(tag)!.top) tag = t;
  const tallest = towers.get(tag)!, centre = Math.floor(params.towers / 2), side = Math.ceil(Math.sqrt(params.towers));
  const part: ScenarioPart = {
    kind: 'scenario', id: 'S14', params: { ...params }, seed, material: 'plaster',
    roles: [
      { role: 'heritage', tag: centre, course: [Math.max(0, towers.get(centre)!.top - 2), 1000] },
      crowns === 'roof' ? { role: 'crown', tag, top: true }
        : { role: 'crown', tag, top: true, box: { min: [tallest.x - 1, -1e9, tallest.z - 1], max: [tallest.x + 1, 1e9, tallest.z + 1] } },
    ],
  };
  const half = (side * (params.W + params.street) - params.street) / 2 + 0.5;
  return outcomeLevel(id, 'Spare the Cathedral', [part], [half, half], tallest.top, rack, { objective: { kind: 'crowns', footprintMax: 0.05 }, ...extra });
}

/**
 * B2 Spare the Cathedral: 5,184 plaster cubes in 25 towers; bring down the 4 crowns in the middle of the tallest
 * roof with a bomb and two rams, sparing the cathedral (the middle tower's top two courses). Stars by score
 * (the tally: heritage broken costs 500 a cube, unused rack items earn 400). From the Metal explorations: aimed
 * anywhere, competent play downed the crowns in 0 to 6% of plays (B2a-c); aimed at the crown tower (#144), the
 * whole 16-cube roof fell in 13% (median 10 of 16) and the middle 4 in 31% (B2d, median 3 of 4) with the
 * cathedral intact in the median play. A drop after the rams (B2d) and a third ram (B2e) changed neither.
 */
export const B2: LevelDef = cathedralLevel('B2', ['w-bomb', 'w-ram', 'w-ram'], {
  weapons: { bomb: BOMB, ram: RAM },
  // Cast on the M5 Max (Metal) at main 29fc193, short recipe, seed 1, metric score: every gate passed (103 min).
  // Its cloud was extended to 100 nudges (--extend, 2026-11-06: T3 3,200 -> 3,000). docs/game/levels/B2.md.
  // The showcase (solutions.ace) is seed 1's best line: its 100 nudges ended at score -10,010 to 3,711.
  solutions: { ace: readShots('w-bomb.500.8.155.173.79_w-ram.711.8.273.259.95_w-ram.528.8.216.481.80') },
  // Cast under settle v3, the outcome default until PT6b made it v4: pinned so the cast stars keep their hash.
  // Unpin (drop this line) together with a v4 recast on Metal (roadmap PT6b, docs/game/settle-v4.md).
  settle: 'v3',
  ...castOf('B2'),
});

/** The slice's levels in play order (the game's series when one of them is opened). */
export const BIG_LEVELS: readonly LevelDef[] = [B1, B2, B3];

// Aftershock's levels (M7, docs/game/aftershock.md): a site is a few towers on open ground, each condemned (its
// top is a crown: bring it down) or protected (its top is heritage: it must still stand when the dust settles).
// The player has one quake. aftershockLevel builds the LevelDef; the shipped levels are the sites that passed the
// design search's choice-matters gate (keystone-lab quake-search.ts; numbers in docs/game/mode-probes.md, X6).
import type { BuildDef } from './build.ts';
import type { LevelDef } from './level.ts';
import { QUAKE } from './rack.ts';
import type { QuakeRules } from './quake.ts';
import type { QuakeShot } from './shots.ts';
import { parseTower, towerFootprint, towerHeight, towerParts } from './aftershock-towers.ts';

/**
 * One tower on a site: its id (aftershock-towers.ts), its footprint's min corner in cells, its class, and whether a
 * wall lies along x. A 'city' tower is neither condemned nor protected: the rest of the town (a retrofit's sturdy
 * neighbours, which a brace may tie a protected tower back to).
 */
export interface SiteTower { tower: string; at: [number, number]; role: 'condemned' | 'protected' | 'city'; yawed?: boolean }

export interface QuakeSite {
  id: string;
  name: string;
  towers: SiteTower[];
  /** The quake dial (default QUAKE_DEFAULTS). */
  quake?: QuakeRules;
  /** Engine-and-rules version, as LevelDef.version. */
  version?: number;
  /**
   * A retrofit (M7b, docs/game/aftershock.md "Retrofit"): what the player may place before the quake (C9's build
   * phase). A retrofit's quake is the level's own (quake.fixed), and it needs no condemned tower.
   */
  build?: BuildDef;
}

/**
 * A site as a level: the towers' parts in site order, one quake in the rack, outcome scoring with the quake
 * objective and the standing heritage rule. The lot is the towers' bounding box grown by the tallest tower's height
 * plus 2 cells, so a condemned crown thrown out of it is down (crownDown) and no protected tower is judged by the
 * lot. The crown line is half the lowest condemned crown's height: a felled tower's crown lies on the ground or on
 * its own rubble well under it, a standing one well over it. The launcher (unused: a quake fires nothing) sits
 * inside the lot, as validateLevel asks of outcome levels.
 */
export function aftershockLevel(site: QuakeSite): LevelDef {
  if (!site.towers.some((t) => t.role === 'protected')) throw new Error(`site ${site.id}: needs a protected tower`);
  if (!site.build && !site.towers.some((t) => t.role === 'condemned')) throw new Error(`site ${site.id}: needs a condemned tower (a retrofit, with a build block, needs only protected ones)`);
  if (site.build && !site.quake?.fixed) throw new Error(`site ${site.id}: a retrofit's quake is the level's own (quake.fixed)`);
  const specs = site.towers.map((t) => parseTower(t.tower));
  const tallest = Math.max(...specs.map(towerHeight)), grow = tallest + 2;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  site.towers.forEach((t, i) => {
    const [fx, fz] = towerFootprint(specs[i]!, t.yawed);
    x0 = Math.min(x0, t.at[0]); z0 = Math.min(z0, t.at[1]); x1 = Math.max(x1, t.at[0] + fx); z1 = Math.max(z1, t.at[1] + fz);
  });
  const lot = { min: [x0 - grow, z0 - grow] as [number, number], max: [x1 + grow, z1 + grow] as [number, number] };
  // No condemned tower (a retrofit): the line only has to sit under every protected top, which 'standing' judges anyway.
  const lowestCrown = Math.min(tallest - 0.5, ...site.towers.flatMap((t, i) => (t.role === 'condemned' ? [towerHeight(specs[i]!) - 0.5] : [])));
  const radius = Math.floor(Math.min(lot.max[0] - lot.min[0], lot.max[1] - lot.min[1]) / 2) - 1;
  return {
    id: site.id, name: site.name, version: site.version ?? 1, world: 7,
    parts: site.towers.flatMap((t, i) => towerParts(specs[i]!, t.at, t.role === 'condemned' ? 'crown' : t.role === 'protected' ? 'heritage' : 'plain', t.yawed)),
    // In the level file's key order (viewer level-file.ts), so a level saved and loaded hashes as it was built.
    lot, crownLine: lowestCrown / 2, objective: { kind: 'quake' }, par: 1, rack: [QUAKE], launcher: { radius, y: 1, dropY: tallest + 4 }, scoring: 'outcome',
    // Every Aftershock cast and gate ran under settle v3 (the outcome default before PT6b's v4): named, so the stars
    // keep their hash whichever default is on main, and in the level file's place for it, so a saved level hashes alike.
    settle: 'v3',
    ...(site.build ? { build: site.build } : {}),
    ...(site.quake ? { quake: site.quake } : {}),
    heritage: 'standing',
  };
}

/**
 * The design search's candidate sites (QC-*), before the gate: `pnpm keystone:quake levels QC-1,...`. Each puts one
 * lever in front of the player (docs/game/aftershock.md, "Levels"). Towers stand in a row (along z; Cross Grain's
 * along x), spaced so a tower felled across the row clears its neighbours; a quake along the row throws them into
 * each other, which is the player's call.
 */
export const QUAKE_SITES: Readonly<Record<string, QuakeSite>> = {
  // Amplitude: slow sway fells the slender towers and spares the squat ones, if it is not too strong.
  'QC-1': { id: 'QC-1', name: 'Slow Sway', towers: [
    { tower: 'col8', at: [0, 0], role: 'condemned' }, { tower: 'col4', at: [0, 6], role: 'protected' },
    { tower: 'col7', at: [0, 12], role: 'condemned' }, { tower: 'col3', at: [0, 18], role: 'protected' },
  ] },
  // Axis: bonded walls fall across their thin side and stand along their length. The row runs along x, so the axis
  // that fells the condemned walls (laid along x) and spares the protected (along z) is 90 degrees, not the dial's
  // starting 0: the first search had the row along z, its answer at 0 (182 of 325 grid quakes there, 1 at 45, none
  // at 90), so a player who never touched the axis was right by default.
  'QC-2': { id: 'QC-2', name: 'Cross Grain', towers: [
    { tower: 'wall6x3', at: [0, 0], role: 'condemned', yawed: true }, { tower: 'wall6x3', at: [8, -1], role: 'protected' },
    { tower: 'wall6x3', at: [14, 0], role: 'condemned', yawed: true }, { tower: 'wall6x3', at: [22, -1], role: 'protected' },
  ] },
  // Size: the same slenderness, a big tower and small columns; slow sway fells all of them, 1 Hz only the small.
  'QC-3': { id: 'QC-3', name: 'Big Brother', towers: [
    { tower: 'col4', at: [0, 0], role: 'condemned' }, { tower: 'slab8x2', at: [0, 5], role: 'protected' }, { tower: 'col4', at: [0, 11], role: 'condemned' },
  ] },
  // Duration: a long quake fells the tall towers first; a short sharp one fells the short and the tall ride it out.
  'QC-4': { id: 'QC-4', name: 'Short Sharp Shock', towers: [
    { tower: 'col3', at: [0, 0], role: 'condemned' }, { tower: 'col8', at: [0, 5], role: 'protected' },
    { tower: 'col4', at: [0, 10], role: 'condemned' }, { tower: 'col7', at: [0, 15], role: 'protected' },
  ] },
  // Two levers: the axis for the walls, and a short 1 Hz jolt for the column against the big tower.
  'QC-5': { id: 'QC-5', name: 'Fault Line', towers: [
    { tower: 'wall6x3', at: [0, 0], role: 'condemned' }, { tower: 'slab8x2', at: [0, 6], role: 'protected' },
    { tower: 'col4', at: [0, 12], role: 'condemned' }, { tower: 'wall8x2', at: [-1, 17], role: 'protected', yawed: true },
  ] },
};

/**
 * The retrofit's quake (M7b): a short sharp jolt, 0.3 g at 1 Hz for 1 s. The design search (keystone-lab
 * retrofit-search.ts) found it fells a lone column of 5 or 6 cubes on every nudged build, while a pier half the
 * column's height either side of it, or a plank tying its top to a sturdy hall, saves it on every build.
 */
export const RETROFIT_QUAKE = { peak: 30, hz: 10, sec: 10 } as const;

/** What a retrofit lets the player place: cubes, the course stamps and the ties (no domino brush: nothing to topple). */
export const RETROFIT_BUILD: BuildDef = { budget: 200, pieces: ['cube', 'pier3', 'course4', 'wall4x2', 'plank', 'beam', 'slab'], brush: false };

const hall = (at: [number, number], n = 6): SiteTower => ({ tower: `slab${n}x3`, at, role: 'city' });
const keep = (tower: string, at: [number, number]): SiteTower => ({ tower, at, role: 'protected' });

/**
 * The retrofit search's candidate sites (RC-*), before the gate: `pnpm keystone:retrofit RC-1,...`. Protected
 * columns among sturdy halls (slab towers 3 cells square, which the quake does not move): a column with a hall of its
 * own height one cell away along the quake's axis can be tied to it, and any column can be buttressed.
 */
export const RETROFIT_SITES: Readonly<Record<string, QuakeSite>> = {
  // Each column has a hall on one side along x and open ground on the other: tie it to the hall, or buttress it. (A
  // column between two halls a cell away cannot fall: it leans on one at 10 degrees and stands, so none stands so.)
  'RC-1': { id: 'RC-1', name: 'Lean on Me', quake: { fixed: { ...RETROFIT_QUAKE, axis: 0 } }, build: RETROFIT_BUILD, towers: [
    keep('col6', [0, 0]), hall([2, -1]), keep('col6', [9, 0]), hall([11, -1]), keep('col6', [18, 0]), hall([20, -1]),
  ] },
  // The quake runs along z. Two columns have a hall along z to tie to; two have halls only along x, which a tie across
  // the quake does not help: they must be buttressed, along z.
  'RC-2': { id: 'RC-2', name: 'Cross Ties', quake: { fixed: { ...RETROFIT_QUAKE, axis: 90 } }, build: RETROFIT_BUILD, towers: [
    keep('col6', [0, 0]), hall([-1, 2]), hall([2, -1]),
    keep('col5', [8, 0]), hall([10, -1], 5),
    keep('col6', [16, 0]), hall([15, -4]), hall([18, -1]),
    keep('col5', [24, 0]),
  ] },
  // An old town: six columns of five and six, some beside halls along the quake, some alone.
  'RC-3': { id: 'RC-3', name: 'Old Town', quake: { fixed: { ...RETROFIT_QUAKE, axis: 0 } }, build: RETROFIT_BUILD, towers: [
    keep('col6', [4, 0]), hall([6, -1]),
    keep('col5', [12, 0]), keep('col6', [16, 0]), hall([18, -1]),
    hall([0, 7], 5), keep('col5', [4, 8]), keep('col6', [9, 8]), hall([11, 7]),
    hall([16, 6], 5), keep('col5', [16, 11]),
  ] },
};

/** A retrofit candidate's level (RETROFIT_SITES), or throws naming the ids there are. */
export function retrofitCandidate(id: string): LevelDef {
  const s = RETROFIT_SITES[id];
  if (!s) throw new Error(`no retrofit site ${id}: one of ${Object.keys(RETROFIT_SITES).join(', ')}`);
  return aftershockLevel(s);
}

/** A candidate site's level (QUAKE_SITES), or throws naming the ids there are. */
export function quakeCandidate(id: string): LevelDef {
  const s = QUAKE_SITES[id];
  if (!s) throw new Error(`no quake site ${id}: one of ${Object.keys(QUAKE_SITES).join(', ')}`);
  return aftershockLevel(s);
}

/**
 * A shipped Aftershock level: a candidate site that passed the gate, under its own id and name, with the budget and
 * the energy stars the search cast for it (keystone-lab quake-search.ts quakeStars). The towers are the site's
 * exactly, so the physics the gate judged is the physics played; the id, the budget and the stars are not physics.
 * The star lines are joules, an input the same on every engine; whether a quake clears the level is the engine's,
 * and the aces clear every shipped level on the GPU solver (keystone-lab test quake-aces.ts), so the stars are the
 * game engine's (engine 'gpu': onEngine marks them custom elsewhere). The stars record the shipped level's hash
 * (castStars drops them if the towers ever change); the ace is the cast's best quake, the three-star play tests
 * replay.
 */
const q = (peak: number, hz: number, sec: number, axis = 0): QuakeShot => ({ ammo: QUAKE, peak, hz, sec, axis });

function shipped(site: string, id: string, name: string, ace: QuakeShot, cast: { t2: number; t3: number; best: number; budget: number; n: number; hash: string }): LevelDef {
  const s = QUAKE_SITES[site]!;
  return {
    ...aftershockLevel({ ...s, id, name, quake: { ...s.quake, budget: cast.budget } }),
    stars: { metric: 'energy', t2: cast.t2, t3: cast.t3, best: cast.best, castOn: 'node ref, aces checked on the GPU', engine: 'gpu', hash: cast.hash, n: cast.n, seed: 1 },
    solutions: { ace: [ace] },
  };
}

/**
 * Aftershock's levels in teaching order (docs/game/aftershock.md, "Levels"; the search's numbers in
 * docs/game/mode-probes.md, X6 "On levels"): amplitude first (many quakes clear Slow Sway), then size, then the axis
 * (Cross Grain's walls), then the short sharp shock only a narrow band of the dial clears, and last two levers at
 * once (Fault Line: the axis for the walls and a short 1 Hz jolt for the column against the big tower). Cast on the
 * reference engine over the dial grid (325 quakes along x, 975 over three axes for the wall sites), the confirm
 * stage on 8 nudged builds. The hashes were re-recorded once (M7b) when the level's keys were put in the level file's
 * order (and the hash's quake keys in a fixed one), so a saved level reads back to the same hash; the geometry and the
 * casts are unchanged.
 */
export const A1: LevelDef = shipped('QC-1', 'A1', 'Slow Sway', q(25, 10, 10), { t2: 200, t3: 39, best: 34.91481483474812, budget: 800, n: 325, hash: '871b10a9190a2b98' });
export const A2: LevelDef = shipped('QC-3', 'A2', 'Big Brother', q(40, 10, 10), { t2: 720, t3: 180, best: 162.51259268537308, budget: 2900, n: 325, hash: 'e235f97e2a1bcbc7' });
export const A3: LevelDef = shipped('QC-2', 'A3', 'Cross Grain', q(25, 10, 10, 90), { t2: 2000, t3: 130, best: 114.26666673190293, budget: 8000, n: 975, hash: '9cb53a2945cb309e' });
export const A4: LevelDef = shipped('QC-4', 'A4', 'Short Sharp Shock', q(50, 10, 15), { t2: 280, t3: 240, best: 209.4888890084887, budget: 1200, n: 325, hash: '5aade697bb7e8296' });
export const A5: LevelDef = shipped('QC-5', 'A5', 'Fault Line', q(40, 10, 10), { t2: 1400, t3: 320, best: 284.39703719940286, budget: 5600, n: 975, hash: 'b9e3256a4c5cb28d' });

export const AFTERSHOCK_LEVELS: readonly LevelDef[] = [A1, A2, A3, A4, A5];

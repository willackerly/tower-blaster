// Aftershock's levels (M7, docs/game/aftershock.md): a site is a few towers on open ground, each condemned (its
// top is a crown: bring it down) or protected (its top is heritage: it must still stand when the dust settles).
// The player has one quake. aftershockLevel builds the LevelDef; the shipped levels are the sites that passed the
// design search's choice-matters gate (keystone-lab quake-search.ts; numbers in docs/game/mode-probes.md, X6).
import type { LevelDef } from './level.ts';
import { QUAKE } from './rack.ts';
import type { QuakeRules } from './quake.ts';
import type { QuakeShot } from './shots.ts';
import { parseTower, towerFootprint, towerHeight, towerParts } from './aftershock-towers.ts';

/** One tower on a site: its id (aftershock-towers.ts), its footprint's min corner in cells, its class, and whether a wall lies along x. */
export interface SiteTower { tower: string; at: [number, number]; role: 'condemned' | 'protected'; yawed?: boolean }

export interface QuakeSite {
  id: string;
  name: string;
  towers: SiteTower[];
  /** The quake dial (default QUAKE_DEFAULTS). */
  quake?: QuakeRules;
  /** Engine-and-rules version, as LevelDef.version. */
  version?: number;
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
  if (!site.towers.some((t) => t.role === 'condemned') || !site.towers.some((t) => t.role === 'protected')) throw new Error(`site ${site.id}: needs a condemned and a protected tower`);
  const specs = site.towers.map((t) => parseTower(t.tower));
  const tallest = Math.max(...specs.map(towerHeight)), grow = tallest + 2;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  site.towers.forEach((t, i) => {
    const [fx, fz] = towerFootprint(specs[i]!, t.yawed);
    x0 = Math.min(x0, t.at[0]); z0 = Math.min(z0, t.at[1]); x1 = Math.max(x1, t.at[0] + fx); z1 = Math.max(z1, t.at[1] + fz);
  });
  const lot = { min: [x0 - grow, z0 - grow] as [number, number], max: [x1 + grow, z1 + grow] as [number, number] };
  const lowestCrown = Math.min(...site.towers.flatMap((t, i) => (t.role === 'condemned' ? [towerHeight(specs[i]!) - 0.5] : [])));
  const radius = Math.floor(Math.min(lot.max[0] - lot.min[0], lot.max[1] - lot.min[1]) / 2) - 1;
  return {
    id: site.id, name: site.name, version: site.version ?? 1, world: 7,
    parts: site.towers.flatMap((t, i) => towerParts(specs[i]!, t.at, t.role === 'condemned' ? 'crown' : 'heritage', t.yawed)),
    lot, crownLine: lowestCrown / 2, objective: { kind: 'quake' }, par: 1, rack: [QUAKE], scoring: 'outcome', heritage: 'standing',
    launcher: { radius, y: 1, dropY: tallest + 4 },
    ...(site.quake ? { quake: site.quake } : {}),
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
 * stage on 8 nudged builds.
 */
export const A1: LevelDef = shipped('QC-1', 'A1', 'Slow Sway', q(25, 10, 10), { t2: 200, t3: 39, best: 34.91481483474812, budget: 800, n: 325, hash: '567eb703f042c3a2' });
export const A2: LevelDef = shipped('QC-3', 'A2', 'Big Brother', q(40, 10, 10), { t2: 720, t3: 180, best: 162.51259268537308, budget: 2900, n: 325, hash: '21116792ca85189b' });
export const A3: LevelDef = shipped('QC-2', 'A3', 'Cross Grain', q(25, 10, 10, 90), { t2: 2000, t3: 130, best: 114.26666673190293, budget: 8000, n: 975, hash: 'a79c199d0db089ae' });
export const A4: LevelDef = shipped('QC-4', 'A4', 'Short Sharp Shock', q(50, 10, 15), { t2: 280, t3: 240, best: 209.4888890084887, budget: 1200, n: 325, hash: '45fe7a6f75ff5f0a' });
export const A5: LevelDef = shipped('QC-5', 'A5', 'Fault Line', q(40, 10, 10), { t2: 1400, t3: 320, best: 284.39703719940286, budget: 5600, n: 975, hash: 'd0da8dd2abf44dbd' });

export const AFTERSHOCK_LEVELS: readonly LevelDef[] = [A1, A2, A3, A4, A5];

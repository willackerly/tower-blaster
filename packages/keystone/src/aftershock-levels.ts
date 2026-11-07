// Aftershock's levels (M7, docs/game/aftershock.md): a site is a few towers on open ground, each condemned (its
// top is a crown: bring it down) or protected (its top is heritage: it must still stand when the dust settles).
// The player has one quake. aftershockLevel builds the LevelDef; the shipped levels are the sites that passed the
// design search's choice-matters gate (keystone-lab quake-search.ts; numbers in docs/game/mode-probes.md, X6).
import type { LevelDef } from './level.ts';
import { QUAKE } from './rack.ts';
import type { QuakeRules } from './quake.ts';
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
 * lever in front of the player (docs/game/aftershock.md, "Levels"). Towers stand in rows along z, spaced so a tower
 * felled along x clears its neighbours; a quake along z throws them into each other, which is the player's call.
 */
export const QUAKE_SITES: Readonly<Record<string, QuakeSite>> = {
  // Amplitude: slow sway fells the slender towers and spares the squat ones, if it is not too strong.
  'QC-1': { id: 'QC-1', name: 'Slow Sway', towers: [
    { tower: 'col8', at: [0, 0], role: 'condemned' }, { tower: 'col4', at: [0, 6], role: 'protected' },
    { tower: 'col7', at: [0, 12], role: 'condemned' }, { tower: 'col3', at: [0, 18], role: 'protected' },
  ] },
  // Axis: bonded walls fall across their thin side and stand along their length.
  'QC-2': { id: 'QC-2', name: 'Cross Grain', towers: [
    { tower: 'wall6x3', at: [0, 0], role: 'condemned' }, { tower: 'wall6x3', at: [-1, 8], role: 'protected', yawed: true },
    { tower: 'wall6x3', at: [0, 14], role: 'condemned' }, { tower: 'wall6x3', at: [-1, 22], role: 'protected', yawed: true },
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

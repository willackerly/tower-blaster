// The built-in series. The chamber levels L1 to L5 are in chamber-levels.ts
// (apart, so the trials can build on them without an import cycle):
// starter levels, one per behaviour the mechanics probe found usable
// (pnpm keystone:probe): shear, lintel tip, pick-off, catapult, dominoes.
// Coordinates are in cells (h); see LevelDef. Par lines are the most robust
// clean solutions pnpm keystone:bot found on the f64 AVBD reference at
// AVBD_ITERATIONS and AVBD_GAP_SLOP (docs/game/findings.md), and tests replay
// them. lGold is the lower quartile of the leverage the par line's clean
// neighbours on the nudge grid reach (pnpm keystone:par): the gold-leverage
// badge's line. Stars are strokes and heritage only (rules.ts parStars,
// docs/game/stars.md).
import { BIG_LEVELS } from './big-levels.ts';
import { LEVELS } from './chamber-levels.ts';
import { TRIAL_LEVELS } from './trial-levels.ts';
import { UNDERCUT_LEVELS } from './undercut-levels.ts';
import { FUSE_LEVELS } from './fuse-levels.ts';
import { RUBE_LEVELS } from './rube-levels.ts';
import type { LevelDef } from './level.ts';

export { L1, L2, L3, L4, L5, LEVELS } from './chamber-levels.ts';

/**
 * Every built-in level's series: the chamber levels (L1 to L5), the big levels (B1 on), Undercut's (U1 on),
 * Fuse & Fold's (F1 on: fuse-levels.ts) and the trials (T-..., unrated: trial-levels.ts). A level plays on into the rest of its own series.
 */
export const SERIES: readonly (readonly LevelDef[])[] = [LEVELS, BIG_LEVELS, UNDERCUT_LEVELS, RUBE_LEVELS, FUSE_LEVELS, TRIAL_LEVELS];

/** Each series' title, in SERIES order (the game's door heads its sections with them). */
export const SERIES_TITLES: readonly string[] = ['Chamber', 'Spectacle', 'Undercut', 'Rube Lab', 'Fuse & Fold', 'Trials · unrated'];

const sameId = (a: string, b: string) => a.toUpperCase() === b.toUpperCase();

/** The series holding the built-in level with this id (any case), or undefined. */
export function seriesOf(id: string): readonly LevelDef[] | undefined {
  return SERIES.find((s) => s.some((l) => sameId(l.id, id)));
}

/** A built-in level (chamber, big, Undercut or trial) by id, any case, or undefined. */
export function findLevel(id: string): LevelDef | undefined {
  return seriesOf(id)?.find((l) => sameId(l.id, id));
}

/** A built-in level by id, any case; throws naming the known ones (the rated ones, then how many trials). */
export function levelById(id: string): LevelDef {
  const def = findLevel(id);
  if (!def) throw new Error(`unknown level ${id.toUpperCase()}; known: ${SERIES.slice(0, -1).flat().map((l) => l.id).join(', ')} and ${TRIAL_LEVELS.length} trials (${TRIAL_LEVELS[0]!.id} to ${TRIAL_LEVELS.at(-1)!.id})`);
  return def;
}

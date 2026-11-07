// The built-in levels by series (the chamber levels are in chamber-levels.ts) and lookup by id.
import { BIG_LEVELS } from './big-levels.ts';
import { CHORUS_LEVELS } from './chorus-levels.ts';
import { TRIAL_LEVELS } from './trial-levels.ts';
import { UNDERCUT_LEVELS } from './undercut-levels.ts';
import { AFTERSHOCK_LEVELS } from './aftershock-levels.ts';
import { FUSE_LEVELS } from './fuse-levels.ts';
import { RUBE_LEVELS } from './rube-levels.ts';
import { MASON_LEVELS } from './mason-levels.ts';
import { WAVE_LEVELS } from './wave-levels.ts';
import type { LevelDef } from './level.ts';

export { L1, L2, L3, L4, L5 } from './chamber-levels.ts';
import { L1, L2, L3, L4, L5 } from './chamber-levels.ts';

/** The chamber levels, scored on par (the game's default series). */
export const LEVELS: readonly LevelDef[] = [L1, L2, L3, L4, L5];

/**
 * Every built-in level's series: the chamber levels (L1 to L5), the big levels (B1 on), Undercut's (U1 on),
 * Rube Lab's (RL1 on), Fuse & Fold's (F1 on: fuse-levels.ts), Aftershock's (A1 on), Wavefront's (W3 on), Mason's Trial's (MT1 on: mason-levels.ts), Chorus's (CH1 on: chorus-levels.ts) and the trials (T-..., unrated: trial-levels.ts).
 * A level plays on into the rest of its own series.
 */
export const SERIES: readonly (readonly LevelDef[])[] = [LEVELS, BIG_LEVELS, UNDERCUT_LEVELS, RUBE_LEVELS, FUSE_LEVELS, AFTERSHOCK_LEVELS, WAVE_LEVELS, MASON_LEVELS, CHORUS_LEVELS, TRIAL_LEVELS];

/** Each series' title, in SERIES order (the game's door heads its sections with them). */
export const SERIES_TITLES: readonly string[] = ['Chamber', 'Spectacle', 'Undercut', 'Rube Lab', 'Fuse & Fold', 'Aftershock', 'Wavefront', "Mason's Trial", 'Chorus', 'Trials · unrated'];

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

// Chorus levels (M9, docs/game/chorus.md "Levels"): the player's one shot goes into 64 jittered copies of
// a small level, and the score is how many of them clear. Each is drawn from a chamber level, keeping its
// structure and launcher, with a one-item rack: the shot that clears the chamber level once is rarely the
// shot that clears most of 64 worlds. Picked for spread: the obvious shot (`CHORUS_LINES.obvious`, the
// straight shot a new player tries) clears some worlds but not all, and a better shot (`best`) exists.
// Evidence is in chorus.md, from the GPU solver (the game's default) and Rapier; chorus-levels tests replay
// both lines on Rapier.
import { L1, L2, L5 } from './chamber-levels.ts';
import type { LevelDef } from './level.ts';
import { readShots, type Shot } from './shots.ts';

/**
 * A chamber level made a Chorus level: one item, scored on the worlds (outcome scoring: no strokes to count).
 * An outcome level's lot reaches the launcher ring less 3 cells (validateLevel's launcher rule: a shot is live
 * only near the lot, so the round cannot settle before it lands), so the lot grows about its own centre, which
 * keeps every shot where it was; a crown is down below the crown line wherever it lies.
 */
function asChorus(base: LevelDef, id: string, rack: LevelDef['rack'], extra: Partial<LevelDef> = {}): LevelDef {
  const { solutions: _s, lGold: _g, stars: _t, ...rest } = base;
  const r = base.launcher.radius - 3, { min, max } = base.lot, cx = (min[0] + max[0]) / 2, cz = (min[1] + max[1]) / 2;
  const lot = { min: [Math.min(min[0], cx - r), Math.min(min[1], cz - r)] as [number, number], max: [Math.max(max[0], cx + r), Math.max(max[1], cz + r)] as [number, number] };
  return { ...rest, id, name: `${base.name} ×64`, version: 1, rack, par: 1, scoring: 'outcome', lot, chorus: {}, ...extra };
}

/** CH1, from L1 (Open Fire): one cannonball, every crown down in each world. */
export const CH1: LevelDef = asChorus(L1, 'CH1', ['cannonball']);

/** CH2, from L2 (Lintel): one cannonball; the lintel must shed all six crowns and miss the pavilion. */
export const CH2: LevelDef = asChorus(L2, 'CH2', ['cannonball']);

/** CH3, from L5 (Dominoes): one marble; the five columns must fall in turn and take the crown on the last. */
export const CH3: LevelDef = asChorus(L5, 'CH3', ['marble']);

/** The Chorus levels, in play order. */
export const CHORUS_LEVELS: readonly LevelDef[] = [CH1, CH2, CH3];

/** Per level: the obvious shot and the best shot found (writeShots lines), with what they clear (chorus.md). */
export const CHORUS_LINES: Readonly<Record<string, { obvious: string; best: string }>> = {
  CH1: { obvious: 'cannonball.360.8.22.252.100', best: 'cannonball.360.8.0.207.100' },
  CH2: { obvious: 'cannonball.540.8.0.616.100', best: 'cannonball.360.8.-24.391.80' },
  CH3: { obvious: 'marble.360.8.0.268.60', best: 'marble.0.8.0.249.60' },
};

/** A Chorus level's line as shots. */
export const chorusLine = (id: string, which: 'obvious' | 'best'): Shot[] => readShots(CHORUS_LINES[id]![which]);

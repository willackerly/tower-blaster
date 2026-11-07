// Chorus levels (M9, docs/game/chorus.md "Levels"): the player's one shot goes into 64 jittered copies of
// a small level, and the score is how many of them clear. Each is drawn from a chamber level, keeping its
// structure and launcher, with a one-item rack: the shot that clears the chamber level once is rarely the
// shot that clears most of 64 worlds. Picked for spread: the obvious shot (`CHORUS_LINES.obvious`, the
// straight shot a new player tries) clears some worlds but not all, and a better shot (`best`) exists.
// Evidence is in chorus.md, from the GPU solver (the game's default) and Rapier; chorus-levels tests replay
// both lines on Rapier.
import { L1, L2, L3 } from './chamber-levels.ts';
import type { LevelDef } from './level.ts';
import { readShots, type Shot } from './shots.ts';

/** A chamber level made a Chorus level: one item, scored on the worlds (outcome scoring: no strokes to count). */
function asChorus(base: LevelDef, id: string, rack: LevelDef['rack'], extra: Partial<LevelDef> = {}): LevelDef {
  const { solutions: _s, lGold: _g, stars: _t, ...rest } = base;
  return { ...rest, id, name: `${base.name} ×64`, version: 1, rack, par: 1, scoring: 'outcome', chorus: {}, ...extra };
}

/** CH1, from L1 (Open Fire): one cannonball, every crown down in each world. */
export const CH1: LevelDef = asChorus(L1, 'CH1', ['cannonball']);

/** CH2, from L2 (Lintel): one cannonball; the lintel must shed all six crowns and miss the pavilion. */
export const CH2: LevelDef = asChorus(L2, 'CH2', ['cannonball']);

/** CH3, from L3 (Surgeon): one marble for one of the two crowns, the heritage between them untouched. */
export const CH3: LevelDef = asChorus(L3, 'CH3', ['marble'], { chorus: { need: 1 } });

/** The Chorus levels, in play order. */
export const CHORUS_LEVELS: readonly LevelDef[] = [CH1, CH2, CH3];

/** Per level: the obvious shot and the best shot found (writeShots lines), with what they clear (chorus.md). */
export const CHORUS_LINES: Readonly<Record<string, { obvious: string; best: string }>> = {
  CH1: { obvious: 'cannonball.360.8.0.250.100', best: 'cannonball.360.8.0.207.100' },
  CH2: { obvious: 'cannonball.540.8.0.616.100', best: 'cannonball.540.8.0.616.100' },
  CH3: { obvious: 'marble.540.8.42.53.80', best: 'marble.540.8.42.24.100' },
};

/** A Chorus level's line as shots. */
export const chorusLine = (id: string, which: 'obvious' | 'best'): Shot[] => readShots(CHORUS_LINES[id]![which]);

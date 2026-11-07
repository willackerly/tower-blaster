// Wavefront's levels (M6, docs/game/wavefront.md): dominoes and towers as
// dominoes. Three verbs (modes-roadmap.md M6): Lay (draw a run from the push to
// the crowns), Steer (the skyline is the layout: pick the first tower, build a
// relay across an avenue) and Cut (a wave is running; take dominoes out to stop it).
// Every level sleeps on the GPU with its structure asleep from the start (C22:
// physics.sleep and physics.asleep), and runs in a window longer than the 30 s cap
// (runWindow), so a long wave is never cut off.
//
// What the reference engine showed for the game's cube towers (2 x 2 columns of
// cubes, 8 courses, plaster; wave-levels.test.ts and docs/game/wavefront.md):
// - A running wave crosses a gap of up to 6 cells (3 m) between towers and dies at
//   7; the first tower, pushed by a ball alone, carries only 2.
// - It runs straight along the push: a row falls end to end and the rows beside
//   it, 2 cells away, stand.
// - A 2 x 2 x 6 relay tower in the middle of a 10-cell avenue carries it across;
//   a 2 x 2 x 4 or a 1 x 2 x 6 does not.
import type { LevelDef, Part } from './level.ts';

type V3 = [number, number, number];

/** A tower: 2 x 2 columns of plaster cubes, `courses` high, at lattice cell (x, z); its top course in `top`'s role when given. */
export function tower(x: number, z: number, courses = 8, top?: 'crown' | 'heritage'): Part {
  return { kind: 'block', at: [x, 0, z] as V3, size: [2, courses, 2] as V3, material: 'plaster', ...(top ? { courses: [{ k: courses - 1, role: top }] } : {}) };
}

/** Cells from one tower's corner to the next along a row: 2 for the tower, 2 for the street. */
export const STREET = 4;

/** Physics and window every Wavefront level plays at: GPU sleep, the structure asleep until reached, a 60 s run window. */
export const WAVE_RULES = { physics: { sleep: true, asleep: true }, runWindow: 60 } as const satisfies Partial<LevelDef>;

/**
 * W3 Fall Line (Steer): a 4 x 4 city of cube towers with 2-cell streets. The crown sits on the north-east tower,
 * a heritage top on the tower south of it. A tower pushed falls along the push and fells its row or column, never
 * the ones beside it, so two first towers reach the crown: the north-west one pushed east (the clean line) and the
 * south-east one pushed north, which brings the heritage down on the way.
 */
export const W3: LevelDef = {
  id: 'W3', name: 'Fall Line', version: 1, world: 3, scoring: 'par', par: 1, rack: ['cannonball', 'cannonball'],
  parts: [0, 1, 2, 3].flatMap((i) => [0, 1, 2, 3].map((j) => tower(i * STREET, j * STREET, 8, i === 3 && j === 3 ? 'crown' : i === 3 && j === 2 ? 'heritage' : undefined))),
  lot: { min: [-3, -3], max: [3 * STREET + 5, 3 * STREET + 5] }, crownLine: 4, objective: { kind: 'crowns' },
  launcher: { radius: 20, y: 6, dropY: 12 },
  ...WAVE_RULES,
};

export const WAVE_LEVELS: readonly LevelDef[] = [W3];

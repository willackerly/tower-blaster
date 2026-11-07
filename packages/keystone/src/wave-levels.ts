// Wavefront's levels (M6, docs/game/wavefront.md): towers falling into towers. Three
// verbs (modes-roadmap.md M6): Lay (draw a domino run from the push to the target),
// Steer (the skyline is the layout: pick the street to push, build a relay across an
// avenue) and Cut (a wave is running; take pieces out to save what is left).
// Every level sleeps on the GPU with its structure asleep from the start (C22:
// physics.sleep and physics.asleep), and runs in a window longer than the 30 s cap
// (runWindow), so a long wave is never cut off.
//
// What the engines showed for the game's cube towers (2 x 2 columns of loose plaster
// cubes, 8 courses; wave-levels.test.ts and docs/game/wavefront.md):
// - A falling tower fells the next one across a street of up to 6 cells (3 m) and
//   dies at 7. It falls straight along the push: the streets beside it stand.
// - A cannonball off the middle of a tower's face fells one of its two columns, and
//   the wave dies a tower or two on. So every street ends in a starter slab: one rigid
//   piece as wide and tall as the tower, which falls square onto it wherever the ball
//   hits its upper two thirds.
// - Crowns and heritage on single cubes are noise at this scale (the debris of a
//   falling street lands on the next one), so Steer is judged on collapse (D), which
//   reads the whole city: on Rapier 8 towers of W3's 20 give 0.19 to 0.22 from any hit
//   on the starter's upper two thirds, 4 towers 0.12, 3 towers 0.10.
// - A relay built in a 10-cell avenue carries the wave across it when it is rigid: a
//   slab as wide and tall as a tower and 1 h thick, from 3.5 to 6 h past the near
//   tower, both ways (at 2.5 to 3 h it is chaotic). A relay tower of loose cubes
//   splits like any tower and carries from some cells and not their neighbours.
import type { LevelDef, Part } from './level.ts';

type V3 = [number, number, number];

/** The lattice pitch every Wavefront level is laid out on, in h (level.ts compileLevel: 1 + the 0.02 gap). */
const PITCH = 1.02;

/** A tower: 2 x 2 columns of plaster cubes, `courses` high, with its corner at lattice cell (x, z). */
export function tower(x: number, z: number, courses = 8): Part {
  return { kind: 'block', at: [x, 0, z] as V3, size: [2, courses, 2] as V3, material: 'plaster' };
}

/**
 * The starter slab's size, h: as wide and tall as a tower, half an h thick, standing 1 h off the tower's face. A
 * ball anywhere on its upper two thirds fells the street on Rapier; on the lowest third it shoves the slab's foot
 * and fells one tower or none. A 6 h slab is safe only on its upper third (wave-levels.test.ts).
 */
export const STARTER = { tall: 8, thick: 0.25, gap: 1 } as const;

/**
 * A starter slab at one end of a north-south street: off the south face of the tower at cell (x, z) (side -1, so
 * it falls north into it) or off its north face (side 1, falls south). One plaster piece as wide as the tower:
 * a ball hits it anywhere and it lands square across both of the tower's columns.
 */
export function starter(x: number, z: number, side: 1 | -1): Part {
  const cx = (x + 1) * PITCH, face = side < 0 ? (z + 0.5) * PITCH - 0.5 : (z + 1.5) * PITCH + 0.5;
  return { kind: 'piece', at: [cx, STARTER.tall / 2, face + side * (STARTER.gap + STARTER.thick)], half: [PITCH / 2 + 0.5, STARTER.tall / 2, STARTER.thick], material: 'plaster' };
}

/** A north-south street of towers at column x, corners at the cells `zs` (south to north), a starter at each end (or only the south one). */
export function street(x: number, zs: readonly number[], ends: 'both' | 'south' = 'both'): Part[] {
  return [...zs.map((z) => tower(x, z)), starter(x, zs[0]!, -1), ...(ends === 'both' ? [starter(x, zs.at(-1)!, 1)] : [])];
}

/** The relay slab's half-extents, h, on the lattice pitch: build.ts catalog's 'relay' (as wide and tall as a tower, 1 h thick). */
export const RELAY_HALF: V3 = [PITCH / 2 + 0.5, 4, 0.5];

/**
 * An authored relay slab across the street at column x, `into` h north of the north face of the tower whose corner
 * is at cell z (the avenue's south edge). As the catalogue's relay: wave-levels.test.ts pins 3.5 to 6 h into a
 * 10-cell avenue as carrying both ways.
 */
export function relaySlab(x: number, z: number, into: number): Part {
  return { kind: 'piece', at: [(x + 1) * PITCH, RELAY_HALF[1], (z + 1.5) * PITCH + 0.5 + into + RELAY_HALF[2]], half: [...RELAY_HALF], material: 'plaster' };
}

/** Physics and window every Wavefront level plays at: GPU sleep, the structure asleep until reached, a 60 s run window. */
export const WAVE_RULES = { physics: { sleep: true, asleep: true }, runWindow: 60 } as const satisfies Partial<LevelDef>;

/** W3's streets: the column and its towers' cells. A is unbroken; B and C each have a gap of 9 the wave dies in. */
export const W3_STREETS: readonly (readonly [number, readonly number[]])[] = [
  [0, [0, 4, 8, 12, 16, 20, 24, 28]],
  [12, [0, 4, 8, 21, 25, 29]],
  [24, [0, 4, 15, 19, 23, 27]],
];

/**
 * W3 Fall Line (Steer): three streets of towers with 10-cell avenues between them, so a tower pushed east or west
 * fells itself alone. Pushed along a street from its starter, the wave fells the street to the first wide gap: all
 * 8 towers of the west street, 3 of the middle one, 4 of the east one from its north end. One stroke clears only on
 * the west street; two broken streets clear it in two.
 */
export const W3: LevelDef = {
  id: 'W3', name: 'Fall Line', version: 2, world: 7, scoring: 'par', par: 1, rack: ['cannonball', 'cannonball'],
  parts: W3_STREETS.flatMap(([x, zs]) => street(x, zs)),
  lot: { min: [-4, -4], max: [29, 35] }, crownLine: 2, objective: { kind: 'collapse', min: 0.16 },
  launcher: { radius: 30, y: 6, dropY: 12 },
  ...WAVE_RULES,
};

/** W4's street: three towers, a 10-cell avenue (cells 10 to 19), four towers. */
export const W4_TOWERS: readonly number[] = [0, 4, 8, 20, 24, 28, 32];

/**
 * W4 Avenue (Steer, a build): one street broken by a 10-cell avenue, and a budget of one relay slab. Pushed from
 * either starter the wave dies at the avenue (3 or 4 towers); a relay standing in the middle third of it carries
 * the wave the length of the street in one stroke.
 */
export const W4: LevelDef = {
  id: 'W4', name: 'Avenue', version: 1, world: 7, scoring: 'par', par: 1, rack: ['cannonball', 'cannonball'],
  parts: street(0, W4_TOWERS),
  lot: { min: [-6, -4], max: [8, 37] }, crownLine: 2, objective: { kind: 'collapse', min: 0.4 },
  launcher: { radius: 26, y: 6, dropY: 12 },
  build: { budget: 16, pieces: ['relay'], brush: false },
  ...WAVE_RULES,
};

/** W5's street: slums (3 towers), an avenue with a relay, slums (3), an avenue with a relay, the village (2, heritage). */
export const W5_TOWERS: readonly number[] = [0, 4, 8, 20, 24, 28, 40, 44];
/** W5's village: its towers' indices in W5_TOWERS, whose top courses are heritage. */
export const W5_VILLAGE: readonly number[] = [6, 7];

/**
 * W5 Firebreak (Cut): one street with a starter at its south end. Three slum towers, a relay slab across a 10-cell
 * avenue, three more, a second relay across a second avenue, then the village: two towers with heritage tops,
 * judged standing at the settle. A pull goes in only while a shot runs (LevelDef.cut), so the wave is cut live:
 * push the starter, then pull the second relay before the front reaches it. The slums fall, the village stands,
 * in par. Pull nothing (or too late) and the village falls with them, a heritage star gone; pull the first relay
 * and the second slums stand, short of the collapse the level asks for.
 */
export const W5: LevelDef = {
  id: 'W5', name: 'Firebreak', version: 1, world: 7, scoring: 'par', par: 2, rack: ['cannonball', 'pull'],
  parts: [
    ...W5_TOWERS.map((z, k) => (W5_VILLAGE.includes(k) ? { ...tower(0, z), courses: [{ k: 7, role: 'heritage' as const }] } : tower(0, z))),
    starter(0, 0, -1), relaySlab(0, 8, 4.75), relaySlab(0, 28, 4.75),
  ],
  lot: { min: [-6, -4], max: [8, 49] }, crownLine: 2, objective: { kind: 'collapse', min: 0.33 }, heritage: 'standing', cut: true,
  launcher: { radius: 32, y: 6, dropY: 12 },
  ...WAVE_RULES,
};

export const WAVE_LEVELS: readonly LevelDef[] = [W3, W4, W5];

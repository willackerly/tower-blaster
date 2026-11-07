// The Siege Table's tables (duel.ts): one per ruleset for the first playtest.
// Names are working names (Will, 2026-11-05: keep them for now); they live in
// DUEL_NAMES only, so a rename is one line. Cell coordinates as in levels.ts.
import type { DuelDef, DuelSide, Ruleset } from './duel.ts';
import type { LevelDef, Part } from './level.ts';
import type { RackItem } from './rack.ts';

/** Every Siege Table display name: the mode, its rulesets and its tables. */
export const DUEL_NAMES = {
  mode: 'Siege Table',
  rulesets: { keeps: 'Two Keeps', heraldry: 'Heraldry' } satisfies Record<Ruleset, string>,
  tables: { D1: 'Two Keeps', D2: 'Heraldry' },
} as const;

/** Owner inks (linear RGB): gold for the first side, blue for the second. */
export const INK = { gold: [0.95, 0.66, 0.16], blue: [0.22, 0.48, 0.98] } as const satisfies Record<string, [number, number, number]>;

/** Launcher arcs (0.5 deg): the west half of the ring (x < 0) and the east half, each 10 deg short of north and south. */
export const WEST_ARC: [number, number] = [200, 520];
export const EAST_ARC: [number, number] = [560, 160];

/** A table's level: outcome-scored, a square lot that reaches 3 cells inside the launcher ring (validateLevel's launcher check). */
function table(id: string, name: string, parts: Part[], radius: number, top: number): LevelDef {
  const reach = radius - 3;
  return {
    id, name, version: 1, world: 9, scoring: 'outcome', parts,
    lot: { min: [-reach, -reach], max: [reach, reach] },
    crownLine: 2, objective: { kind: 'collapse', min: 0 }, par: 1, rack: ['cannonball'],
    launcher: { radius, y: 2, dropY: top + 4 },
  };
}

const KEEP_RACK: RackItem[] = ['cannonball', 'cannonball', 'cannonball', 'w-grenade'];

/** A keep's battlement: four parts ringing the top of a 3 x 3 keep whose west face is at x, leaving its middle cell for the king. */
const battlement = (x: number, y: number): Part[] => [
  { kind: 'block', at: [x, y, -1.5], size: [3, 1, 1], material: 'stone' },
  { kind: 'block', at: [x, y, 0.5], size: [3, 1, 1], material: 'stone' },
  { kind: 'block', at: [x, y, -0.5], size: [1, 1, 1], material: 'stone' },
  { kind: 'block', at: [x + 2, y, -0.5], size: [1, 1, 1], material: 'stone' },
];

/** Block parts as unit cubes, in the order compileLevel expands a block (course by course, then x, then z). */
export function unitCubes(parts: readonly Part[]): Part[] {
  return parts.flatMap((p): Part[] => {
    if (p.kind !== 'block' || p.courses || (p.size[0] === 1 && p.size[1] === 1 && p.size[2] === 1)) return [p];
    const out: Part[] = [];
    for (let k = 0; k < p.size[1]; k++) for (let i = 0; i < p.size[0]; i++) for (let j = 0; j < p.size[2]; j++) out.push({ ...p, at: [p.at[0] + i, p.at[1] + k, p.at[2] + j], size: [1, 1, 1] });
    return out;
  });
}

/** A block part turned half way round the table's vertical axis: (x, z) to (-x, -z). */
export const halfTurn = (p: Part): Part => {
  if (p.kind !== 'block') throw new Error(`halfTurn: only blocks turn, not a ${p.kind}`);
  return { ...p, at: [-p.at[0] - p.size[0], p.at[1], -p.at[2] - p.size[2]] };
};

/** D1's keeps: courses below the battlement (four since PT22; six before). */
export const KEEP_COURSES = 4;
/**
 * Gold's half of D1, as unit cubes: the keep, the king (2 cubes), then the battlement's two courses. Blue's half is
 * the same list turned half way round, cube for cube in the same order (PT22): the solver then meets both keeps'
 * bodies in the same order and with the same neighbours, so a shot and its mirror image play out alike.
 */
const D1_GOLD: Part[] = unitCubes([
  { kind: 'block', at: [-12, 0, -1.5], size: [3, KEEP_COURSES, 3], material: 'stone' },
  { kind: 'block', at: [-11, KEEP_COURSES, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' },
  ...battlement(-12, KEEP_COURSES),
  ...battlement(-12, KEEP_COURSES + 1),
]);
const D1_KING = D1_GOLD.flatMap((p, i) => (p.role === 'crown' ? [i] : []));
const D1_SIDE = D1_GOLD.length, range = (from: number, n: number) => Array.from({ length: n }, (_, k) => from + k);

/**
 * D1 Two Keeps: two 3 x 3 stone keeps four courses high, 21 cells apart, each with a two-course battlement round its
 * top and a gold or blue king, two cubes tall, sunk in the middle of it flush with the top, and a low plaster wall between
 * them that misses turn into rubble ramps. Each side fires from behind its own keep. Topple the other king to win:
 * a king is down once both its cubes have left the battlement (each half a course below its place: off the keep).
 *
 * Stone with a sunk king, since the 2026-11-06 agent playtest (PT5): the first table's plaster keeps with the king on
 * top lost their king to almost any first cannonball, so most novice duels were over in one round (Rapier novice
 * bot, 40 seeds: 28% draws, 2.6 turns a duel); stone keeps with the king in a battlement lasted 5.2 turns, 18% draws.
 * Lower, with a second battlement course, since round 2 (PT22): on a phone's view the novice's first cannonball hit
 * the six-course keep low and felled it, king and all (40 of 72 blocks; 30 of 40 Rapier duels over in 2 turns, a
 * third of them draws). Four courses and a flush king: median 4 turns on the phone, 6 on a wide screen
 * (docs/game/siege-table.md, "Balance").
 * Parts: Gold's keep, king and battlement as unit cubes (D1_SIDE of them), Blue's the same turned half way round, then the wall.
 */
export const D1: DuelDef = {
  id: 'D1', name: DUEL_NAMES.tables.D1, ruleset: 'keeps',
  level: table('D1', DUEL_NAMES.tables.D1, [
    ...D1_GOLD,
    ...D1_GOLD.map(halfTurn),
    { kind: 'block', at: [-0.5, 0, -3], size: [1, 3, 6], material: 'plaster' },
  ], 18, KEEP_COURSES + 2),
  sides: [
    { name: 'Gold', owns: { parts: range(0, D1_SIDE) }, king: { parts: D1_KING }, arc: WEST_ARC, rack: KEEP_RACK, ink: INK.gold },
    { name: 'Blue', owns: { parts: range(D1_SIDE, D1_SIDE) }, king: { parts: D1_KING.map((i) => D1_SIDE + i) }, arc: EAST_ARC, rack: KEEP_RACK, ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

const COURSES = 12;
/**
 * D2's tower, course by course from the bottom: the west face (a column of four cells, x -1.5 to -0.5), the east face
 * (x 0.5 to 1.5) and the core between them in two halves, south (z below 0) and north. Gold owns the east face (the
 * one Blue fires at) and one core half, south on even courses and north on odd ones; Blue the rest. A half turn about
 * the tower's axis maps the west face onto the east and the south core onto the north, so it maps the tower onto
 * itself with the colours swapped.
 */
const HERALD_TOWER: Part[] = Array.from({ length: COURSES }, (_, y): Part[] => [
  { kind: 'block', at: [-1.5, y, -2], size: [1, 1, 4], material: 'stone' },
  { kind: 'block', at: [0.5, y, -2], size: [1, 1, 4], material: 'stone' },
  { kind: 'block', at: [-0.5, y, -2], size: [1, 1, 2], material: 'stone' },
  { kind: 'block', at: [-0.5, y, 0], size: [1, 1, 2], material: 'stone' },
]).flat();
const HERALD_GOLD = unitCubes(HERALD_TOWER.filter((_, i) => { const y = Math.floor(i / 4), k = i % 4; return k === 1 || (k === 2 && y % 2 === 0) || (k === 3 && y % 2 === 1); }));
/**
 * D2's parts as unit cubes, each gold cube followed by its half-turn image, which is blue (PT22): on the GPU solver a
 * contact's first body is the one listed first, and in this order a contact and its mirror image have mirrored first
 * bodies, so neither colour is always first. (Gold's cubes and then Blue's would put gold first in every gold-blue contact.)
 */
const HERALD_PARTS: Part[] = HERALD_GOLD.flatMap((p) => [p, halfTurn(p)]);
/**
 * Heraldry's rack: one cannonball to open the face, then marbles to pick at it (PT22). With two cannonballs each the
 * second cannonball brought down about as much of your own as the rival's (novice median margin 4.5 points over 40
 * Rapier duels; four cannonballs 2), one gives a median margin of 7; four marbles bring nothing down.
 */
const HERALD_RACK: RackItem[] = ['cannonball', 'marble', 'marble', 'marble'];
const heraldOwns = (gold: boolean) => HERALD_PARTS.flatMap((_, i) => (i % 2 === (gold ? 0 : 1) ? [i] : []));

/**
 * D2 Heraldry: one stone tower, 3 by 4 cells and twelve courses high. Each side's colour faces the rival's fire:
 * Blue's blocks make the west face, the one Gold fires at, Gold's the east, and the core between them is mixed. Each
 * shot scores the rival's blocks it brings down, less your own. A shot that breaks the face it meets scores; one that
 * brings the whole tower down costs your own colour behind it.
 *
 * Faces since the 2026-11-07 agent playtest round 2 (PT22): the first table's whole courses (gold at the bottom) gave
 * Gold 29 of 30 novice duels, and their quartered replacement (each course half gold and half blue, swapping course
 * by course) made almost every shot net about zero (+16/-15): 4 of 18 GPU duels went to the tie-break, and a novice
 * could not see what a good shot was. With the faces, a shot at the rival's face nets points and a shot that topples
 * the tower costs (docs/game/siege-table.md, "Balance").
 */
export const D2: DuelDef = {
  id: 'D2', name: DUEL_NAMES.tables.D2, ruleset: 'heraldry',
  // The tower stands at the ring's centre, so a launcher behind the camera fires straight away from the eye (PT34).
  lead: 20,
  level: table('D2', DUEL_NAMES.tables.D2, HERALD_PARTS, 14, COURSES),
  sides: [
    { name: 'Gold', owns: { parts: heraldOwns(true) }, arc: WEST_ARC, rack: HERALD_RACK, ink: INK.gold },
    { name: 'Blue', owns: { parts: heraldOwns(false) }, arc: EAST_ARC, rack: HERALD_RACK, ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

/** The Siege Table's tables, in menu order. */
export const DUELS: readonly DuelDef[] = [D1, D2];

/** A duel table by id or ruleset name (any case: 'D1', 'keeps'), or undefined. */
export function findDuel(key: string): DuelDef | undefined {
  const k = key.toLowerCase();
  return DUELS.find((d) => d.id.toLowerCase() === k || d.ruleset === k);
}

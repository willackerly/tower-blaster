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

/**
 * D1 Two Keeps: two 3 x 3 stone keeps six courses high, 21 cells apart, each with a battlement round its top and a
 * gold or blue king cube sunk in the middle of it, and a low plaster wall between them that misses turn into rubble
 * ramps. Each side fires from behind its own keep. Topple the other king to win.
 *
 * Stone with a sunk king, since the 2026-11-06 agent playtest (PT5): the first table's plaster keeps with the king on
 * top lost their king to almost any first cannonball, so most novice duels were over in one round (Rapier novice
 * bot, 40 seeds: 28% draws, 2.6 turns a duel); stone keeps with the king in a battlement last 5.2 turns, 18% draws,
 * and either side wins about as often (docs/game/siege-table.md, "Balance").
 * Parts: 0 and 1 the keeps, 2 and 3 the kings, 4 the wall, 5 to 8 and 9 to 12 the battlements (west, east).
 */
export const D1: DuelDef = {
  id: 'D1', name: DUEL_NAMES.tables.D1, ruleset: 'keeps',
  level: table('D1', DUEL_NAMES.tables.D1, [
    { kind: 'block', at: [-12, 0, -1.5], size: [3, 6, 3], material: 'stone' },
    { kind: 'block', at: [9, 0, -1.5], size: [3, 6, 3], material: 'stone' },
    { kind: 'block', at: [-11, 6, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' },
    { kind: 'block', at: [10, 6, -0.5], size: [1, 2, 1], material: 'stone', role: 'crown' },
    { kind: 'block', at: [-0.5, 0, -3], size: [1, 3, 6], material: 'plaster' },
    ...battlement(-12, 6),
    ...battlement(9, 6),
  ], 18, 8),
  sides: [
    { name: 'Gold', owns: { parts: [0, 2, 5, 6, 7, 8] }, king: { parts: [2] }, arc: WEST_ARC, rack: KEEP_RACK, ink: INK.gold },
    { name: 'Blue', owns: { parts: [1, 3, 9, 10, 11, 12] }, king: { parts: [3] }, arc: EAST_ARC, rack: KEEP_RACK, ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

const COURSES = 12;
/** D2's half-courses, bottom up, south half (z below 0) then north: Gold owns the south half of even courses and the north half of odd ones. */
const HERALD_PARTS: Part[] = Array.from({ length: 2 * COURSES }, (_, i) => ({ kind: 'block' as const, at: [-1.5, Math.floor(i / 2), i % 2 ? 0 : -2] as [number, number, number], size: [3, 1, 2] as [number, number, number], material: 'stone' as const }));
const heraldOwns = (gold: boolean) => HERALD_PARTS.map((_, i) => i).filter((i) => (Math.floor(i / 2) % 2 === i % 2) === gold);

/**
 * D2 Heraldry: one stone tower, 3 by 4 cells and twelve courses high, quartered: each course half gold and half blue,
 * the halves swapping course by course. Each shot scores the rival's blocks it brings down, less your own.
 *
 * Quartered since the 2026-11-06 agent playtest (PT5): the first table's whole courses (gold at the bottom, blue on
 * top) gave every shot more blue blocks down than gold, so Gold won 29 of 30 novice duels whoever went first. Split
 * north and south, the tower looks the same to each side with the colours swapped, so neither owns the bottom or the
 * top. Stone, so it takes more than one round to bring down. Novice bot, 30 seeds: 15 wins each, 8 turns a duel.
 */
export const D2: DuelDef = {
  id: 'D2', name: DUEL_NAMES.tables.D2, ruleset: 'heraldry',
  level: table('D2', DUEL_NAMES.tables.D2, HERALD_PARTS, 14, COURSES),
  sides: [
    { name: 'Gold', owns: { parts: heraldOwns(true) }, arc: WEST_ARC, rack: ['cannonball', 'cannonball', 'marble', 'marble'], ink: INK.gold },
    { name: 'Blue', owns: { parts: heraldOwns(false) }, arc: EAST_ARC, rack: ['cannonball', 'cannonball', 'marble', 'marble'], ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

/** The Siege Table's tables, in menu order. */
export const DUELS: readonly DuelDef[] = [D1, D2];

/** A duel table by id or ruleset name (any case: 'D1', 'keeps'), or undefined. */
export function findDuel(key: string): DuelDef | undefined {
  const k = key.toLowerCase();
  return DUELS.find((d) => d.id.toLowerCase() === k || d.ruleset === k);
}

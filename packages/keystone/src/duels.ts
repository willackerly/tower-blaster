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

/**
 * D1 Two Keeps: two 3 x 3 keeps six courses high, 21 cells apart, each with a gold or blue king
 * cube on top, and a low wall between them that misses turn into rubble ramps. Each side fires
 * from behind its own keep. Topple the other king to win.
 */
export const D1: DuelDef = {
  id: 'D1', name: DUEL_NAMES.tables.D1, ruleset: 'keeps',
  level: table('D1', DUEL_NAMES.tables.D1, [
    { kind: 'block', at: [-12, 0, -1.5], size: [3, 6, 3], material: 'plaster' },
    { kind: 'block', at: [9, 0, -1.5], size: [3, 6, 3], material: 'plaster' },
    { kind: 'block', at: [-11, 6, -0.5], size: [1, 1, 1], material: 'plaster', role: 'crown' },
    { kind: 'block', at: [10, 6, -0.5], size: [1, 1, 1], material: 'plaster', role: 'crown' },
    { kind: 'block', at: [-0.5, 0, -3], size: [1, 3, 6], material: 'plaster' },
  ], 18, 7),
  sides: [
    { name: 'Gold', owns: { parts: [0, 2] }, king: { parts: [2] }, arc: WEST_ARC, rack: KEEP_RACK, ink: INK.gold },
    { name: 'Blue', owns: { parts: [1, 3] }, king: { parts: [3] }, arc: EAST_ARC, rack: KEEP_RACK, ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

const COURSES = 12;
/**
 * D2 Heraldry: one 3 x 3 tower twelve courses high, its courses gold and blue in turn (gold at the
 * bottom). Each shot scores the rival's blocks it brings down, less your own.
 */
export const D2: DuelDef = {
  id: 'D2', name: DUEL_NAMES.tables.D2, ruleset: 'heraldry',
  level: table('D2', DUEL_NAMES.tables.D2, Array.from({ length: COURSES }, (_, k) => ({ kind: 'block' as const, at: [-1.5, k, -1.5] as [number, number, number], size: [3, 1, 3] as [number, number, number], material: 'plaster' as const })), 14, COURSES),
  sides: [
    { name: 'Gold', owns: { parts: Array.from({ length: COURSES / 2 }, (_, k) => 2 * k) }, arc: WEST_ARC, rack: ['cannonball', 'cannonball', 'marble', 'marble'], ink: INK.gold },
    { name: 'Blue', owns: { parts: Array.from({ length: COURSES / 2 }, (_, k) => 2 * k + 1) }, arc: EAST_ARC, rack: ['cannonball', 'cannonball', 'marble', 'marble'], ink: INK.blue },
  ] as [DuelSide, DuelSide],
};

/** The Siege Table's tables, in menu order. */
export const DUELS: readonly DuelDef[] = [D1, D2];

/** A duel table by id or ruleset name (any case: 'D1', 'keeps'), or undefined. */
export function findDuel(key: string): DuelDef | undefined {
  const k = key.toLowerCase();
  return DUELS.find((d) => d.id.toLowerCase() === k || d.ruleset === k);
}

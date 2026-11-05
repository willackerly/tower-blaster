// The Lot Sheets (docs/game/lot-sheets.md; mode M3): each level's side goals,
// written from explored plays (pnpm keystone:goals <id> --explore) and each
// proven by a recorded line that tests replay (keystone-lab lot-sheets.test.ts)
// on the engine the sheet names. A sheet is data beside its level, never part
// of it: adding or changing one leaves the level's hash and its stars alone.
import type { LotSheet } from './goals.ts';

/** Every level's lot sheet by level id. */
export const LOT_SHEETS: Readonly<Record<string, LotSheet>> = {};

/** The lot sheet for level `id` (any case), or undefined. */
export const lotSheetOf = (id: string): LotSheet | undefined => LOT_SHEETS[id.toUpperCase()];

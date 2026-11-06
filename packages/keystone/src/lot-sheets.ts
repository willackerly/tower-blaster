// The Lot Sheets (docs/game/lot-sheets.md; mode M3): each level's side goals,
// written from explored plays (pnpm keystone:goals <id> --explore) and each
// proven by a recorded line that tests replay (keystone-lab lot-sheets.test.ts)
// on the engine the sheet names. A sheet is data beside its level, never part
// of it: adding or changing one leaves the level's hash and its stars alone.
import type { LotSheet } from './goals.ts';

const cleared = { fact: 'cleared', op: '==', value: 1 } as const;
const intact = { fact: 'heritage', op: '==', value: 0 } as const;

/**
 * L1 Open Fire. Explored 64 competent plays (rack order, marbles first, a lone cannonball): a cannonball
 * aces it about one time in three; the marbles alone never clear it but reach three crowns one time in
 * three, and a well-placed marble levers up to 5x its energy. Proofs: 6 to 8 of 8 nudges meet each goal.
 */
const L1: LotSheet = {
  level: 'L1', engine: 'ref',
  goals: [
    { id: 'ace', text: 'Every crown with the first shot', when: { shot: 1, fact: 'crownsDown', op: '>=', value: 4 }, proof: 'cannonball.43.8.-5.490.69' },
    { id: 'light', text: 'Clear it with most of the tower still up', when: { all: [cleared, { fact: 'collapse', op: '<=', value: 0.4 }] }, proof: 'cannonball.33.8.-9.478.100' },
    { id: 'tidy', text: 'Clear it with no more than 1 block in 8 off the lot', when: { all: [cleared, { fact: 'outOfLot', op: '<=', value: 0.125 }] }, proof: 'cannonball.671.8.2.318.68' },
    { id: 'lever', text: 'One shot that brings down 3x its own energy', when: { fact: 'bestLeverage', op: '>=', value: 3 }, proof: 'marble.355.8.20.370.67' },
    { id: 'marbles', text: 'Three crowns with the marbles alone', when: { all: [{ used: 'cannonball', op: '==', value: 0 }, { fact: 'crowns', op: '>=', value: 3 }] }, proof: 'marble.41.8.35.390.88_marble.504.8.8.441.61' },
  ],
};

/**
 * L2 Lintel. Explored 64 plays: a cannonball clears it in one shot nearly every time, often without
 * touching the pavilion; the marbles alone rarely bring down more than two crowns.
 */
const L2: LotSheet = {
  level: 'L2', engine: 'ref',
  goals: [
    { id: 'spare', text: 'Clear it and leave the pavilion untouched', when: { all: [cleared, intact] }, proof: 'cannonball.329.8.-49.606.93' },
    { id: 'light', text: 'Clear it with half of it up and the pavilion untouched', when: { all: [cleared, intact, { fact: 'collapse', op: '<=', value: 0.5 }] }, proof: 'cannonball.495.8.-14.588.99' },
    { id: 'lever', text: 'One shot that brings down 2.5x its energy, pavilion untouched', when: { all: [intact, { fact: 'bestLeverage', op: '>=', value: 2.5 }] }, proof: 'cannonball.329.8.-49.606.93' },
    { id: 'tidy', text: 'Clear it with no more than 1 block in 12 off the lot', when: { all: [cleared, { fact: 'outOfLot', op: '<=', value: 0.08 }] }, proof: 'cannonball.560.8.6.586.99' },
    { id: 'marbles', text: 'Two crowns with the marbles alone', when: { all: [{ used: 'cannonball', op: '==', value: 0 }, { fact: 'crowns', op: '>=', value: 2 }] }, proof: 'marble.360.8.0.526.80_marble.221.8.-23.499.93' },
  ],
};

/**
 * L3 Surgeon. Explored 64 plays: a heritage neighbour breaks in most of them; the marbles can
 * clear it alone, and a cannonball can in one shot, rarely cleanly.
 */
const L3: LotSheet = {
  level: 'L3', engine: 'ref',
  goals: [
    { id: 'surgeon', text: 'Clear it without touching the heritage cubes', when: { all: [cleared, intact] }, proof: 'marble.193.32.-40.83.92_marble.143.32.34.-117.96' },
    { id: 'marbles', text: 'Clear it with the marbles alone', when: { all: [cleared, { used: 'cannonball', op: '==', value: 0 }] }, proof: 'marble.495.32.32.-130.98_marble.590.32.-30.-50.75_marble.534.32.-1.92.65' },
    { id: 'one', text: 'Clear it with a single shot', when: { all: [cleared, { fact: 'shots', op: '==', value: 1 }] }, proof: 'cannonball.133.32.31.50.83' },
    { id: 'tidy', text: 'Clear it with no more than 1 block in 20 off the lot', when: { all: [cleared, { fact: 'outOfLot', op: '<=', value: 0.05 }] }, proof: 'marble.495.32.32.-130.98_marble.590.32.-30.-50.75_marble.534.32.-1.92.65' },
  ],
};

/**
 * L4 Catapult. Explored 64 plays: the hardest of the five for the bot, which cleared it 3 times. A
 * good anvil drop brings down 6 to 8 of the 9 crowns; clearing it without the anvil never held up to
 * nudges, so it is not a goal.
 */
const L4: LotSheet = {
  level: 'L4', engine: 'ref',
  goals: [
    { id: 'first', text: 'Six crowns with the first shot', when: { shot: 1, fact: 'crownsDown', op: '>=', value: 6 }, proof: 'drop.46.4_marble.703.8.2.266.96_marble.326.8.66.253.86' },
    { id: 'spare', text: 'Clear it and leave both pillars standing', when: { all: [cleared, intact] }, proof: 'drop.46.-4_marble.708.8.-51.5.89_marble.538.8.-238.188.61' },
  ],
};

/**
 * L5 Dominoes. Explored 80 plays: almost any shot takes the crown; the skill is in how much of the
 * run comes down with it, all of it or none.
 */
const L5: LotSheet = {
  level: 'L5', engine: 'ref',
  goals: [
    { id: 'run', text: 'Every domino down with one shot', when: { all: [cleared, { fact: 'shots', op: '==', value: 1 }, { fact: 'collapse', op: '>=', value: 0.7 }] }, proof: 'marble.17.8.83.346.97' },
    { id: 'sniper', text: 'Take the crown and leave the rest standing', when: { all: [cleared, { fact: 'collapse', op: '<=', value: 0.1 }] }, proof: 'marble.166.8.269.414.77' },
    { id: 'lever', text: 'One shot that brings down 3x its own energy', when: { fact: 'bestLeverage', op: '>=', value: 3 }, proof: 'marble.3.8.15.191.86' },
    { id: 'cannon', text: 'Take the crown with the cannonball', when: { all: [cleared, { used: 'marble', op: '==', value: 0 }] }, proof: 'cannonball.308.8.79.453.100' },
  ],
};

/** Every level's lot sheet by level id. */
export const LOT_SHEETS: Readonly<Record<string, LotSheet>> = { L1, L2, L3, L4, L5 };

/** The lot sheet for level `id` (any case), or undefined. */
export const lotSheetOf = (id: string): LotSheet | undefined => LOT_SHEETS[id.toUpperCase()];

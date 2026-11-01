// Draft big levels (roadmap G5) for exploring on Metal before any is
// authored: each is a variant of a slice level from spectacle-mode.md
// section 11 (structure, material, rack, weapon tuning), named
// <level><letter>, played by `pnpm keystone:cast --draft B1a --explore 16`.
// The exploration measures what a competent player gets (collapse after each
// shot, objective rate, crowns, heritage) so the authored levels and their
// objectives come from data, not guesses. Nothing here is a shipped level; the
// building blocks (outcomeLevel, thirdBondWall, BOMB, RAM) are @tb/keystone's
// (big-levels.ts), so a winning draft becomes a level unchanged.
import { BOMB, cathedralLevel, cityLevel, type LevelDef, type MaterialName, outcomeLevel as outcome, type Part, RAM, type RackItem, thirdBondWall } from '@tb/keystone';

const B1_WALL = thirdBondWall(40, 25, 'plaster');
const b1 = (id: string, rack: RackItem[], extra: Partial<LevelDef> = {}) => outcome(id, 'Long Wall', B1_WALL, [20.2, 0.5], 25, rack, extra);

const b3 = (id: string, material: MaterialName, F: number, street: number, rack: RackItem[], extra: Partial<LevelDef> = {}) =>
  cityLevel(id, 'Ten Thousand', material, F, street, rack, extra);

/** B2 drafts: @tb/keystone's cathedralLevel with the whole roof course (16) or its middle 4 as crowns. */
const b2 = (id: string, rack: RackItem[], extra: Partial<LevelDef> = {}, crowns: 'roof' | 'middle' = 'roof') => cathedralLevel(id, rack, extra, crowns);

/** Domino Boulevard: 2 x 2 columns 14 tall on a spiral, each 5 cells from the last along it (a fallen column reaches the next); the last one's top course is the crowns. */
function dominoes(n: number): { parts: Part[]; half: number } {
  const parts: Part[] = [];
  let a = 0, half = 0;
  for (let k = 0; k < n; k++) {
    const r = 4 + 1.1 * a, x = r * Math.cos(a), z = r * Math.sin(a);
    parts.push({ kind: 'block', at: [Math.round(x) - 1, 0, Math.round(z) - 1], size: [2, 14, 2], material: 'plaster', ...(k === n - 1 ? { courses: [{ k: 13, role: 'crown' as const }] } : {}) });
    half = Math.max(half, Math.abs(Math.round(x)) + 1, Math.abs(Math.round(z)) + 1);
    a += 5 / Math.hypot(r, 1.1);
  }
  return { parts, half };
}

const domino = dominoes(30);

const ARMS = { weapons: { bomb: BOMB, ram: RAM } };

/**
 * Every draft by name. Launch items must reach across a big level's launcher ring (12 to 15 m): the
 * cannonball (12 m/s, 14.7 m at best on flat ground) and the Keystone grenade's shell (15 m/s) miss half
 * the targets from there, so the racks use rams, bombs, wrecking balls (15 m/s) and drops.
 */
export const DRAFTS: Readonly<Record<string, LevelDef>> = {
  // B1 Long Wall: 1,000 plaster cubes; what brings a wall down?
  B1a: b1('B1a', ['w-ram', 'w-ram', 'w-bomb'], ARMS),
  B1b: b1('B1b', ['p-wreckingball', 'p-wreckingball', 'w-bomb'], { ...ARMS, limits: { ammoRatio: 25 } }),
  B1c: b1('B1c', ['w-bomb', 'w-bomb', 'w-bomb'], ARMS),
  // B2 Spare the Cathedral: about 5k plaster cubes in 25 towers; crowns on the tallest, the middle one heritage.
  B2a: b2('B2a', ['w-bomb', 'w-ram', 'w-ram', 'drop'], ARMS),
  B2b: b2('B2b', ['w-bomb', 'w-bomb', 'p-wreckingball', 'drop'], { ...ARMS, limits: { ammoRatio: 25 } }),
  B2c: b2('B2c', ['w-ram', 'w-ram', 'w-ram', 'drop'], ARMS, 'middle'),
  // After the crown-aimed exploration (#144): the middle 4 crowns with B2a's bomb-led rack, and with a third ram.
  // B2d won (objective 31%, median 3 of 4 crowns, cathedral intact in the median play) and is B2 without the drop.
  B2d: b2('B2d', ['w-bomb', 'w-ram', 'w-ram', 'drop'], ARMS, 'middle'),
  B2e: b2('B2e', ['w-bomb', 'w-ram', 'w-ram', 'w-ram', 'drop'], ARMS, 'middle'),
  // B3 Ten Thousand: the S4 city at 10k; the spec's fat stone towers against slimmer, closer ones, and plaster.
  B3a: b3('B3a', 'stone', 8, 6, ['w-bomb', 'w-bomb', 'p-wreckingball'], ARMS),
  B3b: b3('B3b', 'stone', 5, 3, ['w-bomb', 'w-bomb', 'p-wreckingball'], ARMS),
  B3c: b3('B3c', 'plaster', 5, 3, ['w-bomb', 'w-bomb', 'w-ram'], ARMS),
  // After the Metal exploration (2026-11-01): the third item (wrecking ball, ram) added nothing after two bombs,
  // and a 10k cast at 40 iterations (about 52 s a play on the M5) would take 3 h for the short recipe. Three
  // bombs on B3b's city, at 40 iterations and at 20 (the spec's rule 1: a level may set its own physics).
  B3d: b3('B3d', 'stone', 5, 3, ['w-bomb', 'w-bomb', 'w-bomb'], ARMS),
  B3e: b3('B3e', 'stone', 5, 3, ['w-bomb', 'w-bomb', 'w-bomb'], { ...ARMS, physics: { iterations: 20 } }),
  // B4 Domino Boulevard: 30 slender columns on a spiral, 1,680 cubes; crowns on the outermost (the chain runs outward from the centre).
  B4a: outcome('B4a', 'Domino Boulevard', domino.parts, [domino.half, domino.half], 14, ['marble', 'marble', 'w-ram'], { ...ARMS, objective: { kind: 'crowns' } }),
};

export function draftByName(name: string): LevelDef {
  const d = DRAFTS[name];
  if (!d) throw new Error(`unknown draft ${name}; known: ${Object.keys(DRAFTS).join(', ')}`);
  return d;
}

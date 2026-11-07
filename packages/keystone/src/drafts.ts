// Draft big levels (roadmap G5) for exploring on Metal before any is
// authored: each is a variant of a slice level from spectacle-mode.md
// section 11 (structure, material, rack, weapon tuning), named
// <level><letter>, played by `pnpm keystone:cast --draft B1a --explore 16`.
// The exploration measures what a competent player gets (collapse after each
// shot, objective rate, crowns, heritage) so the authored levels and their
// objectives come from data, not guesses. Nothing here is a rated level (the
// game offers each as an unrated trial: trial-levels.ts); the building blocks
// (outcomeLevel, thirdBondWall, BOMB, RAM) are big-levels.ts's, so a winning
// draft becomes a level unchanged. Lives here, not in keystone-lab, so the game
// can play the drafts (keystone-lab re-exports them for the cast CLI).
import { BOMB, cathedralLevel, cityLevel, outcomeLevel as outcome, RAM, thirdBondWall } from './big-levels.ts';
import type { LevelDef, Part } from './level.ts';
import type { MaterialName } from './materials.ts';
import type { RackItem } from './rack.ts';

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
 * B5 Kapla Spire drafts (spectacle-mode.md section 11): S15's Kapla tower as a scenario part at h 0.3 m (a plank
 * 1.5 x 0.3 x 0.1 m, X3's crib cross-section, about 13 times real Kapla: a fall plays about 3.6 times slower than
 * a toy tower's, the level's declared slow motion), about 3,000 planks, plaster, gap 0 (S15's exact layout), with
 * GPU sleep (E2b's stabiliser). `shape`: 'spire' is one tower at slenderness 3 (2,884 planks, 38 m, 15 m across),
 * 'city' the five-tower form at 3 (3,106 planks, 39 m, 21 m across). The launcher stands 90 h (27 m) up, at
 * about two thirds of the height: from the ground a marble (15 m/s) reaches only the lower third (competent shots
 * reach their target 28 to 47% of the time from 0.6 m up; 81% on the spire and 88% on the city from 27 m, the best
 * of 15 to 33 m for this rack); the game's high launch mode starts above the top anyway.
 */
export function kaplaSpire(id: string, shape: 'city' | 'spire', rack: RackItem[], extra: Partial<LevelDef> = {}): LevelDef {
  const params = shape === 'city' ? { planks: 3000, towers: 5, slender: 3, topple: false } : { planks: 3000, towers: 1, slender: 3, topple: false };
  const half = shape === 'city' ? 36 : 26, top = 131;
  const d = outcome(id, 'Kapla Spire', [{ kind: 'scenario', id: 'S15', params, material: 'plaster', gap: 0 }], [half, half], top, rack, {
    unit: 0.3, objective: { kind: 'collapse', min: 0.4 }, ...extra, physics: { sleep: true, ...extra.physics },
  });
  return { ...d, launcher: { ...d.launcher, y: 90 } };
}
const KAPLA_LIGHT: RackItem[] = ['marble', 'marble', 'marble', 'w-grenade'];

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
  // B5: the single spire and the five-tower form with marbles and a grenade (TRIAL_RACK_LIGHT: planks are light),
  // and the spire without sleep (does it stand at all?). The spec's toy-scale balls are out at this scale: the
  // beach ball is a dud (7 J) and competent bowling and basketball shots reach their target 56% of the time.
  B5a: kaplaSpire('B5a', 'spire', KAPLA_LIGHT),
  B5b: kaplaSpire('B5b', 'city', KAPLA_LIGHT),
  B5c: kaplaSpire('B5c', 'spire', KAPLA_LIGHT, { physics: { sleep: false } }),
};

export function draftByName(name: string): LevelDef {
  const d = DRAFTS[name];
  if (!d) throw new Error(`unknown draft ${name}; known: ${Object.keys(DRAFTS).join(', ')}`);
  return d;
}

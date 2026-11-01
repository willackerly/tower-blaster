// Draft big levels (roadmap G5) for exploring on Metal before any is
// authored: each is a variant of a slice level from spectacle-mode.md
// section 11 (structure, material, rack, weapon tuning), named
// <level><letter>, played by `pnpm keystone:cast --draft B1a --explore 16`.
// The exploration measures what a competent player gets (collapse after each
// shot, objective rate, crowns, heritage) so the authored levels and their
// objectives come from data, not guesses. Nothing here is a shipped level; the
// building blocks (outcomeLevel, thirdBondWall, BOMB, RAM) are @tb/keystone's
// (big-levels.ts), so a winning draft becomes a level unchanged.
import { buildScenario } from '@tb/scenarios';
import { BOMB, type LevelDef, type MaterialName, outcomeLevel as outcome, type Part, RAM, type RackItem, type ScenarioPart, thirdBondWall } from '@tb/keystone';

/** The tallest tower of an S14 build (its tag) and its height in cubes. */
function tallestTower(params: Record<string, number>, seed: number): { tag: number; height: number; count: number } {
  const tops = new Map<number, number>();
  for (const b of buildScenario('S14', params, seed).bodies) tops.set(b.tag, Math.max(tops.get(b.tag) ?? 0, b.pos[1] + 0.5));
  let tag = 0;
  for (const [t, y] of tops) if (y > tops.get(tag)!) tag = t;
  return { tag, height: tops.get(tag)!, count: tops.size };
}

const B1_WALL = thirdBondWall(40, 25, 'plaster');
const b1 = (id: string, rack: RackItem[], extra: Partial<LevelDef> = {}) => outcome(id, 'Long Wall', B1_WALL, [20.2, 0.5], 25, rack, extra);

const S4_CITY = (material: MaterialName, F: number, street: number): ScenarioPart => ({ kind: 'scenario', id: 'S4', params: { N: 10000, F, H: 25, street }, material });
/** S4's footprint half-extent in cells for N 10000, H 25: ceil(sqrt(towers)) per side. */
function cityHalf(F: number, street: number): number {
  const side = Math.ceil(Math.sqrt(Math.ceil(10000 / (F * F * 25))));
  return (side * (F + street) - street) / 2 + 0.5;
}
const b3 = (id: string, material: MaterialName, F: number, street: number, rack: RackItem[], extra: Partial<LevelDef> = {}) =>
  outcome(id, 'Ten Thousand', [S4_CITY(material, F, street)], [cityHalf(F, street), cityHalf(F, street)], 25, rack, extra);

const B2_PARAMS = { towers: 25, W: 4, D: 4, H: 16, street: 4, vary: 0.4 };
const B2_SEED = 3;
function b2(id: string, rack: RackItem[], extra: Partial<LevelDef> = {}): LevelDef {
  const t = tallestTower(B2_PARAMS, B2_SEED), side = Math.ceil(Math.sqrt(B2_PARAMS.towers)), centre = Math.floor(B2_PARAMS.towers / 2);
  const part: ScenarioPart = {
    kind: 'scenario', id: 'S14', params: B2_PARAMS, seed: B2_SEED, material: 'plaster',
    roles: [
      // The cathedral: the middle tower's top two courses are heritage (32 watched bodies).
      { role: 'heritage', tag: centre, course: [Math.max(0, tallestOf(centre) - 2), 1000] },
      // Sixteen crowns: the tallest tower's roof course.
      { role: 'crown', tag: t.tag, top: true },
    ],
  };
  const half = (side * (B2_PARAMS.W + B2_PARAMS.street) - B2_PARAMS.street) / 2 + 0.5;
  return outcome(id, 'Spare the Cathedral', [part], [half, half], t.height, rack, { objective: { kind: 'crowns', footprintMax: 0.05 }, ...extra });
}
/** Height in cubes of S14 tower `tag` in B2's build. */
function tallestOf(tag: number): number {
  let top = 0;
  for (const b of buildScenario('S14', B2_PARAMS, B2_SEED).bodies) if (b.tag === tag) top = Math.max(top, b.pos[1] + 0.5);
  return top;
}

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
  // B3 Ten Thousand: the S4 city at 10k; the spec's fat stone towers against slimmer, closer ones, and plaster.
  B3a: b3('B3a', 'stone', 8, 6, ['w-bomb', 'w-bomb', 'p-wreckingball'], ARMS),
  B3b: b3('B3b', 'stone', 5, 3, ['w-bomb', 'w-bomb', 'p-wreckingball'], ARMS),
  B3c: b3('B3c', 'plaster', 5, 3, ['w-bomb', 'w-bomb', 'w-ram'], ARMS),
  // B4 Domino Boulevard: 30 slender columns on a spiral, 1,680 cubes; crowns on the outermost (the chain runs outward from the centre).
  B4a: outcome('B4a', 'Domino Boulevard', domino.parts, [domino.half, domino.half], 14, ['marble', 'marble', 'w-ram'], { ...ARMS, objective: { kind: 'crowns' } }),
};

export function draftByName(name: string): LevelDef {
  const d = DRAFTS[name];
  if (!d) throw new Error(`unknown draft ${name}; known: ${Object.keys(DRAFTS).join(', ')}`);
  return d;
}

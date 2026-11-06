// Trials: every structure built so far that is not a rated level, playable in
// the game as an unrated level (Will, 2026-11-06: "wire up all the scenarios /
// permutations we've built out ... would be very great to trial those too").
// Three sources, ids T-<source> so they never clash with a level, scenario or
// draft id:
//   T-S<n>   the engine scenarios (@tb/scenarios) as automatic levels
//            (scenarioLevel), at sizes the GPU budget plays;
//   T-B<n><x> the G5 drafts (drafts.ts): the rack and structure variants
//            explored before B1 to B4 were authored;
//   T-X<n>   the mode probes' structures (@tb/mode-probes X1 to X4), rebuilt
//            from level parts in cells (h = 0.5 m, the probes' cell);
//   T-I<n>   ice (ice.ts): blocks that crack and shatter, alone and mixed
//            with stone, to see and tune before any rated level uses ice;
//   T-W<n>   L1 to L5 with the new weapons in the rack (weapons plan steps 5
//            and 6), to play them where the bare-ammo levels are known.
// Every trial is an outcome level with no cast stars: it plays for its
// objective's star and the tally, and the door lists it under Trials, unrated.
// Left out, and why (docs/game/trials.md): S5 (S4 with the scenario's own
// ball: the player is the ball), S6, S7 and S11 (loose cubes dropped into a
// heap: no structure to bring down), S9 (its point is the heavy top, and a
// scenario part is one material), S10 (S1 moved 5 km: the launcher ring is
// centred on the origin), S13 (20 cubes, already overlapping as built), S15
// (its units are plank widths, so at h = 0.5 m a plank is 2.5 m long and a
// 2,000-plank tower 150 m tall; at Kapla's real scale it needs the viewer's
// substeps: ?scenario=S15. The Kapla trial is X3's crib chain at game scale),
// and drafts B1c and B3d (B1 and B3 as rated, but for the objective).
import { BOMB, outcomeLevel, RAM, thirdBondWall } from './big-levels.ts';
import { DRAFTS } from './drafts.ts';
import { L1, L2, L3, L4, L5 } from './chamber-levels.ts';
import type { LevelDef, Part } from './level.ts';
import type { RackItem } from './rack.ts';
import { scenarioLevel } from './scenario-part.ts';
import type { Params } from '@tb/scenarios';

type V3 = [number, number, number];

/**
 * A trial's rack on a structure of up to a few thousand blocks: a cannonball, two marbles and two grenades. The
 * marble (15 m/s) and the grenades' shells (flown as marbles) reach about 22 m, across any of these rings (up
 * to 16.4 m); the cannonball (12 m/s, about 14.7 m) only from the near side of the bigger ones.
 */
export const TRIAL_RACK_SMALL: readonly RackItem[] = ['cannonball', 'marble', 'marble', 'w-grenade', 'w-grenadel'];
/** A rack of marbles and a grenade, for structures of light bodies a cannonball outweighs past the ammo ratio (rods 0.2 cells thick, dominoes). */
export const TRIAL_RACK_LIGHT: readonly RackItem[] = ['marble', 'marble', 'marble', 'w-grenade'];
/** A trial's rack on a big structure (5k blocks and up): the big levels' bombs and rams, whose shells reach across their rings. */
export const TRIAL_RACK_BIG: readonly RackItem[] = ['w-bomb', 'w-bomb', 'w-bomb', 'w-ram', 'w-ram'];
const ARMS = { weapons: { bomb: BOMB, ram: RAM } };

/**
 * What a trial is and what its static check (validateLevel) is known to say. A trial plays even with
 * issues (the pre-settle runs first), but each is named here, and the tests hold every other trial clean.
 */
export interface TrialNote {
  /** Where the structure comes from: a scenario, a draft or a mode probe. */
  from: string;
  /** validateLevel issue codes this trial is known to carry, and why. */
  issues?: { codes: readonly string[]; why: string };
}

/** Each trial's note by id. */
export const TRIAL_NOTES: Record<string, TrialNote> = {};

function trial(def: LevelDef, note: TrialNote): LevelDef {
  TRIAL_NOTES[def.id] = note;
  return def;
}

/** Scenario `scenario` (params, seed 1) as a trial: scenarioLevel with the trial's id, name and rack. */
function scenarioTrial(id: string, name: string, scenario: string, params: Params, size: 'big' | 'small' | 'light', note: Omit<TrialNote, 'from'> = {}): LevelDef {
  const big = size === 'big', rack = big ? TRIAL_RACK_BIG : size === 'light' ? TRIAL_RACK_LIGHT : TRIAL_RACK_SMALL;
  const auto = scenarioLevel(scenario, params, 1, { rack });
  const p = Object.entries(params).map(([k, v]) => `${k}=${v}`).join(' ');
  return trial({ ...auto, id, name, world: 5, ...(big ? ARMS : {}) }, { from: `scenario ${scenario}${p ? ` (${p})` : ''}`, ...note });
}

const MASS_RATIO = { codes: ['mass-ratio'], why: 'slabs on rods or columns, many times their mass: the structure the scenario or probe was built to test' };
const OVERHANG = { codes: ['unsupported'], why: 'a running bond\'s end cubes overhang half a cube and tip in the pre-settle' };

const SCENARIO_TRIALS: LevelDef[] = [
  scenarioTrial('T-S1', 'Tall Tower', 'S1', {}, 'small'),
  scenarioTrial('T-S2', 'Stepped Pyramid', 'S2', {}, 'small'),
  scenarioTrial('T-S3', 'Stack-Bond Wall', 'S3', {}, 'small'),
  scenarioTrial('T-S3R', 'Running-Bond Wall', 'S3', { running: true }, 'small', { issues: OVERHANG }),
  scenarioTrial('T-S4', 'City of Towers', 'S4', {}, 'big'),
  // Its rods (0.2 cells thick, 1.3 kg) are the lightest bodies of any trial: even a marble is 26 x one, over AMMO_RATIO.
  scenarioTrial('T-S8', 'Slab and Rod Tower', 'S8', {}, 'light', { issues: { codes: ['mass-ratio', 'ammo-ratio'], why: `${MASS_RATIO.why}; and a marble is 26 x a rod (AMMO_RATIO 20), so a direct hit can drive a rod into the ground (roadmap E4)` } }),
  scenarioTrial('T-S12', 'Wall with a Hole', 'S12', { running: true }, 'small', { issues: { codes: ['unsupported'], why: 'a running bond\'s end cubes, and those at the hole\'s sides, overhang half a cube and tip in the pre-settle' } }),
  scenarioTrial('T-S14', 'Buildings', 'S14', {}, 'small'),
  scenarioTrial('T-S14T', 'Town', 'S14', { towers: 25, H: 16, vary: 0.4 }, 'big'),
];

/** The drafts as trials, named for what they vary. B1c and B3d are left out: B1 and B3 as rated, but for the objective. */
const DRAFT_TRIALS: LevelDef[] = Object.entries(DRAFTS).filter(([k]) => k !== 'B1c' && k !== 'B3d').map(([k, d]) =>
  trial({ ...d, id: `T-${k.toUpperCase()}`, name: `${d.name} (${k})`, world: 5 }, { from: `draft ${k} (drafts.ts)` }));

/** A box part (slab or rod) by centre-bottom `at` and half extents, in cells, plaster. */
const rod = (at: V3, half: V3, role?: 'crown'): Part => ({ kind: 'rod', at, half, material: 'plaster', ...(role ? { role } : {}) });

/** X1's straight run: n dominoes 1 x 0.5 x 0.15 m, 0.6 m apart along z, the last one the crown. */
export function dominoRun(n: number): Part[] {
  return Array.from({ length: n }, (_, i) => rod([0, 0, 1.2 * (i - (n - 1) / 2)], [0.5, 1, 0.15], i === n - 1 ? 'crown' : undefined));
}

/**
 * X2's slab building: storeys of two courses of columns (the outer ring of cells and a 2 x 2 core) under a
 * one-cell slab over the whole footprint, W x D cells and `storeys` high, on the game's lattice.
 */
export function slabBuilding(W: number, D: number, storeys: number, pitch = 1.02): Part[] {
  const parts: Part[] = [];
  const core = (i: number, n: number) => Math.abs(i - (n - 1) / 2) < 1;
  for (let s = 0; s < storeys; s++) {
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) {
      if (i === 0 || j === 0 || i === W - 1 || j === D - 1 || (core(i, W) && core(j, D))) parts.push({ kind: 'block', at: [i - W / 2, 3 * s, j - D / 2], size: [1, 2, 1], material: 'plaster' });
    }
    parts.push({ kind: 'slab', at: [0, 3 * s + 2, 0], half: [((W - 1) * pitch + 1) / 2, 0.5, ((D - 1) * pitch + 1) / 2], material: 'plaster' });
  }
  return parts;
}

/**
 * X3's chain: n towers about 4 m tall 2.2 m apart along z, as cubes (2 x 2 loose columns of 8), bonded brick
 * piers (8 courses) or Kapla cribs (14 layers of two planks on edge, 1 x 0.3 x 0.1 m); the last tower's top
 * course is the crown.
 */
export function towerChain(n: number, design: 'cubes' | 'bricks' | 'kapla'): Part[] {
  const parts: Part[] = [];
  for (let t = 0; t < n; t++) {
    const z = 4.4 * (t - (n - 1) / 2), last = t === n - 1;
    if (design === 'cubes') {
      // Block cells sit at (at + i + 0.5) pitches: at z / 1.02 - 1 centres the 2 x 2 column on z.
      parts.push({ kind: 'block', at: [-1, 0, z / 1.02 - 1], size: [2, 8, 2], material: 'plaster', ...(last ? { courses: [{ k: 7, role: 'crown' as const }] } : {}) });
      continue;
    }
    if (design === 'kapla') {
      // Two planks on edge at the square's opposite edges (0.9 m apart), along x on even layers and along z on odd ones.
      for (let k = 0; k < 14; k++) for (const s of [-0.9, 0.9]) {
        const role = last && k === 13 ? 'crown' as const : undefined;
        parts.push(k % 2 ? rod([s, 0.6 * k, z], [0.1, 0.3, 1], role) : rod([0, 0.6 * k, z + s], [1, 0.3, 0.1], role));
      }
      continue;
    }
    // Two bricks (1 x 0.5 x 0.5 m) side by side 1 cm apart, long along x on even courses and along z on odd ones.
    for (let k = 0; k < 8; k++) for (const s of [-0.505, 0.505]) {
      const role = last && k === 7 ? 'crown' as const : undefined;
      parts.push(k % 2 ? rod([s, k, z], [0.5, 0.5, 1], role) : rod([0, k, z + s], [1, 0.5, 0.5], role));
    }
  }
  return parts;
}

/**
 * X4's hollowed wall: running-bond bricks (1 x 0.5 x 0.5 m, 1 cm joints; half bricks at the odd courses' ends,
 * so the ends are flush), W bricks long and H courses high, less every brick whose centre is inside the half
 * disc of radius R (m) at the middle of its foot: an arch.
 */
export function archWall(W: number, H: number, R: number): Part[] {
  const parts: Part[] = [], P = 1.01, x0 = -(W * P) / 2;
  // Positions in metres as the probe builds them; a part is in cells (h = 0.5 m).
  const add = (x: number, y: number, hx: number) => { if (Math.hypot(x, y + 0.25) >= R) parts.push(rod([2 * x, 2 * y, 0], [2 * hx, 0.5, 0.5])); };
  for (let y = 0; y < H; y++) {
    const yb = 0.5 * y;
    if (y % 2 === 0) for (let x = 0; x < W; x++) add(x0 + P * x + 0.5, yb, 0.5);
    else {
      add(x0 + 0.25, yb, 0.25);
      for (let x = 0; x < W - 1; x++) add(x0 + 0.51 + P * x + 0.5, yb, 0.5);
      add(x0 + 0.51 + P * (W - 1) + 0.25, yb, 0.25);
    }
  }
  return parts;
}

const probe = (from: string) => ({ from: `mode probe ${from} (packages/mode-probes)` });

const PROBE_TRIALS: LevelDef[] = [
  // Dominoes are 0.15 m thick: a felled one lies with its centre 0.15 h up, a standing one at 1 h, so the crown line is 0.6 h.
  trial(outcomeLevel('T-X1', 'Domino Run', dominoRun(30), [0.5, 18], 2, [...TRIAL_RACK_LIGHT], { world: 5, gap: 0, crownLine: 0.6, objective: { kind: 'crowns' } }), probe('X1 line')),
  trial(outcomeLevel('T-X2', 'Slab Block', slabBuilding(6, 6, 5), [3.6, 3.6], 15, [...Array<RackItem>(16).fill('pull'), 'cannonball', 'cannonball'], { world: 5, objective: { kind: 'collapse', min: 0.5 } }), { ...probe('X2 slabs'), issues: MASS_RATIO }),
  trial(outcomeLevel('T-X3', 'Tower Chain', towerChain(12, 'cubes'), [1.5, 25], 8, ['cannonball', 'marble', 'marble'], { world: 5, objective: { kind: 'crowns' } }), probe('X3 cubes')),
  trial(outcomeLevel('T-X3B', 'Brick Pier Chain', towerChain(12, 'bricks'), [1.5, 25], 8, ['cannonball', 'marble', 'marble'], { world: 5, gap: 0, objective: { kind: 'crowns' } }), probe('X3 bricks')),
  // Planks of 7.5 kg: the cannonball (510 kg) is 68 x one, so marbles (33 kg) and a grenade.
  trial(outcomeLevel('T-X3K', 'Kapla Crib Chain', towerChain(12, 'kapla'), [1.5, 25], 8.4, [...TRIAL_RACK_LIGHT], { world: 5, gap: 0, objective: { kind: 'crowns' } }), probe('X3 kapla')),
  trial(outcomeLevel('T-X4', 'Arch', archWall(20, 25, 5), [20.3, 0.5], 25, [...TRIAL_RACK_BIG], { world: 5, gap: 0, ...ARMS, objective: { kind: 'collapse', min: 0.3 } }), {
    ...probe('X4 arch (bricks)'),
    issues: { codes: ['unsupported'], why: 'the bricks at the arch\'s edge overhang the hole one by one; the bond holds the rest (X4 on SwiftShader: one brick over the hole drops, the rest creeps 0.2 mm)' },
  }),
];

const iceNote = (what: string): TrialNote => ({ from: `ice (ice.ts): ${what}` });

/**
 * Ice (Will, 2026-11-06: "would be so cool to look like we're shattering ice"). A block cracks from a
 * 1.5 m/s hit and shatters from 5 (ICE_DEFAULTS); ice is slippery (friction 0.05), so ice on ice slides.
 */
const ICE_TRIALS: LevelDef[] = [
  // L1's tower, all ice: a cannonball low on it shatters what it hits and cracks most of the rest as it falls.
  trial(outcomeLevel('T-I1', 'Ice Tower', [{ kind: 'block', at: [-1, 0, -1], size: [2, 10, 2], material: 'ice', courses: [{ k: 9, role: 'crown' }] }], [1, 1], 10, [...TRIAL_RACK_SMALL], { world: 5, objective: { kind: 'crowns' } }), iceNote('a 2 x 2 column 10 courses high, crowned')),
  // A wall of ice in third bond, 8 long and 6 high: breaking a hole shows the bend of what is behind.
  trial(outcomeLevel('T-I2', 'Ice Wall', thirdBondWall(8, 6, 'ice'), [4.5, 1], 6, [...TRIAL_RACK_SMALL], { world: 5, objective: { kind: 'collapse', min: 0.3 } }), iceNote('a third-bond wall 8 x 6')),
  // A stone keep with an ice crown: four courses of stone under four of ice, the top one crowns.
  trial(outcomeLevel('T-I3', 'Frozen Keep', [{ kind: 'block', at: [-1.5, 0, -1.5], size: [3, 8, 3], material: 'stone', courses: [4, 5, 6, 7].map((k) => ({ k, material: 'ice' as const, ...(k === 7 ? { role: 'crown' as const } : {}) })) }], [1.5, 1.5], 8, [...TRIAL_RACK_SMALL], { world: 5, objective: { kind: 'crowns' } }), iceNote('a 3 x 3 stone keep, its top four courses ice')),
];

/**
 * The new weapons on the levels whose bare ammo is best known (docs/game/weapon-trials.md): L1 to L5's structures
 * and launchers as rated (the lot grown to the launcher ring less 3 cells, as every outcome level's), scored on their objective alone (no par, no cast stars), with a rack of the weapons
 * the weapons plan's steps 5 and 6 added (Scatter: five marble-weight pellets on a fan; Rocket: a motor and a quarter
 * grenade) and one marble for the finishing touch.
 */
export const WEAPON_TRIAL_RACK: readonly RackItem[] = ['w-scatter', 'w-rocket', 'marble'];

function weaponTrial(base: LevelDef, k: number): LevelDef {
  const { lGold: _g, solutions: _s, stars: _t, ...rest } = base;
  // Scored on outcome, a shot must stay live to the launcher ring less 3 cells (validateLevel's launcher issue): the lot grows to it.
  const r = base.launcher.radius - 3, lot = { min: [Math.min(base.lot.min[0], -r), Math.min(base.lot.min[1], -r)] as [number, number], max: [Math.max(base.lot.max[0], r), Math.max(base.lot.max[1], r)] as [number, number] };
  return trial({ ...rest, lot, id: `T-W${k}`, name: `${base.name}: New Arms`, version: 1, world: 5, scoring: 'outcome', par: WEAPON_TRIAL_RACK.length, rack: [...WEAPON_TRIAL_RACK] }, { from: `weapons: ${base.id}'s structure with the new weapons` });
}

const WEAPON_TRIALS: LevelDef[] = [L1, L2, L3, L4, L5].map((l, i) => weaponTrial(l, i + 1));

/** The trials in door order: scenarios, the mode probes' structures, the drafts, ice, then the new weapons. */
export const TRIAL_LEVELS: readonly LevelDef[] = [...SCENARIO_TRIALS, ...PROBE_TRIALS, ...DRAFT_TRIALS, ...ICE_TRIALS, ...WEAPON_TRIALS];

/** Whether level `id` is a trial (unrated). */
export const isTrial = (id: string): boolean => id.toUpperCase().startsWith('T-');

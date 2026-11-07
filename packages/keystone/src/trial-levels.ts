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
//   T-W<n>   workshops (build.ts, docs/game/placement.md): levels with a
//            build phase, where the player lays pieces before the first shot.
// Every trial is an outcome level with no cast stars: it plays for its
// objective's star and the tally, and the door lists it under Trials, unrated.
// Pruned 2026-11-06 by the agent playtest (PT11, docs/game/agent-playtest-1.md and
// docs/game/trials.md): duplicates and duds dropped (TRIAL_DROPS, each with its
// reason), the arch rebuilt as a doorway (it broke in the pre-settle on every engine),
// and every level now stands at load (keystone-lab level-stability tests). The
// promotions to rated levels (TRIAL_PROMOTE) wait for the objective and spark fixes.
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

const SCENARIO_TRIALS: LevelDef[] = [
  scenarioTrial('T-S3', 'Stack-Bond Wall', 'S3', {}, 'small'),
  scenarioTrial('T-S4', 'City of Towers', 'S4', {}, 'big'),
  // Its rods (0.2 cells thick, 1.3 kg) are the lightest bodies of any trial: even a marble is 26 x one, over AMMO_RATIO.
  scenarioTrial('T-S8', 'Slab and Rod Tower', 'S8', {}, 'light', { issues: { codes: ['mass-ratio', 'ammo-ratio'], why: `${MASS_RATIO.why}; and a marble is 26 x a rod (AMMO_RATIO 20), so a direct hit can drive a rod into the ground (roadmap E4)` } }),
  scenarioTrial('T-S14', 'Buildings', 'S14', {}, 'small'),
  scenarioTrial('T-S14T', 'Town', 'S14', { towers: 25, H: 16, vary: 0.4 }, 'big'),
];

/**
 * The drafts kept as trials (TRIAL_DRAFTS), named for what they vary. B1c and B3d were never in: B1 and B3 as
 * rated, but for the objective. The rest were dropped on 2026-11-06 (TRIAL_DROPS). B5a to B5c (Kapla Spire, G5)
 * came after the pruning and join as drafted, to be judged in the next agent round.
 */
export const TRIAL_DRAFTS: readonly string[] = ['B1b', 'B2c', 'B3b', 'B4a', 'B5a', 'B5b', 'B5c'];
const DRAFT_TRIALS: LevelDef[] = Object.entries(DRAFTS).filter(([k]) => TRIAL_DRAFTS.includes(k)).map(([k, d]) =>
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

/**
 * The arch trial's wall since 2026-11-06 (the agent playtest's PT11): archWall's running bond, W bricks long
 * and H courses high, with a doorway instead of the half disc: an opening `open` m either side of the middle
 * and `rise` courses high, its jambs plumb (a brick the opening cuts is cut, as a mason cuts one, and kept
 * if 0.2 m or more of it is left) under a stone lintel one course deep that bears 1 m into the wall each
 * side, the bond carrying on over it (plaster, as the bricks: a stone one is 38 x a brick, over the mass ratio). The half disc's sides step in by more than half a brick near its
 * crown, so those bricks tipped into the hole in the pre-settle and the arch was broken at shot 0, on the
 * reference, Rapier and the GPU solver alike. A doorway stands by the bond alone and keeps the trial's
 * point: a bomb through the opening brings the wall down (X4's 60%).
 */
export function gateWall(W: number, H: number, open: number, rise: number): Part[] {
  const parts: Part[] = [], P = 1.01, x0 = -(W * P) / 2, MIN = 0.2;
  // Positions in metres as archWall's; a part is in cells (h = 0.5 m).
  const brick = (a: number, b: number, yb: number) => parts.push(rod([a + b, 2 * yb, 0], [b - a, 0.5, 0.5]));
  for (let y = 0; y < H; y++) {
    const yb = 0.5 * y, gap = y < rise ? open : y === rise ? open + 1 : 0;
    const lay = (a: number, b: number) => {
      if (gap > 0 && a < gap && b > -gap) {
        if (-gap - a >= MIN) brick(a, -gap, yb);
        if (b - gap >= MIN) brick(gap, b, yb);
      } else brick(a, b, yb);
    };
    if (y % 2 === 0) for (let x = 0; x < W; x++) lay(x0 + P * x, x0 + P * x + 1);
    else {
      lay(x0, x0 + 0.5);
      for (let x = 0; x < W - 1; x++) lay(x0 + 0.51 + P * x, x0 + 0.51 + P * x + 1);
      lay(x0 + 0.51 + P * (W - 1), x0 + 0.51 + P * (W - 1) + 0.5);
    }
    if (y === rise) parts.push(rod([0, 2 * yb, 0], [2 * (open + 1), 0.5, 0.5]));
  }
  return parts;
}

const probe = (from: string) => ({ from: `mode probe ${from} (packages/mode-probes)` });

const PROBE_TRIALS: LevelDef[] = [
  // Dominoes are 0.15 m thick: a felled one lies with its centre 0.15 h up, a standing one at 1 h, so the crown line is 0.6 h.
  trial(outcomeLevel('T-X1', 'Domino Run', dominoRun(30), [0.5, 18], 2, [...TRIAL_RACK_LIGHT], { world: 5, gap: 0, crownLine: 0.6, objective: { kind: 'crowns' } }), probe('X1 line')),
  trial(outcomeLevel('T-X2', 'Slab Block', slabBuilding(6, 6, 5), [3.6, 3.6], 15, [...Array<RackItem>(16).fill('pull'), 'cannonball', 'cannonball'], { world: 5, objective: { kind: 'collapse', min: 0.5 } }), { ...probe('X2 slabs'), issues: MASS_RATIO }),
  trial(outcomeLevel('T-X3B', 'Brick Pier Chain', towerChain(12, 'bricks'), [1.5, 25], 8, ['cannonball', 'marble', 'marble'], { world: 5, gap: 0, objective: { kind: 'crowns' } }), probe('X3 bricks')),
  // A doorway 6 m wide and 4 m high under a lintel (gateWall): the probe's half-disc arch broke in the pre-settle.
  trial(outcomeLevel('T-X4', 'Gateway', gateWall(20, 25, 3, 8), [20.3, 0.5], 25, [...TRIAL_RACK_BIG], { world: 5, gap: 0, ...ARMS, objective: { kind: 'collapse', min: 0.3 } }), {
    ...probe('X4 arch (bricks), rebuilt as a doorway'),
    issues: { codes: ['mass-ratio'], why: 'the lintel (8 m) rests on bricks the doorway cuts short (15 x one); it stands at load on the reference, Rapier and the GPU solver (level-stability tests)' },
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
 * The trials dropped on 2026-11-06 (agent playtest round 1, judge 3's promotion table, PT11), and why. Their
 * structures stay where they were built (the scenarios, drafts.ts, the mode probes): the viewer opens them.
 */
export const TRIAL_DROPS: Readonly<Record<string, string>> = {
  'T-S1': 'out of reach at shot 0, 1% after three shots, its top out of frame',
  'T-S2': 'reads as a flat triangle; 0% after three shots',
  'T-S3R': 'a running bond whose end cubes tip in the pre-settle; 0% after three shots (T-S3 stays)',
  'T-S12': 'the marble sails through the hole: 0% and a total of 0 after three shots',
  'T-X3': 'a plainer copy of the brick pier chain (T-X3B)',
  'T-X3K': 'a third chain, with a 30 s settle',
  'T-B1A': 'a draft of B1; the ram dents it',
  'T-B2A': 'heritage invisible, total -15,361; B2D and B2E play identically',
  'T-B2B': 'the same layout and failure as B2A, a wrecking ball apart',
  'T-B2D': 'identical outcome to B2A',
  'T-B2E': 'identical outcome to B2A',
  'T-B3A': 'the same scene as T-S4',
  'T-B3C': 'a near copy of T-B3B, with a 30 s settle',
  'T-B3E': 'shot for shot the same numbers as T-B3B',
};

/** The trials judge 3 would promote to rated levels, once the objectives show (PT1) and the sparks follow the damage (PT2): each then needs a player-facing name, a cast and a recorded line. */
export const TRIAL_PROMOTE: readonly string[] = ['T-S4', 'T-S14', 'T-S14T', 'T-X3B', 'T-I3'];


/** The Domino Workshop's crowns: on a circle of WORKSHOP_RADIUS cells at 180, 90 and 0 degrees, each turned to face along it. */
export const WORKSHOP_RADIUS = 6;
export const WORKSHOP_ANGLES = [180, 90, 0] as const;

/**
 * Workshops: a build phase before the first shot (C9, docs/game/placement.md). T-W1: three crown dominoes stand a
 * quarter circle apart and the rack is one marble, so no shot fells more than one; the player lays the domino runs
 * that join them (the brush, along the circle or any other way) and fires once. 30 dominoes of budget; a quarter
 * circle of 6 cells takes 7.
 */
const WORKSHOP_TRIALS: LevelDef[] = [
  trial(outcomeLevel('T-W1', 'Domino Workshop', WORKSHOP_ANGLES.map((deg): Part => {
    const a = (deg * Math.PI) / 180;
    // A domino's thin axis (z) along the circle's tangent (-sin a, cos a): yawed -a about +y.
    return { kind: 'piece', at: [+(WORKSHOP_RADIUS * Math.cos(a)).toFixed(6), 1, +(WORKSHOP_RADIUS * Math.sin(a)).toFixed(6)], half: [0.5, 1, 0.15], yaw: deg % 180 === 0 ? 0 : -deg, material: 'plaster', role: 'crown' };
  }), [WORKSHOP_RADIUS + 1, WORKSHOP_RADIUS + 1], 2, ['marble'], {
    world: 5, gap: 0, crownLine: 0.6, objective: { kind: 'crowns' }, build: { budget: 30, pieces: ['domino'], brush: true },
  }), { from: 'workshop: three crown dominoes a quarter circle apart, a 30-domino brush, one marble' }),
];

/** The trials in door order: scenarios, the mode probes' structures, the drafts, ice, then the workshops. */
export const TRIAL_LEVELS: readonly LevelDef[] = [...SCENARIO_TRIALS, ...PROBE_TRIALS, ...DRAFT_TRIALS, ...ICE_TRIALS, ...WORKSHOP_TRIALS];

/** Whether level `id` is a trial (unrated). */
export const isTrial = (id: string): boolean => id.toUpperCase().startsWith('T-');

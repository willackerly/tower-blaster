// Undercut's levels (M1, docs/game/undercut-bullet-time.md): racks of pulls on small
// structures where a pull matters, so slabs, rods and planks rather than loose cube
// lattices (a pull under a lattice column drops only that column one cube). Ids U1
// on, a series of their own (?level=U1).
//
// U1 and U2 are par puzzles (2026-11-06, the agent playtest's PT7): each has one
// insight that clears it in par, and a wrong first guess costs a pull and a star.
// Their table top and beam are fixed (BoxPart.fixed): before, pulling the top out
// cleared either in one pull (U2's shortcut also beat its intended solve on every
// metric), so the puzzle could be skipped. U3 is outcome-scored on the share pulled,
// its stars cast by a bot of pulls (cast.ts pullTarget) like any outcome level's.
//
// What each was checked to do (pnpm vitest packages/keystone-lab/test/undercut-levels.test.ts,
// on the f64 reference and on Rapier): U1 holds on three legs and on a diagonal pair, and
// falls on two adjacent pulls; U2 tips only once its two far counterweights go (any other
// pair, and the heavy one with both near cubes, leave it level); U3 holds through
// Jenga-safe pulls (both edges of a course) and falls when a course's middle and an edge go.
import { outcomeLevel } from './big-levels.ts';
import { type LevelDef, MAX_PULLS, type Part } from './level.ts';

type V3 = [number, number, number];
const rod = (at: V3, half: V3, role?: 'heritage'): Part => ({ kind: 'rod', at, half, material: 'plaster', ...(role ? { role } : {}) });
/** outcomeLevel's frame (lot, launcher, crown line) as a par level: three stars in par, one less per pull over it. */
const parPuzzle = (d: LevelDef, par: number, line: number[]): LevelDef => {
  const { scoring: _outcome, ...rest } = d;
  return { ...rest, scoring: 'par', par, solutions: { par: line.map((body) => ({ ammo: 'pull' as const, body })) } };
};

/**
 * U1, the table: a slab on four rod legs carrying four crowns, three pulls, par 2. One pull leaves it
 * standing on three legs, and two diagonal pulls leave it balanced on the other diagonal: only two
 * adjacent legs tip it (the crowns slide toward the pulled side, the far legs kick out). The top is
 * fixed. Bodies: legs 0 to 3 at (-x -z), (-x +z), (+x -z), (+x +z); the top 4; crowns 5 to 8.
 */
export const U1: LevelDef = parPuzzle(outcomeLevel('U1', 'Table Manners', [
  ...([[-1.5, -1.5], [-1.5, 1.5], [1.5, -1.5], [1.5, 1.5]] as const).map(([x, z]) => rod([x, 0, z], [0.25, 1.5, 0.25])),
  { kind: 'slab', at: [0, 3, 0], half: [2, 0.125, 2], material: 'plaster', fixed: true },
  { kind: 'block', at: [-1, 3.25, -1], size: [2, 1, 2], material: 'plaster', role: 'crown' },
], [3, 3], 4.25, ['pull', 'pull', 'pull'], { world: 4, objective: { kind: 'crowns' } }), 2, [0, 1]);

/**
 * U2, the counterweight: a fixed beam on a heritage pier 2 h wide, four crowns at its +x end, and four
 * counterweights on its -x end. The beam stays level while the centre of mass of it and its load is over
 * the pier (|x| under 1 h). In cube masses about x = 0: crowns 4 at 4.5, beam 5 at 0, a two-cube rod at
 * -4.5, a four-cube rod at -3.5 and two cubes at -1.5. Pull the two far rods and the centre moves to
 * +1.36 h: it tips (par 2). Any other pair leaves it at +0.63 h or less; the heavy rod and both near
 * cubes, +0.82 h; so a wrong first pull costs one. Bodies: pier 0, beam 1, crowns 2 to 5, the far rod 6,
 * the heavy rod 7, the near cubes 8 and 9.
 */
export const U2: LevelDef = parPuzzle(outcomeLevel('U2', 'Counterweight', [
  rod([0, 0, 0], [1, 1.5, 1], 'heritage'),
  { kind: 'slab', at: [0, 3, 0], half: [5.1, 0.125, 1], material: 'plaster', fixed: true },
  { kind: 'block', at: [4, 3.25, -1], size: [1, 2, 2], material: 'plaster', role: 'crown' },
  rod([-4.5, 3.25, 0], [0.5, 1, 0.5]),
  rod([-3.5, 3.25, 0], [0.5, 1, 1]),
  { kind: 'block', at: [-2, 3.25, -1], size: [1, 1, 2], material: 'plaster' },
], [6, 2], 5.25, ['pull', 'pull', 'pull', 'pull'], { world: 4, objective: { kind: 'crowns' } }), 2, [6, 7]);

/** Courses of a plank tower: three planks a course, crossing course to course, each plank 3 x 0.6 x 1 h. */
export function plankTower(courses: number): Part[] {
  const parts: Part[] = [];
  for (let k = 0; k < courses; k++) for (const o of [-1.02, 0, 1.02]) {
    parts.push(k % 2 === 0 ? rod([0, 0.6 * k, o], [1.5, 0.3, 0.5]) : rod([o, 0.6 * k, 0], [0.5, 0.3, 1.5]));
  }
  return parts;
}

/** Planks in plankTower's courses, and the capstone crown's height (h). */
export const U3_COURSES = 10;

/**
 * U3, hollow: a ten-course plank tower with a capstone crown, and the most pulls a rack holds (24,
 * MAX_PULLS): more than the tower can lose standing (about 21 on Rapier), so the bank is the
 * decision. With 16 (before 2026-11-06) half of a bot's random lines pulled the whole rack standing
 * and the cast's skill gate failed (T2 0.49, T3 0.52). Take as many planks as you dare
 * (Jenga's rule holds: both edges of a course may go, a middle and an edge may not) and bank
 * while the capstone is up; a settle with it down ends the round, toppled.
 */
export const U3: LevelDef = outcomeLevel('U3', 'Hollow', [
  ...plankTower(U3_COURSES),
  { kind: 'block', at: [-0.5, 0.6 * U3_COURSES, -0.5], size: [1, 1, 1], material: 'plaster', role: 'crown' },
], [2, 2], 0.6 * U3_COURSES + 1, Array(MAX_PULLS).fill('pull'), { world: 4, par: 1, crownLine: 0.6 * U3_COURSES - 1, objective: { kind: 'hold' } });

/** Undercut's levels, in play order. */
export const UNDERCUT_LEVELS: readonly LevelDef[] = [U1, U2, U3];

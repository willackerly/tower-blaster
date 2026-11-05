// Undercut's levels (M1, docs/game/undercut-bullet-time.md): racks of pulls on small
// structures where a pull matters, so slabs, rods and planks rather than loose cube
// lattices (a pull under a lattice column drops only that column one cube). Ids U1
// on, a series of their own (?level=U1). Outcome-scored; stars uncast until a pull
// cast runs, so each plays for its objective's star and the tally.
//
// What each was checked to do (pnpm vitest packages/keystone-lab/test/undercut-levels.test.ts,
// on the f64 reference and on Rapier): U1 holds on three legs and on a diagonal pair, and
// falls on two adjacent pulls; U2 holds with two of
// its three counterweights and tips with one; U3 holds through Jenga-safe pulls (both
// edges of a course) and falls when a course's middle and an edge go.
import { outcomeLevel } from './big-levels.ts';
import type { LevelDef, Part } from './level.ts';

type V3 = [number, number, number];
const rod = (at: V3, half: V3, role?: 'heritage'): Part => ({ kind: 'rod', at, half, material: 'plaster', ...(role ? { role } : {}) });

/**
 * U1, the table: a slab on four rod legs carrying four crowns, and two pulls. One pull leaves it
 * standing on three legs, and two diagonal pulls leave it balanced on the other diagonal: only two
 * adjacent legs tip it (the crowns slide toward the pulled side, the far legs kick out).
 */
export const U1: LevelDef = outcomeLevel('U1', 'Table Manners', [
  ...([[-1.5, -1.5], [-1.5, 1.5], [1.5, -1.5], [1.5, 1.5]] as const).map(([x, z]) => rod([x, 0, z], [0.25, 1.5, 0.25])),
  { kind: 'slab', at: [0, 3, 0], half: [2, 0.125, 2], material: 'plaster' },
  { kind: 'block', at: [-1, 3.25, -1], size: [2, 1, 2], material: 'plaster', role: 'crown' },
], [3, 3], 4.25, ['pull', 'pull'], { world: 4, par: 2, objective: { kind: 'crowns' } });

/**
 * U2, the counterweight: a beam on a heritage pier, two crowns at its +x end, three plaster cubes
 * weighing down its -x end. Moments about the pier's +x edge: the crowns 2 x 4 h, the beam 5 x 0.5 h,
 * each counterweight 5 h (outer) or 4 h (inner): any two keep it level, any one does not.
 */
export const U2: LevelDef = outcomeLevel('U2', 'Counterweight', [
  rod([0, 0, 0], [0.5, 1.5, 1], 'heritage'),
  { kind: 'slab', at: [0, 3, 0], half: [5, 0.125, 1], material: 'plaster' },
  { kind: 'block', at: [4, 3.25, -0.5], size: [1, 2, 1], material: 'plaster', role: 'crown' },
  { kind: 'block', at: [-5, 3.25, -1], size: [1, 1, 2], material: 'plaster' },
  { kind: 'block', at: [-4, 3.25, -1], size: [1, 1, 1], material: 'plaster' },
], [6, 2], 5.25, ['pull', 'pull', 'pull'], { world: 4, par: 2, objective: { kind: 'crowns' } });

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
 * U3, hollow: a ten-course plank tower with a capstone crown. Take as many planks as you dare
 * (Jenga's rule holds: both edges of a course may go, a middle and an edge may not) and bank
 * while the capstone is up; a settle with it down ends the round, toppled.
 */
export const U3: LevelDef = outcomeLevel('U3', 'Hollow', [
  ...plankTower(U3_COURSES),
  { kind: 'block', at: [-0.5, 0.6 * U3_COURSES, -0.5], size: [1, 1, 1], material: 'plaster', role: 'crown' },
], [2, 2], 0.6 * U3_COURSES + 1, Array(16).fill('pull'), { world: 4, par: 1, crownLine: 0.6 * U3_COURSES - 1, objective: { kind: 'hold' } });

/** Undercut's levels, in play order. */
export const UNDERCUT_LEVELS: readonly LevelDef[] = [U1, U2, U3];

// Undercut's levels U1 to U3 (M1, docs/game/undercut-bullet-time.md) do what their
// comments say, on the f64 reference and on Rapier: the structure answers each pull
// the way the level's puzzle needs, and the hold objective (U3, Hollow) banks a
// Jenga-safe line with its pulled share and ends a toppling line there, failed.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, type LevelDef, type OutcomeScore, runSession, type Shot, U1, U2, U3, U3_COURSES, validateLevel } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

const ENGINES: Array<[string, () => PhysicsEngine]> = [
  ['reference', () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP })],
  ['rapier', () => new RapierEngine()],
];
const pulls = (...bodies: number[]): Shot[] => bodies.map((body) => ({ ammo: 'pull', body }));
const play = (make: () => PhysicsEngine, def: LevelDef, line: Shot[], bank = true) => runSession(make(), compileLevel(def), line, { bank });

describe('Undercut levels', () => {
  it('validate clean, with their roles where the tests below assume', () => {
    for (const d of [U1, U2, U3]) expect(validateLevel(compileLevel(d)), d.id).toEqual([]);
    const c1 = compileLevel(U1), c2 = compileLevel(U2), c3 = compileLevel(U3);
    expect([...c1.meta.crowns]).toEqual([5, 6, 7, 8]);
    expect(c1.meta.heritage).toHaveLength(0);
    expect([...c2.meta.heritage]).toEqual([0]);
    expect([...c2.meta.crowns]).toEqual([2, 3]);
    expect(c3.meta.n).toBe(3 * U3_COURSES + 1);
    expect([...c3.meta.crowns]).toEqual([3 * U3_COURSES]);
  });

  for (const [name, make] of ENGINES) {
    it(`${name}: U1 stands on three legs and on a diagonal pair, and any two adjacent pulls tip it`, async () => {
      expect((await play(make, U1, pulls(0), false)).session.outcomes[0]!.crownsTotal).toBe(0);
      for (const line of [[0, 3], [1, 2]]) {
        const r = await play(make, U1, pulls(...line));
        expect(r.session.phase, `diagonal ${line}`).toBe('failed');
        expect(r.session.outcomes[1]!.crownsTotal, `diagonal ${line}`).toBe(0);
      }
      for (const line of [[0, 1], [2, 3], [0, 2], [1, 3]]) {
        const r = await play(make, U1, pulls(...line));
        expect(r.session.phase, `adjacent ${line}`).toBe('cleared');
        expect(r.session.outcomes[1]!.crownsTotal, `adjacent ${line}`).toBe(4);
      }
    });

    it(`${name}: U2 stays level on any two counterweights and tips on one`, async () => {
      for (const b of [4, 5, 6]) expect((await play(make, U2, pulls(b), false)).session.outcomes[0]!.crownsTotal, `pull ${b}`).toBe(0);
      for (const line of [[4, 5], [4, 6]]) {
        const r = await play(make, U2, pulls(...line));
        expect(r.session.outcomes[1]!.crownsTotal, `pull ${line}`).toBe(2);
        expect(r.session.phase).toBe('cleared');
      }
    });

    it(`${name}: U3 banks a Jenga-safe line with its pulled share, and a middle-and-edge line topples and ends there`, async () => {
      // Both edges of the bottom three courses: six of thirty planks, the capstone up.
      const safe = await play(make, U3, pulls(0, 2, 3, 5, 6, 8));
      expect(safe.session.phase).toBe('cleared');
      const score = safe.session.score as OutcomeScore;
      const planks = 3 * U3_COURSES, plank = compileLevel(U3).meta.mass[0]!, cap = compileLevel(U3).meta.mass[planks]!;
      expect(score.outcome.value).toBeCloseTo((6 * plank) / (planks * plank + cap), 12);
      expect(score.outcome.metric).toBe('pulled'); // a hold level's default metric
      expect(score.lines.map((l) => l.label)).toEqual(['Objective', 'Pulled']);
      expect(score.stamp).toBe('19% PULLED'); // 10.8 of 55 h^3: the capstone counts in the structure's mass
      // The middle then an edge of the bottom course: down at the second settle, and the rack left unfired.
      const fall = await play(make, U3, pulls(1, 0, 3, 4));
      expect(fall.session.phase).toBe('failed');
      expect(fall.session.outcomes).toHaveLength(2);
      expect(fall.session.rackLeft).toHaveLength(14);
      expect(fall.session.score!.stamp).toBe('TOPPLED');
      expect(fall.session.score!.stars).toBe(0);
    }, 60_000);
  }
});

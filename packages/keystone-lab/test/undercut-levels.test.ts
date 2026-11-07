// Undercut's levels U1 to U3 (M1, docs/game/undercut-bullet-time.md) do what their
// comments say, on the f64 reference and on Rapier. U1 and U2 are par puzzles: every
// ordered pair of pulls is played, and exactly the pairs the static analysis names
// clear them in par; a wrong guess clears a pull later, a star less; the fixed top
// and beam refuse a pull. The hold objective (U3, Hollow) banks a Jenga-safe line
// with its pulled share and ends a toppling line there, failed.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, type LevelDef, MAX_PULLS, type OutcomeScore, runSession, scoringOf, Session, type Shot, U1, U2, U3, U3_COURSES, validateLevel } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

const ENGINES: Array<[string, () => PhysicsEngine]> = [
  ['reference', () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP })],
  ['rapier', () => new RapierEngine()],
];
const pulls = (...bodies: number[]): Shot[] => bodies.map((body) => ({ ammo: 'pull', body }));
const play = (make: () => PhysicsEngine, def: LevelDef, line: Shot[], bank = true) => runSession(make(), compileLevel(def), line, { bank });
/** Every ordered pair of distinct bodies from `bodies`. */
const pairs = (bodies: readonly number[]) => bodies.flatMap((a) => bodies.filter((b) => b !== a).map((b) => [a, b]));

describe('Undercut levels', () => {
  it('validate clean, with their roles where the tests below assume', () => {
    for (const d of [U1, U2, U3]) expect(validateLevel(compileLevel(d)), d.id).toEqual([]);
    const c1 = compileLevel(U1), c2 = compileLevel(U2), c3 = compileLevel(U3);
    expect([...c1.meta.crowns]).toEqual([5, 6, 7, 8]);
    expect([...c1.meta.fixed]).toEqual([4]);
    expect(c1.meta.heritage).toHaveLength(0);
    expect([...c2.meta.heritage]).toEqual([0]);
    expect([...c2.meta.fixed]).toEqual([1]);
    expect([...c2.meta.crowns]).toEqual([2, 3, 4, 5]);
    expect(c2.meta.n).toBe(10);
    expect(c3.meta.n).toBe(3 * U3_COURSES + 1);
    expect([...c3.meta.crowns]).toEqual([3 * U3_COURSES]);
    expect(c3.meta.fixed).toHaveLength(0);
    expect([scoringOf(U1), scoringOf(U2), scoringOf(U3)]).toEqual(['par', 'par', 'outcome']);
    expect([U1.par, U2.par]).toEqual([2, 2]);
  });

  it('a fixed top or beam, a crown and heritage refuse a pull; a leg or counterweight does not', () => {
    const s1 = new Session(compileLevel(U1)), s2 = new Session(compileLevel(U2));
    expect(s1.pullRefusal(4)).toBe('body 4 is fixed');
    expect(s1.pullRefusal(5)).toBe('body 5 is a crown');
    expect(s1.pullRefusal(0)).toBeNull();
    expect(s2.pullRefusal(1)).toBe('body 1 is fixed');
    expect(s2.pullRefusal(0)).toBe('body 0 is heritage');
    for (const b of [6, 7, 8, 9]) expect(s2.pullRefusal(b)).toBeNull();
  });

  /** The level with its parts' `fixed` taken off: U1 and U2 as they were on f52dc5f, before PT7. */
  const unfixed = (d: LevelDef): LevelDef => ({ ...d, parts: d.parts.map((p) => { const { fixed: _, ...rest } = p as typeof p & { fixed?: true }; return rest as typeof p; }) });

  for (const [name, make] of ENGINES) {
    it(`${name}: pulling the support under the crowns does not clear U1 or U2 (PT35); without \`fixed\` it would, in one pull`, async () => {
      // Agent playtest 2 on f52dc5f: pulling U1's top or U2's beam dropped the crowns upright, felled, in one pull.
      for (const [d, support] of [[U1, 4], [U2, 1]] as const) {
        expect(compileLevel(unfixed(d)).meta.fixed, d.id).toHaveLength(0);
        const before = await play(make, unfixed(d), pulls(support), false);
        expect({ id: d.id, phase: before.session.phase, stars: before.session.score?.stars }).toEqual({ id: d.id, phase: 'cleared', stars: 3 });
        await expect(play(make, d, pulls(support), false), d.id).rejects.toThrow(`cannot pull: body ${support} is fixed`);
      }
    }, 120_000);

    it(`${name}: U1 stands on three legs and on a diagonal pair, any two adjacent pulls tip it in par, and a third pull after a diagonal clears a star less`, async () => {
      expect((await play(make, U1, pulls(0), false)).session.outcomes[0]!.crownsTotal).toBe(0);
      const diagonal = (a: number, b: number) => a + b === 3; // legs 0 and 3, 1 and 2
      for (const [a, b] of pairs([0, 1, 2, 3])) {
        const r = await play(make, U1, pulls(a!, b!), false);
        expect(r.session.phase, `pulls ${a},${b}`).toBe(diagonal(a!, b!) ? 'aiming' : 'cleared');
        if (!diagonal(a!, b!)) expect(r.session.score!.stars, `pulls ${a},${b}`).toBe(3);
      }
      const late = await play(make, U1, pulls(0, 3, 1));
      expect({ phase: late.session.phase, stars: late.session.score!.stars }).toEqual({ phase: 'cleared', stars: 2 });
    }, 120_000);

    it(`${name}: U2 tips in par only on its two far counterweights; the heavy rod and both near cubes leave it level, and the far rod then clears a star less again`, async () => {
      for (const [a, b] of pairs([6, 7, 8, 9])) {
        const r = await play(make, U2, pulls(a!, b!), false);
        const par = (a === 6 && b === 7) || (a === 7 && b === 6);
        expect(r.session.phase, `pulls ${a},${b}`).toBe(par ? 'cleared' : 'aiming');
        if (par) expect({ stars: r.session.score!.stars, heritage: r.session.score!.lines.some((l) => /heritage/i.test(l.label) && l.value < 0) }).toEqual({ stars: 3, heritage: false });
      }
      expect((await play(make, U2, pulls(7, 8, 9), false)).session.phase).toBe('aiming');
      const third = await play(make, U2, pulls(8, 6, 7)), fourth = await play(make, U2, pulls(7, 8, 9, 6));
      expect([third.session.score!.stars, fourth.session.score!.stars]).toEqual([2, 1]);
    }, 240_000);

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
      expect(fall.session.rackLeft).toHaveLength(MAX_PULLS - 2);
      expect(fall.session.score!.stamp).toBe('TOPPLED');
      expect(fall.session.score!.stars).toBe(0);
    }, 60_000);
  }
});

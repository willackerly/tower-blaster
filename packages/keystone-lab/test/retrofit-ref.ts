// Aftershock's retrofit gate on the reference engine (M7b, docs/game/aftershock.md "Retrofit"), one shipped level per
// test file (retrofit-ref-A*.test.ts; a level's 40 nudged plays are about a CI worker's minute and a half on 4 cores):
// the bare level fails on every nudged build but at most BARE_MAX, each recorded bracing (retrofit-solutions.ts, two
// families) is robust (at least ROBUST of NUDGES) and inside the build budget, the obvious wrong builds fail as the
// bare level does, and the stars are the bracings' costs (the cheapest the third, the other family the second).
// Nudged as the search judged them (quake-search.ts nudgeLevel). The search: pnpm keystone:retrofit.
import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { castStars, compileLevel, type LevelDef, placedCost, validateLevel } from '@tb/keystone';
import { BARE_MAX, ROBUST, verdicts } from '../src/retrofit-search.ts';
import { RETROFIT_SOLUTIONS, RETROFIT_WRONG, retrofitBuild } from '../src/retrofit-solutions.ts';

const MINUTES = 60_000;
const JOBS = Math.max(1, Math.min(4, availableParallelism()));

export function retrofitRefSuite(def: LevelDef): void {
  describe('Aftershock retrofit gate on the reference', () => {
    it(`${def.id} ${def.name}: bare falls, two families of bracing within the budget save it, the wrong builds do not`, async () => {
      const c = compileLevel(def), budget = def.build!.budget!;
      expect(validateLevel(c).filter((i) => !i.warning)).toEqual([]);
      expect(castStars(c)).toBe(def.stars);
      const sols = RETROFIT_SOLUTIONS[def.id]!, wrong = RETROFIT_WRONG[def.id]!;
      expect(new Set(sols.map((s) => s.family)).size, 'distinct families').toBeGreaterThanOrEqual(2);
      const built = sols.map((s) => retrofitBuild(def, s)), bad = wrong.map((w) => retrofitBuild(def, w));
      for (const [i, b] of built.entries()) {
        expect(b.spent, sols[i]!.label).toBe(placedCost(b.def));
        expect(b.spent, `${sols[i]!.label} is inside the budget`).toBeLessThanOrEqual(budget);
        expect(compileLevel(b.def).baseHash, 'a build plays the authored level').toBe(c.hash);
      }
      // The stars are the recorded bracings' costs: the cheapest the third star (and the best), the other family's the second.
      expect(def.stars).toMatchObject({ metric: 'built', t3: built[0]!.spent, best: built[0]!.spent, t2: built[1]!.spent });
      const t0 = performance.now();
      const [bare, ...rest] = await verdicts([def, ...built.map((b) => b.def), ...bad.slice(1).map((b) => b.def)], JOBS);
      const vs = rest.slice(0, built.length), ws = rest.slice(built.length);
      console.log(`${def.id} on the reference (${JOBS} jobs, ${((performance.now() - t0) / 1000).toFixed(0)} s): bare ${bare!.met}/${bare!.n}; ${sols.map((s, i) => `${s.family} ${built[i]!.spent} ${vs[i]!.met}/${vs[i]!.n}`).join('; ')}; ${wrong.slice(1).map((w, i) => `${w.family} ${ws[i]!.met}/${ws[i]!.n}`).join('; ')}`);
      expect(bare!.met, 'the bare level').toBeLessThanOrEqual(BARE_MAX);
      for (const [i, v] of vs.entries()) expect(v.met, sols[i]!.label).toBeGreaterThanOrEqual(ROBUST);
      for (const [i, v] of ws.entries()) expect(v.met, wrong[i + 1]!.label).toBeLessThanOrEqual(BARE_MAX);
    }, 15 * MINUTES);
  });
}

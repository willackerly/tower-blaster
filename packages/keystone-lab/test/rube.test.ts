// Rube Lab's gate on the reference (M10, docs/game/rube-lab.md): each gate puzzle has
// at least two solution families (RL4, a combination level, one family in two builds), recorded as build programs the real build tool
// accepts (rube-solutions.ts), and each clears on the reference through the game's
// Driver and Session; its obvious wrong builds build too and fail; the pinned parts
// (shelves, ramps, the bin's bumper and ramp) move exactly 0; the level's parts par
// is its cheapest recorded clear. The search that found them: pnpm rube:gate.
import { describe, expect, it } from 'vitest';
import { compileLevel, RUBE_END_AFTER, RUBE_GATE, RUBE_LEVELS, partsStars } from '@tb/keystone';
import { build, playRube } from '../src/rube.ts';
import { RUBE_MIN_FAMILIES, RUBE_SOLUTIONS, RUBE_WRONG } from '../src/rube-solutions.ts';

const MINUTES = 60_000;

describe('Rube Lab gate puzzles on the reference', () => {
  it('every Rube Lab level has recorded solutions and wrong builds', () => {
    for (const def of RUBE_LEVELS) {
      expect(RUBE_SOLUTIONS[def.id]?.length, def.id).toBeGreaterThan(0);
      expect(RUBE_WRONG[def.id]?.length, def.id).toBeGreaterThan(0);
    }
  });

  for (const def of RUBE_GATE) {
    it(`${def.id} ${def.name}: its families clear, the wrong builds fail, pins hold`, async () => {
      const sols = RUBE_SOLUTIONS[def.id]!, families = new Set(sols.map((s) => s.family));
      expect(families.size, 'distinct solution families').toBeGreaterThanOrEqual(RUBE_MIN_FAMILIES[def.id] ?? 2);
      expect(sols.length, 'recorded solutions').toBeGreaterThanOrEqual(2);
      const costs: number[] = [];
      for (const sol of sols) {
        const b = build(def, sol.steps);
        expect(b, `${sol.label} builds`).not.toBeNull();
        const r = await playRube(b!.def, undefined, b!.spent);
        expect(r.cleared, `${sol.label} clears`).toBe(true);
        expect(r.rungAt, sol.label).toBeGreaterThan(0);
        // PT32: the run ends RUBE_END_AFTER after the ring (LevelDef.end), not at the cap with the ball still rolling.
        expect(r.steps - r.rungAt, `${sol.label}: steps from the ring to the end`).toBe(RUBE_END_AFTER * 60);
        expect(r.pinnedMove, `${sol.label}: pins move`).toBe(0);
        costs.push(b!.spent);
        console.log(`${def.id} ${sol.family}: ${sol.label}, cost ${b!.spent}, rung at step ${r.rungAt} of ${r.steps}, ${partsStars(true, b!.spent, def.build!.par!)} stars`);
      }
      // The parts par is the cheapest clear (3 stars for it); the first recorded build is that one.
      expect(def.build!.par!).toBe(Math.min(...costs));
      expect(costs[0]).toBe(def.build!.par!);
      for (const w of RUBE_WRONG[def.id]!) {
        const b = build(def, w.steps);
        // A wrong build the tool refuses proves nothing: it must be buildable and fail.
        expect(b, `${w.label} builds`).not.toBeNull();
        const r = await playRube(b!.def);
        expect(r.cleared, `${w.label} fails`).toBe(false);
        expect(r.pinnedMove, `${w.label}: pins move`).toBe(0);
      }
    }, 5 * MINUTES);
  }

  it('the solutions are distinct levels (each build hashes differently from the bare level and each other)', () => {
    for (const def of RUBE_GATE) {
      const hashes = new Set([compileLevel(def).hash, ...RUBE_SOLUTIONS[def.id]!.map((s) => compileLevel(build(def, s.steps)!.def).hash)]);
      expect(hashes.size, def.id).toBe(RUBE_SOLUTIONS[def.id]!.length + 1);
    }
  });
});

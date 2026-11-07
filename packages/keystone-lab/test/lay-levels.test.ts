// Wavefront's Lay levels (M6, docs/game/wavefront.md) on Rapier: W1 First Run and W2 Two Bells as designed.
// - Every authored solution (lay-solutions.ts), built through BuildSession with the brush, rings every bell on at
//   least 98% of nudged builds (lay.ts nudgeClears: 1 mm and 0.2 deg per body), 50 nudges each.
// - The wrong builds fail: a run straight into the wall, nothing built, one branch of W2's fork.
// - The parts par each level carries (build.par) is what the Lay bot finds: the cheapest of 24 perturbations of every
//   authored solution (control points moved up to 0.8 h, the ends held) that clears and holds on 4 nudges.
// W6 Orchard (the 1k field) is lay-W6.test.ts; the GPU plays them in wave-gpu-W1, W2 and W6.test.ts.
import { describe, expect, it } from 'vitest';
import { compileLevel, LAY_LEVELS, validateLevel, W1, W2 } from '@tb/keystone';
import { build } from '../src/rube.ts';
import { layClears, layPar, nudgeClears, steps } from '../src/lay.ts';
import { LAY_SOLUTIONS } from '../src/lay-solutions.ts';

/** Nudges per solution, and the most that may fail (98%). */
const NUDGES = 50, MAY_FAIL = Math.floor(0.02 * NUDGES);

describe('Wavefront Lay levels on Rapier', () => {
  it('every Lay level compiles clean: a brush-only build with a parts par, bells, asleep', () => {
    for (const l of LAY_LEVELS) {
      const c = compileLevel(l);
      expect(validateLevel(c).map((i) => i.code), l.id).toEqual([]);
      expect(l.objective.kind, l.id).toBe('bell');
      expect(l.build, l.id).toMatchObject({ pieces: ['domino'], brush: true });
      expect(l.build!.par, l.id).toBeLessThanOrEqual(l.build!.budget!);
      expect(c.scene.bodies.every((b) => b.pinned || b.asleep), l.id).toBe(true);
      expect(LAY_SOLUTIONS[l.id]?.length, l.id).toBeGreaterThanOrEqual(2);
    }
  });

  it.for(['W1', 'W2'])('%s: every authored solution rings every bell on 98% of nudges', { timeout: 300_000 }, async (id) => {
    const def = id === 'W1' ? W1 : W2;
    for (const s of LAY_SOLUTIONS[id]!) {
      const b = build(def, steps(s));
      expect(b, `${s.label} builds`).not.toBeNull();
      const ok = await nudgeClears(b!.def, NUDGES);
      console.log(`${id} ${s.label}: ${b!.spent} dominoes, ${ok}/${NUDGES} nudges clear`);
      expect(NUDGES - ok, s.label).toBeLessThanOrEqual(MAY_FAIL);
    }
  });

  it('the wrong builds fail: nothing built, straight into the wall, one branch of the fork', { timeout: 120_000 }, async () => {
    expect(await layClears(W1)).toBe(false);
    expect(await layClears(W2)).toBe(false);
    const straight = build(W1, [{ stroke: [[1.5, 0], [6, 0]] }])!;
    expect(await layClears(straight.def)).toBe(false);
    const fork = LAY_SOLUTIONS.W2![0]!;
    const half = build(W2, [{ stroke: fork.strokes[0]! }, { stroke: fork.strokes[1]! }])!;
    expect(await layClears(half.def)).toBe(false);
  });

  it('the budget refuses a run longer than it', () => {
    // A 36 h line: 31 dominoes, one over W1's 30.
    expect(build(W1, [{ stroke: [[1.5, -6], [37.5, -6]] }])).toBeNull();
  });

  it.for(['W1', 'W2'])('%s: the parts par is the cheapest build the Lay bot finds', { timeout: 300_000 }, async (id) => {
    const def = id === 'W1' ? W1 : W2;
    const r = await layPar(def, LAY_SOLUTIONS[id]!, { samples: 24, amp: 0.8, gate: 4 });
    const costs = r.clears.map((c) => c.spent).sort((a, b) => a - b);
    console.log(`${id}: par ${r.par} (${r.best.label}); ${r.clears.length} clear, ${r.failed} failed, ${r.luck} luck, ${r.refused} refused; costs ${costs[0]}..${costs.at(-1)}`);
    expect(r.par).toBe(def.build!.par);
  });
});

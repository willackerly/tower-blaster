// Every shipped domino-fuse level can be built as its gate confirmed it (M5b, docs/game/fuse-and-fold.md, "Domino
// fuses"): the best build fits the level's budget. F6 shipped with a budget of 26, under the 28 dominoes of the east
// +4 its tower needs to fold (+1 to +3 leave it standing), so no build within the budget could clear it.
import { describe, expect, it } from 'vitest';
import { FUSE_SITES, levelById, placedCost } from '@tb/keystone';
import { built, sweepBuilds } from '../src/fuse-gate.ts';
import { DOMINO_BEST } from '../src/fuse-domino-best.ts';

describe('domino-fuse budgets', () => {
  it.for(Object.keys(DOMINO_BEST))('%s: the gate\'s best build fits the budget', (id) => {
    const b = DOMINO_BEST[id]!, lv = levelById(id), best = sweepBuilds(b.site, b.order).find((x) => x.name === b.best)!;
    expect(best, b.best).toBeDefined();
    expect(placedCost(built(lv, best))).toBeLessThanOrEqual(lv.build!.budget!);
  });

  it('F6 has room for every sweep its gate tried that folds the tower (east +4 and +5; +6 does not fit the lane)', () => {
    const lv = levelById('F6'), builds = sweepBuilds('FD-1', [0, 1]);
    for (const name of ['forward +4', 'forward +5']) expect(placedCost(built(lv, builds.find((x) => x.name === name)!)), name).toBeLessThanOrEqual(lv.build!.budget!);
    expect(FUSE_SITES['FD-1']!.fuse.budget).toBe(32);
  });
});

// Fuse & Fold's domino-fuse levels on the reference engine (M5b, docs/game/fuse-and-fold.md, "Domino fuses"), one level
// per test file (fuse-ref-F*.test.ts): on one nudged build the straight build (every lane burning together) misses the
// objective and drops the frame a storey, and the best build the order gate confirmed (fuse-domino-best.ts) meets it,
// neighbours untouched, by at least the gate's tenth. The gate ran 8 builds; this keeps one honest.
import { describe, expect, it } from 'vitest';
import { FUSE_DOMINO_LEVELS } from '@tb/keystone';
import { DOMINO_BEST } from '../src/fuse-domino-best.ts';
import { playBuild, sweepBuilds } from '../src/fuse-gate.ts';

export function fuseRefSuite(id: string): void {
  describe('domino fuses on the reference engine', () => {
    it(`${id}: straight fuses drop it in place; the best build folds it into the lot`, { timeout: 280_000 }, async () => {
      const lvl = FUSE_DOMINO_LEVELS.find((l) => l.id === id)!, b = DOMINO_BEST[id]!, builds = sweepBuilds(b.site, b.order);
      const best = builds.find((x) => x.name === b.best);
      expect(best, b.best).toBeDefined();
      const naive = await playBuild(lvl, builds[0]!, 1), fell = await playBuild(lvl, best!, 1);
      expect(naive.met).toBe(false);
      expect(naive.collapse).toBeLessThan(0.4);
      expect(fell.met).toBe(true);
      expect(fell.heritage).toBe(0);
      expect(fell.fold - naive.fold).toBeGreaterThanOrEqual(0.1);
    });
  });
}

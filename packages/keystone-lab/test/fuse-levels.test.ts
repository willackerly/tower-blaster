// Every shipped Fuse & Fold level, on the reference engine at full size (one nudged build): everything at once
// misses the objective, and the best line the search confirmed (docs/game/mode-probes.md, X2 "On levels") meets
// it, neighbours untouched, by at least the gate's tenth. The search ran these on 8 builds; this keeps one honest.
import { describe, expect, it } from 'vitest';
import { compileLevel, FUSE_LEVELS } from '@tb/keystone';
import { playNudge, sweepLines } from '../src/fuse-search.ts';

/** The best line of each level's gate run, by sweep name. */
const BEST: Record<string, string> = { F1: 'W 1.0 s', F2: 'N 1.0 s', F3: 'W 1.0 s', F4: 'W 0.6 s', F5: 'W 0.7 s' };

describe('fuse & fold levels on the reference engine', () => {
  it('names a best line for every shipped level', () => {
    expect(FUSE_LEVELS.map((l) => l.id)).toEqual(Object.keys(BEST));
  });
  it.for(FUSE_LEVELS.map((l) => l.id))('%s: all at once drops in place; its best line folds into the lot', { timeout: 280_000 }, async (id) => {
    const lvl = FUSE_LEVELS.find((l) => l.id === id)!, lines = sweepLines(compileLevel(lvl));
    const best = lines.find((l) => l.name === BEST[id]);
    expect(best, BEST[id]).toBeDefined();
    const [naive, fell] = await playNudge(lvl, [lines[0]!, best!], 1);
    expect(naive!.met).toBe(false);
    expect(naive!.collapse).toBeLessThan(0.4);
    expect(fell!.met).toBe(true);
    expect(fell!.heritage).toBe(0);
    expect(fell!.fold - naive!.fold).toBeGreaterThanOrEqual(0.1);
  });
});

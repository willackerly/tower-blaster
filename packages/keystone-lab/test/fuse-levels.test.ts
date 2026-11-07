// Every shipped Fuse & Fold level, on the reference engine at full size (one nudged build): everything at once
// misses the objective, and the best line the search confirmed (docs/game/mode-probes.md, X2 "On levels") meets
// it, neighbours untouched, by at least the gate's tenth. The search ran these on 8 builds; this keeps one honest.
import { describe, expect, it } from 'vitest';
import { compileLevel, FUSE_LEVELS, type PlungerShot, PRESETTLE_STEPS, readShots } from '@tb/keystone';
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

// Why F1 to F5 settle by v3, not the outcome default v4 (docs/game/fuse-and-fold.md, "Settle rule"). v4 also ends
// a shot once the collapse has held for 2 s, however much still moves. A frame building can drop a storey, stand
// for longer than that, and then topple: v4 scores the stand. A sweep from the 2026-11-07 v4 recast of F3 (its
// competent line 16, on that play's build): v3 sees the fall (0.717), v4 ends the shot 212 steps after the last
// charge with the frame a storey down and standing (0.291).
describe('fold levels settle by v3', () => {
  it('every shipped level names v3', () => {
    expect(FUSE_LEVELS.map((l) => l.settle)).toEqual(FUSE_LEVELS.map(() => 'v3'));
  });
  it('F3: a frame that stands after its storey drops and then topples is scored standing by v4, fallen by v3', { timeout: 280_000 }, async () => {
    const F3 = FUSE_LEVELS.find((l) => l.id === 'F3')!, nudge = 654071718;
    const line = { name: 'slow', shot: readShots('plunger.8.6.5.18.7.24.2.36.4.36.6.36.1.48.3.54.0.72')[0] as PlungerShot };
    const lastStep = Math.max(...line.shot.fuse.map(([, d]) => d));
    const [v3] = await playNudge(F3, [line], nudge), [v4] = await playNudge({ ...F3, settle: 'v4' }, [line], nudge);
    expect(v3!.collapse).toBeGreaterThan(0.6);
    expect(v4!.collapse).toBeLessThan(0.35);
    // Long after every charge fired (the shot fires the step after the presettle): not a charge cut short.
    expect(v4!.steps - (PRESETTLE_STEPS + 1 + lastStep)).toBeGreaterThan(120);
    expect(v4!.steps).toBeLessThan(v3!.steps);
  });
});

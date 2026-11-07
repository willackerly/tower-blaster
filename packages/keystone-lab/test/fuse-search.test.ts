// Fuse & Fold's search and gate (fuse-search.ts): the sweep lines, the gate's arithmetic, and on the
// reference engine the fact the mode rests on: a frame tower dropped all at once stays standing a storey
// lower, while a sweep with enough delay fells it into its yard (docs/game/fuse-and-fold.md).
import { describe, expect, it } from 'vitest';
import { compileLevel, foldCandidate, FUSE_LEVELS } from '@tb/keystone';
import { lineOf, type LineStats, orderGate, playNudge, plungerCharges, rowRanks, SNAP_STEPS, sweepLines } from '../src/fuse-search.ts';

const lvl = FUSE_LEVELS.find((l) => l.id === 'F1') ?? foldCandidate('FC-1');
const c = compileLevel(lvl);

describe('sweep lines', () => {
  it('start with all at once, then every distinct sweep; each names every charge once, delays on the 0.1 s grid', () => {
    const lines = sweepLines(c), ch = plungerCharges(c);
    expect(lines[0]!.name).toBe('all at once');
    expect(lines[0]!.shot.fuse.every((f) => f[1] === 0)).toBe(true);
    expect(new Set(lines.map((l) => JSON.stringify(l.shot))).size).toBe(lines.length);
    for (const l of lines) {
      expect(l.shot.fuse.map((f) => f[0]).sort((a, b) => a - b)).toEqual(ch);
      for (const [, d] of l.shot.fuse) { expect(d % SNAP_STEPS).toBe(0); expect(d).toBeLessThanOrEqual(20 * SNAP_STEPS); }
    }
  });
  it('rank rows along a direction: falling west, the west columns go first', () => {
    const ch = plungerCharges(c), ranks = rowRanks(c, ch, -1, 0);
    const x = ch.map((k) => c.meta.home[3 * c.def.charges![k]!.host]!);
    ch.forEach((_, k) => expect(ranks[k]).toBe(x[k]! < 0 ? 0 : 1));
    expect(lineOf(ch, ranks.map((r) => r * 8)).fuse.at(-1)![1]).toBe(8 * SNAP_STEPS);
  });
});

describe('the order-matters gate', () => {
  const st = (name: string, fold: number, se: number, met: number): LineStats => ({ name, n: 8, fold, sd: se * Math.sqrt(8), se, collapse: fold, met, heritage: 0 });
  it('passes a best line 0.1 over the naive one by more than 3 standard errors that meets the objective 80% of the time', () => {
    expect(orderGate([st('naive', 0.2, 0.01, 0), st('W', 0.35, 0.01, 1)]).pass).toBe(true);
    expect(orderGate([st('naive', 0.2, 0.01, 0), st('W', 0.29, 0, 1)]).pass).toBe(false); // under 0.1
    expect(orderGate([st('naive', 0.2, 0.03, 0), st('W', 0.31, 0.03, 1)]).pass).toBe(false); // 2.6 SE
    expect(orderGate([st('naive', 0.2, 0, 0), st('W', 0.9, 0, 0.75)]).pass).toBe(false); // not fair
    // No spread at all: the SE floor makes 0.1 a pass, not a division by zero.
    const g = orderGate([st('naive', 0.2, 0, 0), st('W', 0.3, 0, 1)]);
    expect(g.pass).toBe(true);
    expect(Number.isFinite(g.z)).toBe(true);
  });
});

describe('a frame tower on the reference engine (one nudged build)', () => {
  it('drops in place all at once (objective missed) and folds into its yard when swept west with a long enough delay', { timeout: 300_000 }, async () => {
    const ch = plungerCharges(c), west = rowRanks(c, ch, -1, 0);
    const lines = [{ name: 'all at once', shot: lineOf(ch, ch.map(() => 0)) }, { name: 'W 1.0 s', shot: lineOf(ch, west.map((r) => r * 10)) }];
    const [naive, fell] = await playNudge(lvl, lines, 1);
    expect(naive!.met).toBe(false);
    expect(naive!.collapse).toBeLessThan(0.4);
    expect(fell!.met).toBe(true);
    expect(fell!.heritage).toBe(0);
    expect(fell!.fold - naive!.fold).toBeGreaterThanOrEqual(0.1);
  });
});

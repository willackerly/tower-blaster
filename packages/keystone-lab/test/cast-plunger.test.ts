// The star cast on a plunger level (Fuse & Fold; cast.ts plungerModel): lines are per-charge delays drawn as
// jittered sweeps, a move shifts one charge one snap, and the noise is the build's (a nudged build per play),
// since a timeline is exact steps. A tiny cast of F1 on the reference engine replays bit for bit.
import { describe, expect, it } from 'vitest';
import { B1, compileLevel, FUSE_LEVELS, type PlungerShot } from '@tb/keystone';
import { castLevel, type CastPlayer, defaultMetric, drawNudge, isPlungerLevel, lineModel, nodeCastPlayer, plungerModel, replayCast, rng } from '../src/cast.ts';
import { MAX_SNAPS, plungerCharges, SNAP_STEPS } from '../src/fuse-search.ts';

const F1 = FUSE_LEVELS[0]!, c = compileLevel(F1);

describe('the plunger line model', () => {
  it('is the model of a plunger-only rack, and the launch model elsewhere; a fold level casts on fold', () => {
    expect(isPlungerLevel(c)).toBe(true);
    expect(isPlungerLevel(compileLevel(B1))).toBe(false);
    expect(lineModel(c, 1).kind).toBe('plunger');
    expect(lineModel(compileLevel(B1), 1).kind).toBe('launch');
    expect(defaultMetric(F1)).toBe('fold');
    expect(defaultMetric(B1)).toBe('collapse');
  });
  it('draws competent lines as seeded sweeps: every charge once, delays on the grid, repeatable from the seed', () => {
    const m = plungerModel(c), ch = plungerCharges(c), a = m.competent(32, 7), b = m.competent(32, 7);
    expect(a).toEqual(b);
    expect(m.competent(32, 8)).not.toEqual(a);
    for (const snaps of a) {
      expect(snaps).toHaveLength(ch.length);
      for (const x of snaps) { expect(Number.isInteger(x)).toBe(true); expect(x).toBeGreaterThanOrEqual(0); expect(x).toBeLessThanOrEqual(MAX_SNAPS); }
      const [shot] = m.shots(snaps) as [PlungerShot];
      expect(shot.fuse.map((f) => f[0]).sort((x, y) => x - y)).toEqual(ch);
      for (const [, d] of shot.fuse) expect(d % SNAP_STEPS).toBe(0);
    }
    // Sweeps, not noise: most lines have a spread of delays.
    expect(a.filter((s) => Math.max(...s) - Math.min(...s) >= 2).length).toBeGreaterThan(16);
  });
  it('moves one charge one snap, and roughs a line up by its build, never its timeline', () => {
    const m = plungerModel(c), r = rng(3), line = [5, 5, 0, 0];
    for (let k = 0; k < 20; k++) {
      const moved = m.move(line, r), diff = moved.map((x, i) => Math.abs(x - line[i]!));
      expect(diff.reduce((s, x) => s + x, 0)).toBeLessThanOrEqual(1);
    }
    expect(m.move([0, 0, 0, 0], () => 0)).toEqual([0, 0, 0, 0]); // clamped at 0: the caller draws again
    const base = m.shots(line), n = m.noise(base, rng(4));
    expect(n.shots).toEqual(base);
    expect(n.nudge).toBeGreaterThan(0);
    expect(drawNudge(() => 0)).toBe(1);
  });
});

describe('a plunger cast on the reference engine', () => {
  it('casts F1 on fold with every play on its own nudged build, and replays its cloud bit for bit', { timeout: 280_000 }, async () => {
    const node = nodeCastPlayer({ kind: 'ref' }), seen: (readonly number[] | undefined)[] = [];
    const player: CastPlayer = { ...node, play: (lv, ls, nd) => { seen.push(nd); return node.play(lv, ls, nd); } };
    const r = await castLevel(F1, player, { recipe: { competent: 4, climbLines: 1, climbMoves: 1, climbNudges: 2, confirmLines: 0, confirmNudges: 0, cloud: 3 }, seed: 1 });
    expect(r.metric).toBe('fold');
    expect(r.n).toBe(4 + 2 * 2 + 3);
    expect(seen.every((nd) => nd !== undefined)).toBe(true);
    const nudges = r.lines.map((l) => l.nudge);
    expect(nudges.every((x) => x !== undefined && x > 0)).toBe(true);
    expect(new Set(nudges).size).toBe(nudges.length);
    expect(r.stars.t3).toBeGreaterThanOrEqual(r.stars.t2);
    // The best line's cloud: one line, three builds.
    expect(new Set(r.lines.filter((l) => l.phase === 'cloud').map((l) => l.shots)).size).toBe(1);
    const again = await replayCast(F1, nodeCastPlayer({ kind: 'ref' }), r, 'cloud', 3);
    expect(again.same).toBe(3);
  });
});

// The star cast on a domino-fuse level (M5c; cast.ts buildModel, fuse-gate.ts extrasBuild): a line is a build, the
// dominoes beyond straight each lane's fuse takes, its shot always Light the fuses; competent builds are sweeps that
// fit the budget, a move is one domino on one lane, the noise is the build's nudge, and every play runs on the level
// as its recorded build lays it, so a cast's plays replay. Also F6's budget (M5b shipped 26, under the 28 its tower
// needs): every gate's best build fits its level's budget.
import { describe, expect, it } from 'vitest';
import { type CastPlay, compileLevel, FUSE_LEVELS, FUSE_SITES, type LevelDef, levelById, placedCost, scenarioLevel, writeShots } from '@tb/keystone';
import { buildModel, castLevel, type CastPlayer, cloudCheck, competentIntents, laneRanks, lineModel, lineShots, nodeCastPlayer, playNoisy, poolCastPlayer, replayCast, rng } from '../src/cast.ts';
import { buildKey, buildLevel, built, extrasBuild, extrasProblem, firing, fuseSiteOf, outwardSide, parseBuildKey, sweepBuilds } from '../src/fuse-gate.ts';
import { DOMINO_BEST } from '../src/fuse-domino-best.ts';

const IDS = ['F6', 'F7', 'F8'] as const;
const F6 = levelById('F6');

describe('fuse builds as the cast lays them', () => {
  it('finds each level\'s fuse site, and none on a timeline level', () => {
    expect(IDS.map((id) => fuseSiteOf(levelById(id)))).toEqual(IDS.map((id) => DOMINO_BEST[id]!.site));
    expect(fuseSiteOf(FUSE_LEVELS[0]!)).toBeNull();
  });

  it('keys a build by its extras and reads the key back', () => {
    expect(buildKey([0, 5])).toBe('fuse.0.5');
    expect(parseBuildKey('fuse.0.3.12')).toEqual([0, 3, 12]);
    for (const bad of ['fuse', 'fuse.', 'fuse.-1', 'plunger.0.0', 'fuse.1.x']) expect(() => parseBuildKey(bad), bad).toThrow();
  });

  it('lays the gate\'s best builds of F6 and F7 exactly (F8\'s second lane now bumps outward, away from the third)', () => {
    const same = (id: string, extras: number[]) => {
      const b = DOMINO_BEST[id]!, g = sweepBuilds(b.site, b.order).find((x) => x.name === b.best)!;
      return extrasBuild(b.site, extras)!.fuses.map((f, k) => JSON.stringify(f) === JSON.stringify(g.fuses[k]));
    };
    expect(same('F6', [0, 5])).toEqual([true, true]);
    expect(same('F7', [0, 3, 6])).toEqual([true, true, true]);
    expect(same('F8', [0, 3, 6, 9])).toEqual([true, false, true, true]);
    // Outward from the board's middle: FD-3's west pair one way, its east pair the other.
    expect([0, 1, 2, 3].map((k) => outwardSide('FD-3', k))).toEqual([outwardSide('FD-3', 0), outwardSide('FD-3', 0), -outwardSide('FD-3', 0), -outwardSide('FD-3', 0)]);
  });

  it('every gate\'s best build fits its level\'s budget (F6 shipped at 26, under the 28 of its east +4)', () => {
    for (const id of IDS) {
      const b = DOMINO_BEST[id]!, lv = levelById(id), g = sweepBuilds(b.site, b.order).find((x) => x.name === b.best)!;
      expect(placedCost(built(lv, g)), id).toBeLessThanOrEqual(lv.build!.budget!);
    }
    expect(FUSE_SITES['FD-1']!.fuse.budget).toBeGreaterThanOrEqual(24 + 5);
  });

  it('refuses a build over the budget, past a lane\'s room, or of the wrong length, and builds the level from its key', () => {
    expect(extrasProblem('FD-1', [0, 5])).toBeNull();
    expect(extrasProblem('FD-1', [4, 5])).toMatch(/over the budget of 32/);
    expect(extrasProblem('FD-2', [0, 0, 40])).toBe('a lane cannot take that many');
    expect(extrasProblem('FD-2', [0, 0])).toMatch(/2 lanes for 3/);
    const lv = buildLevel(F6, 'fuse.0.5'), c = compileLevel(lv);
    expect(placedCost(lv)).toBe(12 + 17);
    expect(c.baseHash).toBe(compileLevel(F6).hash); // the stars' hash is the level's as authored
    expect(() => buildLevel(F6, 'fuse.9.9')).toThrow(/cannot be laid/);
    expect(() => buildLevel(FUSE_LEVELS[0]!, 'fuse.0.0')).toThrow(/not a fuse level/);
  });
});

describe('the build line model', () => {
  it('is the model of a fuse level; a timeline level keeps the plunger model', () => {
    expect(lineModel(compileLevel(F6), 1).kind).toBe('build');
    expect(lineModel(compileLevel(FUSE_LEVELS[0]!), 1).kind).toBe('plunger');
  });

  it.for(IDS)('%s: competent builds are seeded sweeps that can be laid, the shortest lane straight, the shot Light the fuses', (id) => {
    const lv = levelById(id), c = compileLevel(lv), m = buildModel(c), site = fuseSiteOf(lv)!, a = m.competent(64, 1);
    expect(m.competent(64, 1)).toEqual(a);
    expect(m.competent(64, 2)).not.toEqual(a);
    for (const ex of a) {
      expect(extrasProblem(site, ex), buildKey(ex)).toBeNull();
      expect(Math.min(...ex)).toBe(0);
      expect(m.shots(ex)).toEqual([firing(lv)]);
    }
    // Sweeps, not one build: several distinct, most with a spread.
    expect(new Set(a.map(buildKey)).size).toBeGreaterThan(8);
    expect(a.filter((ex) => Math.max(...ex) >= 2).length).toBeGreaterThan(32);
  });

  it('ranks lanes along a direction by their rows (F7: north first going north, all one rank going east)', () => {
    const c = compileLevel(levelById('F7'));
    expect(new Set(laneRanks(c, 1, 0)).size).toBe(1);
    expect(laneRanks(c, 0, 1)).toEqual([2, 1, 0]);
    expect(laneRanks(c, 0, -1)).toEqual([0, 1, 2]);
  });

  it('moves one lane one domino, staying layable, and roughs a build up by its nudge only', () => {
    const m = buildModel(compileLevel(levelById('F7'))), r = rng(3), line = [0, 3, 6];
    for (let k = 0; k < 40; k++) {
      const moved = m.move(line, r);
      expect(moved.reduce((s, x, i) => s + Math.abs(x - line[i]!), 0)).toBeLessThanOrEqual(1);
      expect(extrasProblem('FD-2', moved)).toBeNull();
    }
    expect(m.move([0, 0, 0], () => 0)).toEqual([0, 0, 0]); // lane 1 shortened past straight: the same build, the caller draws again
    const n = m.noise(m.shots(line), rng(4));
    expect(n.shots).toEqual([firing(levelById('F7'))]);
    expect(n.nudge).toBeGreaterThan(0);
    expect(m.build!(line)).toBe('fuse.0.3.6');
  });
});

/** A player without physics: a play's fold is 0.89 when its level lays 28 or more dominoes, else 0.25; it records each level it was given. */
function fakePlayer(seen: LevelDef[]): CastPlayer {
  return {
    adapter: 'fake', engine: 'ref', substeps: 1,
    async play(level, lines) {
      seen.push(level);
      const cost = placedCost(level), fold = cost >= 28 ? 0.89 : 0.25;
      return lines.map((): CastPlay => ({ samples: [{ shots: 1, step: 600, met: fold > 0.6, collapse: fold, crowns: 0, skyline: 1, score: 0, heritage: 0, pulled: 0, fold }], complete: true, steps: 600, hash: `h${cost}`, limits: [] }));
    },
  };
}

describe('a build cast', () => {
  it('plays every line on the level its build lays, records the builds, and replays and checks them', async () => {
    const seen: LevelDef[] = [], player = fakePlayer(seen);
    const r = await castLevel(F6, player, { recipe: { competent: 16, climbLines: 2, climbMoves: 3, climbNudges: 2, confirmLines: 2, confirmNudges: 2, cloud: 6 }, seed: 1 });
    expect(r.hash).toBe(compileLevel(F6).hash);
    expect(r.lines.every((l) => l.build && l.nudge)).toBe(true);
    // Each play's level laid its recorded build: its cost is the straight fuses' plus the key's extras.
    const costs = r.lines.map((l) => 24 + parseBuildKey(l.build!).reduce((a, x) => a + x, 0));
    expect(r.lines.map((l) => l.hash)).toEqual(costs.map((x) => `h${x}`));
    for (const lv of seen) expect(compileLevel(lv).baseHash).toBe(r.hash);
    // The best line is a build that folds the fake (28 or more dominoes), its shot Light the fuses, and the cloud plays it.
    expect(r.bestLine.shots).toBe(writeShots([firing(F6)]));
    expect(24 + parseBuildKey(r.bestLine.build!).reduce((a, x) => a + x, 0)).toBeGreaterThanOrEqual(28);
    expect(new Set(r.lines.filter((l) => l.phase === 'cloud').map((l) => l.build))).toEqual(new Set([r.bestLine.build]));
    expect(r.stars).toMatchObject({ metric: 'fold', t3: 0.89 });
    // Replay and the cross-device check play the recorded builds.
    expect((await replayCast(F6, player, r, 'competent', 16)).same).toBe(16);
    const check = await cloudCheck(F6, player, r, 4);
    expect(check.lines.every((l) => l.build === r.bestLine.build)).toBe(true);
    expect(check.crossDevice.pass).toBe(true);
  });

  it('groups a batch by build: one call per run of plays on one build, in order', async () => {
    const seen: LevelDef[] = [], player = fakePlayer(seen), shot = [firing(F6)];
    const out = await playNoisy(player, F6, [{ shots: shot, nudge: 1, build: 'fuse.0.5' }, { shots: shot, nudge: 2, build: 'fuse.0.5' }, { shots: shot, nudge: 3, build: 'fuse.0.0' }, { shots: shot, nudge: 4, build: 'fuse.0.5' }]);
    expect(out.map((p) => p.hash)).toEqual(['h29', 'h29', 'h24', 'h29']);
    expect(seen.map((lv) => placedCost(lv))).toEqual([29, 24, 29]);
  });

  it('on the reference engine: a tiny cast of F6 plays its builds and its cloud replays bit for bit', { timeout: 280_000 }, async () => {
    const r = await castLevel(F6, nodeCastPlayer({ kind: 'ref' }), { recipe: { competent: 1, climbLines: 1, climbMoves: 0, climbNudges: 1, confirmLines: 0, confirmNudges: 0, cloud: 1 }, seed: 1 });
    expect(r.n).toBe(3);
    expect(r.lines.every((l) => l.complete && l.limits.length === 0 && l.build)).toBe(true);
    const again = await replayCast(F6, nodeCastPlayer({ kind: 'ref' }), r, 'cloud', 1);
    expect(again.same).toBe(1);
  });
});

describe('the worker-pool player', () => {
  it('plays each line as the node player does, bit for bit, several at a time, and plays a batch\'s builds at once', { timeout: 280_000 }, async () => {
    const wall: LevelDef = { ...scenarioLevel('S3', { W: 6, H: 3 }, 1, { rack: ['cannonball'] }), id: 'T-pool' }, c = compileLevel(wall);
    const lines = competentIntents(c, 3, 1).map((its) => lineShots(c, its, 1)), nudges = [0, 7, 9];
    const pool = poolCastPlayer({ kind: 'ref' }, 3);
    try {
      expect(pool.concurrent).toBe(true);
      const [a, b] = await Promise.all([pool.play(wall, lines, nudges), nodeCastPlayer({ kind: 'ref' }).play(wall, lines, nudges)]);
      expect(a.map((p) => [p.hash, p.steps])).toEqual(b.map((p) => [p.hash, p.steps]));
      // Concurrent builds through playNoisy: in order, each on its own build.
      const seen: number[] = [], spy: CastPlayer = { ...fakePlayer([]), concurrent: true, play: async (lv, ls) => { seen.push(placedCost(lv)); return fakePlayer([]).play(lv, ls); } };
      const shot = [firing(F6)], out = await playNoisy(spy, F6, ['fuse.0.5', 'fuse.0.0', 'fuse.0.4'].map((build, k) => ({ shots: shot, nudge: k + 1, build })));
      expect(out.map((p) => p.hash)).toEqual(['h29', 'h24', 'h28']);
      expect(seen.sort()).toEqual([24, 28, 29]);
    } finally { await pool.close(); }
  });
});

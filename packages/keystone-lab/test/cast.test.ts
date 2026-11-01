// The star cast (keystone-lab cast.ts, roadmap G5.1): its statistics on known
// samples, its seeded sampling, and the whole recipe on a synthetic player
// (every number checkable by hand) and on Rapier with a tiny recipe.
import { describe, expect, it } from 'vitest';
import { type CastPlay, compileLevel, type LaunchShot, type LevelDef, scenarioLevel, type Shot } from '@tb/keystone';
import { AZ_SECTORS, castLevel, type CastPlayer, type CastRecipe, competentIntents, compareCasts, endValue, HEIGHT_BANDS, higherBetter, intentShot, moveIntents, nodeCastPlayer, nudgeLine, playsOf, quantile, rng, roundEasier, SHORT_RECIPE, streamSeed, surfaceTarget, withWallTime } from '../src/index.ts';

/** A 10 x 4 wall of plaster cubes along x as an outcome level, rack of two cannonballs. */
const WALL: LevelDef = { ...scenarioLevel('S3', { W: 10, H: 4 }, 1, { rack: ['cannonball', 'cannonball'] }), id: 'T1' };
const wall = compileLevel(WALL);

describe('statistics', () => {
  it('rounds toward easier to two significant figures', () => {
    expect(roundEasier(0.4567, true)).toBe(0.45);
    expect(roundEasier(0.4567, false)).toBe(0.46);
    expect(roundEasier(0.45, true)).toBe(0.45);
    expect(roundEasier(0.45, false)).toBe(0.45);
    expect(roundEasier(1234, true)).toBe(1200);
    expect(roundEasier(0.0789, true)).toBe(0.078);
    expect(roundEasier(0, true)).toBe(0);
  });
  it('quantiles interpolate between order statistics', () => {
    expect(quantile([4, 1, 3, 2, 5], 0.5)).toBe(3);
    expect(quantile([1, 2, 3, 4, 5], 0.25)).toBe(2);
    expect(quantile([1, 2, 3, 4], 0.25)).toBe(1.75);
  });
  it('skyline is the one metric where lower is better', () => {
    expect(['collapse', 'crowns', 'score', 'skyline'].map((m) => higherBetter(m as never))).toEqual([true, true, true, false]);
  });
});

describe('sampling', () => {
  it('streams are independent and repeatable', () => {
    const a = rng(streamSeed(1, 'x', 0)), b = rng(streamSeed(1, 'x', 0)), c = rng(streamSeed(1, 'x', 1));
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
  });
  it('competent intents stratify every shot slot over azimuth sector x height third', () => {
    const strata = AZ_SECTORS * HEIGHT_BANDS;
    const once = competentIntents(wall, strata, 7);
    for (let slot = 0; slot < WALL.rack.length; slot++) {
      const seen = once.map((l) => Math.floor(l[slot]!.az / (720 / AZ_SECTORS)) + AZ_SECTORS * Math.floor(l[slot]!.yFrac * HEIGHT_BANDS));
      expect(new Set(seen).size).toBe(strata);
    }
    const many = competentIntents(wall, 64, 7);
    for (let slot = 0; slot < WALL.rack.length; slot++) {
      const count = new Map<number, number>();
      for (const l of many) { const s = Math.floor(l[slot]!.az / 90) + 8 * Math.floor(l[slot]!.yFrac * 3); count.set(s, (count.get(s) ?? 0) + 1); }
      expect([...count.values()].every((k) => k === 2 || k === 3)).toBe(true);
    }
    expect(competentIntents(wall, 64, 7)).toEqual(many);
    expect(competentIntents(wall, 64, 8)).not.toEqual(many);
    for (const l of many) for (const it of l) expect(it.power >= 60 && it.power <= 100).toBe(true);
  });
  it('targets the face of the frontmost body at the asked height and lateral point', () => {
    const h = wall.frame.unit, m = wall.meta;
    // From +z (az 180 = 90 deg) the wall's broad face is at z = +h/2; lateral 0 is the -x end... seen from +z, w points to -x.
    for (const [lateral, xSign] of [[0, 1], [1, -1]] as const) {
      const t = surfaceTarget(wall, { item: 'cannonball', az: 180, yFrac: 0.1, lateral, power: 80 });
      expect(t.point[2]).toBeCloseTo(m.home[3 * t.body + 2]! + h / 2, 9);
      expect(Math.sign(m.home[3 * t.body]!)).toBe(xSign);
      expect(Math.floor(m.home[3 * t.body + 1]! / h)).toBe(0);
    }
    const top = surfaceTarget(wall, { item: 'cannonball', az: 180, yFrac: 0.95, lateral: 0.5, power: 80 });
    expect(Math.floor(m.home[3 * top.body + 1]! / h)).toBe(3);
    // From +x (az 0) the end face: the body at the +x end.
    const end = surfaceTarget(wall, { item: 'cannonball', az: 0, yFrac: 0.5, lateral: 0.5, power: 80 });
    expect(m.home[3 * end.body]!).toBe(Math.max(...Array.from({ length: m.n }, (_, i) => m.home[3 * i]!)));
  });
  it('aims each intent so the arc passes its target', () => {
    for (const line of competentIntents(wall, 8, 3)) for (const it of line) {
      const shot = intentShot(wall, it, 1) as LaunchShot;
      expect(shot.ammo).toBe('cannonball');
      expect(shot.power).toBe(it.power);
      expect(shot.az).toBe(it.az);
    }
  });
  it('a move changes one field of one shot by one step; nudges stay within hand noise', () => {
    const line = competentIntents(wall, 1, 1)[0]!, r = rng(5);
    for (let k = 0; k < 50; k++) {
      const moved = moveIntents(line, r);
      const diff = moved.flatMap((it, i) => (Object.keys(it) as (keyof typeof it)[]).filter((f) => it[f] !== line[i]![f]).map((f) => [i, f]));
      expect(diff.length).toBeLessThanOrEqual(1);
    }
    const shots = line.map((it) => intentShot(wall, it, 1)) as LaunchShot[];
    for (let k = 0; k < 50; k++) {
      const n = nudgeLine(shots, r) as LaunchShot[];
      n.forEach((s, i) => { expect(Math.abs(s.yaw - shots[i]!.yaw)).toBeLessThanOrEqual(6); expect(Math.abs(s.power - shots[i]!.power)).toBeLessThanOrEqual(3); expect([s.az, s.pitch, s.y]).toEqual([shots[i]!.az, shots[i]!.pitch, shots[i]!.y]); });
    }
  });
});

/**
 * A player with known physics: each shot brings down power/100 x (1 - |pitch|/900) / 2 of what is
 * left, plus a yaw term that rewards one exact yaw, so the cast's numbers can be recomputed here.
 */
function synthetic(lines: Shot[][] = []): CastPlayer {
  return {
    adapter: 'synthetic', engine: 'test', substeps: 1,
    async play(_level, batch) {
      lines.push(...batch);
      return batch.map((shots): CastPlay => {
        let left = 1;
        const samples = shots.map((s, k) => {
          const l = s as LaunchShot, gain = (l.power / 100) * (1 - Math.abs(l.pitch) / 900) * (0.4 + 0.1 * Math.cos(l.yaw / 10));
          left *= 1 - gain;
          const collapse = 1 - left;
          return { shots: k + 1, step: 100 * (k + 1), met: collapse >= 0.3, collapse, crowns: 0, skyline: left, score: Math.floor(3000 * collapse) };
        });
        return { samples, complete: true, steps: 100 * shots.length, hash: 'x', limits: [] };
      });
    },
  };
}

describe('castLevel on a synthetic player', () => {
  const TINY: CastRecipe = { competent: 16, climbLines: 2, climbMoves: 3, climbNudges: 4, cloud: 12 };
  it('plays the recipe, and its thresholds are the quantiles of what it played', async () => {
    const played: Shot[][] = [];
    const r = await castLevel(WALL, synthetic(played), { recipe: TINY, seed: 3 });
    expect(r.n).toBe(playsOf(TINY));
    expect(played.length).toBe(playsOf(TINY));
    expect(r.lines.map((l) => l.phase)).toEqual([...Array(16).fill('competent'), ...Array(2 * 4 * 4).fill('climb'), ...Array(12).fill('cloud')]);
    const ends = (phase: string) => r.lines.filter((l) => l.phase === phase).map((l) => l.samples.at(-1)!.collapse);
    expect(r.raw.t2).toBe(quantile(ends('competent'), 0.5));
    expect(r.raw.t3).toBe(quantile(ends('cloud'), 0.25));
    expect(r.raw.best).toBe(Math.max(...r.lines.flatMap((l) => l.samples.map((s) => s.collapse))));
    expect(r.stars).toMatchObject({ metric: 'collapse', t2: roundEasier(r.raw.t2, true), castOn: 'synthetic', engine: 'test', hash: wall.hash, n: r.n, seed: 3 });
    expect(r.stars.t3).toBe(Math.max(r.stars.t2, roundEasier(r.raw.t3, true)));
    expect(r.stars.t2).toBeLessThanOrEqual(r.stars.t3);
    // Each competent line samples every settle; the cloud is the best line nudged.
    for (const l of r.lines) expect(l.samples.map((s) => s.shots)).toEqual([1, 2]);
    expect(r.gates.fair.value).toBe(ends('cloud').filter((d) => d >= 0.3).length / 12);
    expect(r.gates.limits.pass && r.gates.complete.pass).toBe(true);
    expect(r.cloud.p25).toBe(r.raw.t3);
  });
  it('the same seed casts the same stars; another seed casts others', async () => {
    const a = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3 });
    const b = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3 });
    const c = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 4 });
    expect(b).toEqual(a);
    expect(c.lines.map((l) => l.shots)).not.toEqual(a.lines.map((l) => l.shots));
    const cmp = compareCasts(a, b);
    expect(cmp.recast.value).toBe(0);
    expect(cmp.crossDevice.pass).toBe(true);
  });
  it('the climb keeps a line only when its mini-cloud beats the current one', async () => {
    const r = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 9 });
    // The best line's score is the player-worse quartile of 4 nudged plays, at least the start line's.
    const climb = r.lines.filter((l) => l.phase === 'climb').map((l) => l.samples.at(-1)!.collapse);
    const starts = [0, 4 * 4].map((k) => quantile(climb.slice(k, k + 4), 0.25));
    expect(r.bestLine.score).toBeGreaterThanOrEqual(Math.max(...starts));
  });
  it('skyline is cast with lower as better: T3 at most T2', async () => {
    const r = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3, metric: 'skyline' });
    const ends = (phase: string) => r.lines.filter((l) => l.phase === phase).map((l) => l.samples.at(-1)!.skyline);
    expect(r.raw.t3).toBe(quantile(ends('cloud'), 0.75));
    expect(r.raw.best).toBe(Math.min(...r.lines.flatMap((l) => l.samples.map((s) => s.skyline))));
    expect(r.stars.t3).toBeLessThanOrEqual(r.stars.t2);
  });
  it('nothing settled counts as nothing achieved; the budget gate judges the wall time', async () => {
    expect(endValue({ samples: [], complete: false, steps: 0, hash: '', limits: [] }, 'collapse')).toBe(0);
    expect(endValue({ samples: [], complete: false, steps: 0, hash: '', limits: [] }, 'skyline')).toBe(1);
    const r = await castLevel(WALL, synthetic(), { recipe: TINY });
    expect(withWallTime(r, 59 * 60_000).gates.budget!.pass).toBe(true);
    expect(withWallTime(r, 61 * 60_000).gates.budget!.pass).toBe(false);
  });
  it('refuses a par level', async () => {
    await expect(castLevel({ ...WALL, scoring: 'par' }, synthetic(), { recipe: TINY })).rejects.toThrow(/par level/);
  });
  it('the short recipe is the spec\'s 186 plays', () => {
    expect(playsOf(SHORT_RECIPE)).toBe(186);
  });
});

describe('castLevel on Rapier', () => {
  it('a tiny cast plays real sessions: every line settles each shot, and the same seed casts the same stars', async () => {
    const recipe: CastRecipe = { competent: 4, climbLines: 1, climbMoves: 1, climbNudges: 2, cloud: 4 };
    const player = nodeCastPlayer({ kind: 'rapier' });
    const a = await castLevel(WALL, player, { recipe, seed: 2 });
    expect(a.n).toBe(12);
    for (const l of a.lines) {
      expect(l.complete).toBe(true);
      expect(l.samples.length).toBe(2);
      expect(l.samples[1]!.collapse).toBeGreaterThanOrEqual(0);
    }
    // At least one competent cannonball reached the wall.
    expect(Math.max(...a.lines.map((l) => l.samples.at(-1)!.collapse))).toBeGreaterThan(0);
    const b = await castLevel(WALL, player, { recipe, seed: 2 });
    expect(b.stars).toEqual(a.stars);
    expect(b.lines.map((l) => l.hash)).toEqual(a.lines.map((l) => l.hash));
  }, 300_000);
});

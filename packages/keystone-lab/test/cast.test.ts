// The star cast (keystone-lab cast.ts, roadmap G5.1): its statistics on known
// samples, its seeded sampling, and the whole recipe on a synthetic player
// (every number checkable by hand) and on Rapier with a tiny recipe.
import { describe, expect, it } from 'vitest';
import { aimAt, type CastPlay, type CastSample, compileLevel, readShots, writeShots, launcherPos, type LaunchShot, type LevelDef, scenarioLevel, type Shot } from '@tb/keystone';
import { lineShots, pullTarget, applyWaivers, bootstrapT3, castLevel, cloudCheck, crossDeviceGate, exposedFaces, faceSectors, facingAzimuth, FACE_SECTORS, REACH, type CastPlayer, type CastRecipe, type CastResult, competentIntents, compareCasts, compareReplay, extendCloud, judgeCast, replayCast, endValue, HEIGHT_BANDS, higherBetter, intentShot, moveIntents, nodeCastPlayer, nudgeLine, phaseEnds, playsOf, poolCasts, quantile, rng, roundEasier, SHORT_RECIPE, shotSummary, streamSeed, surfaceTarget, WAIVABLE, withWallTime } from '../src/index.ts';

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
  it('an exploration row counts a play that ran out of steps only at the settles it reached; one that banked, at its last', () => {
    const sample = (shots: number, collapse: number): CastSample => ({ shots, step: 100 * shots, met: collapse >= 0.2, collapse, crowns: 0, skyline: 1 - collapse, score: 0, heritage: 0, pulled: 0 });
    const play = (complete: boolean, ...c: number[]): CastPlay => ({ samples: c.map((x, k) => sample(k + 1, x)), complete, steps: 1, hash: '', limits: [] });
    // Out of steps after shot 1 (the SwiftShader smoke on B1a), banked after shot 2, and one full play.
    const plays = [play(false, 0.07), play(true, 0.1, 0.3), play(true, 0.2, 0.4, 0.6)];
    expect(shotSummary(plays, 0)).toMatchObject({ plays: 3, met: 1 / 3, collapse: { p50: 0.1, max: 0.2 } });
    expect(shotSummary(plays, 1)).toMatchObject({ plays: 2, met: 1, collapse: { min: 0.3, max: 0.4 } });
    expect(shotSummary(plays, 2)).toMatchObject({ plays: 2, met: 1, collapse: { min: 0.3, max: 0.6 } });
    expect(shotSummary([play(false, 0.07)], 1).plays).toBe(0);
  });
});

describe('sampling', () => {
  it('streams are independent and repeatable', () => {
    const a = rng(streamSeed(1, 'x', 0)), b = rng(streamSeed(1, 'x', 0)), c = rng(streamSeed(1, 'x', 1));
    const xs = [a(), a(), a()];
    expect([b(), b(), b()]).toEqual(xs);
    expect(c()).not.toBe(xs[0]);
  });
  it('exposed faces: a one-cube wall shows its broad faces everywhere and its ends only at the ends', () => {
    const [px, nx, pz, nz] = exposedFaces(wall);
    expect([pz!.length, nz!.length]).toEqual([40, 40]);
    expect([px!.length, nx!.length]).toEqual([4, 4]);
    expect(faceSectors(wall)).toEqual([0, 0, 4, 4]);
    // A 2 x 2 x 2 block: every body shows two side faces.
    const cube = compileLevel({ ...WALL, parts: [{ kind: 'block', at: [-1, 0, -1], size: [2, 2, 2], material: 'plaster' }] });
    expect(exposedFaces(cube).map((f) => f.length)).toEqual([4, 4, 4, 4]);
    expect(faceSectors(cube)).toEqual([2, 2, 2, 2]);
  });
  it('competent intents stratify every shot slot over face sector x height third', () => {
    const strata = FACE_SECTORS * HEIGHT_BANDS;
    const many = competentIntents(wall, 64, 7);
    for (let slot = 0; slot < WALL.rack.length; slot++) {
      const count = new Map<string, number>();
      for (const l of many) { const it = l[slot]!, k = `${it.dir}/${Math.floor(it.yFrac * HEIGHT_BANDS)}`; count.set(k, (count.get(k) ?? 0) + 1); }
      // A wall's 8 face sectors are 4 per broad face, so each (face, third) gets 4 of every round of 24: 8 in two
      // full rounds, and up to 4 more from the 16 lines of the third.
      expect([...count.keys()].sort()).toEqual(['2/0', '2/1', '2/2', '3/0', '3/1', '3/2']);
      expect([...count.values()].every((k) => k >= 8 && k <= 12)).toBe(true);
      expect([...count.values()].reduce((a, k) => a + k, 0)).toBe(64);
      expect(strata).toBe(24);
    }
    expect(competentIntents(wall, 64, 7)).toEqual(many);
    expect(competentIntents(wall, 64, 8)).not.toEqual(many);
    for (const l of many) for (const it of l) expect(it.power >= 60 && it.power <= 100 && Math.abs(it.skew) <= 1).toBe(true);
  });
  it('targets the asked face at the asked height and lateral point, from the ring point facing it', () => {
    const h = wall.frame.unit, m = wall.meta;
    // The +z face (dir 2): along it is x; lateral 0 is the -x end.
    for (const [lateral, xSign] of [[0, -1], [1, 1]] as const) {
      const t = surfaceTarget(wall, { item: 'cannonball', dir: 2, yFrac: 0.1, lateral, skew: 0, power: 80 });
      expect(t.point[2]).toBeCloseTo(m.home[3 * t.body + 2]! + h / 2, 9);
      expect(Math.sign(m.home[3 * t.body]!)).toBe(xSign);
      expect(Math.floor(m.home[3 * t.body + 1]! / h)).toBe(0);
    }
    const top = surfaceTarget(wall, { item: 'cannonball', dir: 3, yFrac: 0.95, lateral: 0.5, skew: 0, power: 80 });
    expect(Math.floor(m.home[3 * top.body + 1]! / h)).toBe(3);
    expect(top.point[2]).toBeCloseTo(-h / 2, 9);
    // Facing a point on the +z face head on is the ring point straight out along +z from it.
    const mid = surfaceTarget(wall, { item: 'cannonball', dir: 2, yFrac: 0.5, lateral: 0.5, skew: 0, power: 80 });
    const az = facingAzimuth(wall, mid.point, mid.normal, 0), p = launcherPos(wall.frame, az, 8);
    expect(Math.abs(p[0] - mid.point[0])).toBeLessThan(0.2);
    expect(p[2]).toBeGreaterThan(0);
    // Skewed 25 degrees, the launcher moves round the ring by about that much as seen from the target.
    const sk = launcherPos(wall.frame, facingAzimuth(wall, mid.point, mid.normal, 25), 8);
    expect((Math.atan2(sk[2] - mid.point[2], sk[0] - mid.point[0]) * 180) / Math.PI).toBeCloseTo(90 + 25, 0);
  });
  it('aims each intent so the arc passes its target, firing harder only when out of reach', () => {
    for (const line of competentIntents(wall, 8, 3)) for (const it of line) {
      const shot = intentShot(wall, it, 1) as LaunchShot, t = surfaceTarget(wall, it);
      expect(shot.ammo).toBe('cannonball');
      expect(shot.power).toBeGreaterThanOrEqual(it.power);
      const err = aimAt(wall.frame, 'cannonball', { az: shot.az, y: shot.y, power: shot.power }, t.point).error;
      if (shot.power > it.power) expect(aimAt(wall.frame, 'cannonball', { az: shot.az, y: shot.y, power: it.power }, t.point).error).toBeGreaterThan(REACH * wall.frame.unit);
      if (shot.power < 100) expect(err).toBeLessThanOrEqual(REACH * wall.frame.unit);
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
          return { shots: k + 1, step: 100 * (k + 1), met: collapse >= 0.3, collapse, crowns: 0, skyline: left, score: Math.floor(3000 * collapse), heritage: 0, pulled: 0 };
        });
        return { samples, complete: true, steps: 100 * shots.length, hash: 'x', limits: [] };
      });
    },
  };
}

/** Marks every gate of a cast passed, for pooling a synthetic cast that misses one. */
const passed = (r: CastResult): CastResult => ({ ...r, gates: Object.fromEntries(Object.entries(r.gates).map(([k, g]) => [k, { ...g, pass: true }])) as unknown as CastResult['gates'] });

const h32 = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 2 ** 32; };
/** A line's fields that a nudge leaves alone (nudgeLine moves yaw and power only). */
const baseKey = (shots: readonly Shot[]) => shots.map((s) => { const l = s as LaunchShot; return `${l.ammo}.${l.az}.${l.y}.${l.pitch}`; }).join('_');
/** The chance a line meets the objective: 0.95 for a `frac` share of lines, 0.5 for the rest. */
const basinP = (shots: readonly Shot[], frac: number) => (h32(`basin${baseKey(shots)}`) < frac ? 0.95 : 0.5);
/** A player in that world: each play meets the objective by a hash of its exact shots (collapse 0.6 to 0.7) or not (under 0.1). */
function basins(frac: number, lines: Shot[][] = []): CastPlayer {
  return {
    adapter: 'synthetic', engine: 'test', substeps: 1,
    async play(_level, batch) {
      lines.push(...batch);
      return batch.map((shots): CastPlay => {
        const t = writeShots(shots), met = h32(t) < basinP(shots, frac), v = h32(`v${t}`), collapse = met ? 0.6 + 0.1 * v : 0.1 * v;
        return { samples: [{ shots: shots.length, step: 100, met, collapse, crowns: 0, skyline: 1 - collapse, score: Math.round(3000 * collapse), heritage: 0, pulled: 0 }], complete: true, steps: 100, hash: 'x', limits: [] };
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
  it('a cloud check plays nudges of the cast\'s best line and gates its T3 on the cast\'s interval', async () => {
    const cast = await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3 });
    const played: Shot[][] = [];
    const k = await cloudCheck(WALL, synthetic(played), cast, 8, 1);
    expect(played.length).toBe(8);
    // Every play is the best line nudged: the same ammo, shot by shot, and not the cast's own cloud.
    const best = readShots(cast.bestLine.shots);
    for (const line of played) expect(line.map((s) => s.ammo)).toEqual(best.map((s) => s.ammo));
    expect(played.map((l) => writeShots(l))).not.toEqual(cast.lines.filter((l) => l.phase === 'cloud').slice(0, 8).map((l) => l.shots));
    const ends = k.lines.map((l) => l.samples.at(-1)!.collapse);
    expect(k.t3).toBe(quantile(ends, 0.25));
    // The gate's interval is for a cloud of 8 plays: the cast's own cloud resampled 8 at a time.
    const iv = bootstrapT3('collapse', phaseEnds(cast, 'cloud'), 1, 2000, 8);
    expect(k.crossDevice.pass).toBe(k.t3 >= iv.lo);
    expect(k.against).toEqual({ adapter: 'synthetic', seed: 3, t3: cast.raw.t3, lo: iv.lo, hi: iv.hi });
    expect(k.limits.pass && k.complete.pass).toBe(true);
    // Repeatable, and refused on a level that does not hash as the cast's.
    expect(await cloudCheck(WALL, synthetic(), cast, 8, 1)).toEqual(k);
    await expect(cloudCheck({ ...WALL, rack: ['cannonball'] }, synthetic(), cast, 8)).rejects.toThrow(/hashes .* but the cast was of/);
  });
  it('the cross-device gate fails a harder device only: a shift the player\'s way passes and says so', () => {
    const iv = { lo: 0.937, hi: 0.946, halfWidth: 0.0045 };
    const inside = crossDeviceGate('collapse', 0.94, iv, 'swiftshader', 'metal');
    expect(inside.pass).toBe(true);
    expect(inside.note).toMatch(/: inside$/);
    // B1 on SwiftShader: T3 0.9523 over Metal's 0.946.
    const easier = crossDeviceGate('collapse', 0.9523, iv, 'swiftshader', 'metal');
    expect(easier.pass).toBe(true);
    expect(easier.note).toMatch(/easier on swiftshader by 0\.0063/);
    const harder = crossDeviceGate('collapse', 0.93, iv, 'swiftshader', 'metal');
    expect(harder.pass).toBe(false);
    expect(harder.note).toMatch(/harder on swiftshader by 0\.0070/);
    // Skyline: lower is better, so a higher T3 is the harder side.
    const sky = { lo: 0.2, hi: 0.3, halfWidth: 0.05 };
    expect(crossDeviceGate('skyline', 0.35, sky, 'a', 'b').pass).toBe(false);
    expect(crossDeviceGate('skyline', 0.15, sky, 'a', 'b').pass).toBe(true);
  });
  it('a quartile of fewer plays spreads wider: the bootstrap interval at a smaller draw contains the full one', () => {
    const xs = Array.from({ length: 50 }, (_, k) => 0.9 + 0.001 * ((k * 37) % 50));
    const full = bootstrapT3('collapse', xs, 1), small = bootstrapT3('collapse', xs, 1, 2000, 8);
    expect(bootstrapT3('collapse', xs, 1, 2000, 50)).toEqual(full);
    expect(small.lo).toBeLessThanOrEqual(full.lo);
    expect(small.hi).toBeGreaterThanOrEqual(full.hi);
    expect(small.halfWidth).toBeGreaterThan(1.5 * full.halfWidth);
  });
  it('pools casts of one level on one device: T2 over every competent play, T3 over every nudge cloud', async () => {
    // The synthetic wall misses the skill gate (its T3 - T2 is under a tenth of the range); pooling needs it passed.
    const a = passed(await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3 })), b = passed(await castLevel(WALL, synthetic(), { recipe: TINY, seed: 4 }));
    const p = poolCasts([a, b]);
    const comp = [...phaseEnds(a, 'competent'), ...phaseEnds(b, 'competent')], cloud = [...phaseEnds(a, 'cloud'), ...phaseEnds(b, 'cloud')];
    expect(p.raw.t2).toBe(quantile(comp, 0.5));
    expect(p.raw.t3).toBe(quantile(cloud, 0.25));
    expect(p.raw.best).toBe(Math.max(a.raw.best, b.raw.best));
    expect(p.stars).toMatchObject({ metric: 'collapse', t2: roundEasier(p.raw.t2, true), hash: a.hash, n: a.n + b.n, seed: 3 });
    expect(p.stars.t3).toBeGreaterThanOrEqual(p.stars.t2);
    expect(p.seeds).toEqual([3, 4]);
    expect(p.competent.n).toBe(2 * TINY.competent);
    // One cast pools to its own stars.
    expect(poolCasts([a]).stars).toEqual(a.stars);
    expect(() => poolCasts([a, { ...b, hash: 'other' }])).toThrow(/is not of T1/);
    expect(() => poolCasts([a, { ...b, adapter: 'apple metal-3' }])).toThrow(/is not of/);
    expect(() => poolCasts([])).toThrow(/no casts/);
  });
  it('pools only casts that passed fair, skill, limits and complete; judges fair, skill and stable again on the pool', async () => {
    const a = passed(await castLevel(WALL, synthetic(), { recipe: TINY, seed: 3 })), b = passed(await castLevel(WALL, synthetic(), { recipe: TINY, seed: 4 }));
    const fail = (r: CastResult, g: 'fair' | 'skill' | 'limits' | 'complete' | 'stable' | 'budget'): CastResult => ({ ...r, gates: { ...r.gates, [g]: { ...(r.gates[g] ?? r.gates.fair), pass: false } } });
    expect(() => poolCasts([a, fail(b, 'fair')])).toThrow(/seed 4 failed fair .*cannot be pooled/);
    expect(() => poolCasts([fail(a, 'skill'), b])).toThrow(/seed 3 failed skill/);
    expect(() => poolCasts([a, fail(b, 'limits')])).toThrow(/failed limits/);
    // A cast that missed stable (or budget) may be pooled: stable is judged again on the pool.
    const p = poolCasts([fail(a, 'stable'), b]);
    const clouds = [a, b].flatMap((r) => r.lines.filter((l) => l.phase === 'cloud'));
    expect(p.gates.fair.value).toBe(clouds.filter((l) => l.samples.at(-1)!.met).length / clouds.length);
    expect(p.gates.skill.value).toBeCloseTo(p.raw.t3 - p.raw.t2, 12);
    expect(p.gates.skill.need).toBeCloseTo(0.1, 12);
    expect(p.gates.stable).toMatchObject({ need: 0.05 });
    expect(p.gates.stable.value).toBe(bootstrapT3('collapse', [...phaseEnds(a, 'cloud'), ...phaseEnds(b, 'cloud')], 3).halfWidth);
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
    // Banked: the best met settle once the objective is met (score falls with every shot after it), else the last.
    const at = (met: boolean, score: number, collapse: number): CastSample => ({ shots: 1, step: 1, met, collapse, crowns: 0, skyline: 1 - collapse, score, heritage: 0, pulled: 0 });
    const play = (...s: CastSample[]): CastPlay => ({ samples: s, complete: true, steps: 1, hash: '', limits: [] });
    expect(endValue(play(at(true, 3870, 0.1), at(true, 3482, 0.2), at(true, 2680, 0.29)), 'score')).toBe(3870);
    expect(endValue(play(at(false, 900, 0.1), at(true, 2000, 0.2), at(true, 2500, 0.3)), 'score')).toBe(2500);
    expect(endValue(play(at(false, 1200, 0.1), at(false, -14000, 0.3)), 'score')).toBe(-14000);
    expect(endValue(play(at(true, 3870, 0.1), at(true, 2680, 0.29)), 'collapse')).toBe(0.29);
    expect(endValue(play(at(true, 3870, 0.1), at(true, 2680, 0.29)), 'skyline')).toBeCloseTo(0.71, 12);
    const r = await castLevel(WALL, synthetic(), { recipe: TINY });
    expect(withWallTime(r, 59 * 60_000).gates.budget!.pass).toBe(true);
    expect(withWallTime(r, 61 * 60_000).gates.budget!.pass).toBe(false);
    const raised = withWallTime(r, 170 * 60_000, 200 * 60_000).gates.budget!;
    expect(raised.pass).toBe(true);
    expect(raised.need).toBe(200 * 60_000);
    expect(raised.note).toMatch(/raised from 60 to 200 min/);
    expect(withWallTime(r, 59 * 60_000).gates.budget!.note).not.toMatch(/raised/);
  });
  it('refuses a par level', async () => {
    await expect(castLevel({ ...WALL, scoring: 'par' }, synthetic(), { recipe: TINY })).rejects.toThrow(/par level/);
  });
  it('the short recipe is the spec\'s 186 plays plus 24 confirming the climb\'s best 3 lines', () => {
    expect(playsOf(SHORT_RECIPE)).toBe(210);
    expect(playsOf({ ...SHORT_RECIPE, confirmLines: 0 })).toBe(186);
  });
  it('confirming the climb\'s best lines picks a robust line more often than the luckiest 4-nudge sample does', async () => {
    // A world of lines that meet the objective 95% of the time (a fifth of them) or 50% (the rest), by a hash of
    // the fields a nudge leaves alone; each play's outcome is a hash of its exact shots. B2 seed 2 in miniature.
    const pick = async (confirmLines: number) => {
      let robust = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const r = await castLevel(WALL, basins(0.2), { recipe: { competent: 16, climbLines: 2, climbMoves: 8, climbNudges: 4, cloud: 1, confirmLines, confirmNudges: 8 }, seed });
        if (basinP(readShots(r.bestLine.shots), 0.2) > 0.9) robust++;
      }
      return robust;
    };
    const without = await pick(0), withConfirm = await pick(3);
    // Measured over 60 seeds: robust picks 45 of 60 without, 56 of 60 with (confirming 5 lines, or 16 nudges, no better).
    expect(withConfirm).toBeGreaterThan(without);
    expect(withConfirm).toBeGreaterThanOrEqual(17);
  }, 300_000);
  it('replays recorded plays exactly: all the same on the same physics, flagged where the physics changed', async () => {
    // The synthetic player's end hash is a hash of its shots and a physics version.
    const versioned = (v: string): CastPlayer => {
      const base = basins(0.2);
      return { ...base, async play(level, lines) { return (await base.play(level, lines)).map((p, k) => ({ ...p, hash: `${v}:${h32(writeShots(lines[k]!)).toFixed(9)}`, ...(v === 'v2' && k % 2 ? { steps: p.steps + 1 } : {}) })); } };
    };
    const cast = await castLevel(WALL, versioned('v1'), { recipe: { competent: 8, climbLines: 1, climbMoves: 1, climbNudges: 2, cloud: 6 }, seed: 2 });
    const same = await replayCast(WALL, versioned('v1'), cast, 'cloud', 4);
    expect(same.same).toBe(4);
    expect(same.rows.map((r) => r.shots)).toEqual(cast.lines.filter((l) => l.phase === 'cloud').slice(0, 4).map((l) => l.shots));
    expect(same.rows.every((r) => r.now.value === r.was.value)).toBe(true);
    const changed = await replayCast(WALL, versioned('v2'), cast, 'competent', 8);
    expect(changed.same).toBe(0);
    expect(changed.rows.length).toBe(8);
    await expect(replayCast({ ...WALL, rack: ['cannonball'] }, versioned('v1'), cast)).rejects.toThrow(/hashes/);
    expect(() => compareReplay(cast.lines.slice(0, 2), [], 'collapse')).toThrow(/0 plays for 2/);
  });
  it('extends a cast\'s cloud with fresh nudges of its best line and judges it again; refuses another device', async () => {
    const recipe: CastRecipe = { competent: 8, climbLines: 1, climbMoves: 1, climbNudges: 2, cloud: 6 };
    const played: Shot[][] = [];
    const cast = await castLevel(WALL, basins(0.2), { recipe, seed: 4 });
    const r = await extendCloud(WALL, basins(0.2, played), cast, 10);
    expect(played.length).toBe(10);
    const best = baseKey(readShots(cast.bestLine.shots));
    for (const l of played) expect(baseKey(l)).toBe(best);
    // New nudges, not the cloud replayed; the cast's own plays kept in order, the new ones after.
    const old = new Set(cast.lines.filter((l) => l.phase === 'cloud').map((l) => l.shots));
    expect(played.filter((l) => old.has(writeShots(l))).length).toBeLessThan(10);
    expect(r.lines.slice(0, cast.lines.length)).toEqual(cast.lines);
    expect(r.n).toBe(cast.n + 10);
    expect(r.cloud.n).toBe(16);
    const cloudEnds = r.lines.filter((l) => l.phase === 'cloud').map((l) => endValue(l, 'collapse'));
    expect(r.raw.t3).toBe(quantile(cloudEnds, 0.25));
    expect(r.raw.t2).toBe(cast.raw.t2);
    expect(r.gates).toMatchObject(judgeCast(wall, 'collapse', 4, r.lines).gates);
    // A second extension draws other nudges.
    const again: Shot[][] = [];
    await extendCloud(WALL, basins(0.2, again), r, 10);
    expect(again.map((l) => writeShots(l))).not.toEqual(played.map((l) => writeShots(l)));
    await expect(extendCloud(WALL, { ...basins(0.2), adapter: 'other' }, cast, 2)).rejects.toThrow(/same device/);
  });
  it('pools T3 from the best line of the casts (t3 best): T2 from every competent play, T3 from the best cloud', async () => {
    const recipe: CastRecipe = { competent: 8, climbLines: 1, climbMoves: 2, climbNudges: 2, cloud: 8 };
    const a = await castLevel(WALL, basins(0.3), { recipe, seed: 1 }), b = await castLevel(WALL, basins(0.3), { recipe, seed: 2 });
    const q = (r: CastResult) => quantile(phaseEnds(r, 'cloud'), 0.25);
    const top = q(a) >= q(b) ? a : b;
    const fairA = { ...a, gates: { ...a.gates, fair: { ...a.gates.fair, pass: true } } }, fairB = { ...b, gates: { ...b.gates, fair: { ...b.gates.fair, pass: true } } };
    const p = poolCasts([fairA, fairB], 'best');
    expect(p.t3Seed).toBe(top.seed);
    expect(p.raw.t3).toBe(q(top));
    expect(p.raw.t2).toBe(quantile([...phaseEnds(a, 'competent'), ...phaseEnds(b, 'competent')], 0.5));
    expect(p.stars.seed).toBe(top.seed);
    // A cast that failed skill or stable still gives its competent plays; only limits and complete must pass.
    const weak = { ...fairB, gates: { ...fairB.gates, skill: { ...fairB.gates.skill, pass: false } } };
    expect(poolCasts([fairA, weak], 'best').competent.n).toBe(16);
    expect(() => poolCasts([fairA, { ...fairB, gates: { ...fairB.gates, limits: { ...fairB.gates.limits, pass: false } } }], 'best')).toThrow(/failed limits/);
    // A cast that failed fair cannot set T3.
    const unfair = (r: CastResult) => ({ ...r, gates: { ...r.gates, fair: { ...r.gates.fair, pass: false } } });
    expect(poolCasts([unfair(top), top === a ? fairB : fairA], 'best').t3Seed).toBe(top === a ? b.seed : a.seed);
    expect(() => poolCasts([unfair(a), unfair(b)], 'best')).toThrow(/no cast passed fair/);
  });
  it('a line the climb judges twice pools its samples; a cast plays exactly playsOf with the confirmation', async () => {
    const played: Shot[][] = [];
    const recipe: CastRecipe = { competent: 8, climbLines: 1, climbMoves: 6, climbNudges: 4, cloud: 4, confirmLines: 3, confirmNudges: 8 };
    const r = await castLevel(WALL, basins(0.2, played), { recipe, seed: 5 });
    expect(r.n).toBe(playsOf(recipe));
    expect(played.length).toBe(playsOf(recipe));
    // The best line's score is the player-worse quartile of every climb or confirm play of it (at least 4 + 8).
    const base = baseKey(readShots(r.bestLine.shots));
    const mine = r.lines.filter((l) => l.phase === 'climb' && baseKey(readShots(l.shots)) === base).map((l) => endValue(l, 'collapse'));
    expect(mine.length).toBeGreaterThanOrEqual(12);
    expect(r.bestLine.score).toBe(quantile(mine, 0.25));
  });
});

describe('waivers (--waive)', () => {
  const g = (pass: boolean, value = 0) => ({ pass, value, need: 0.1, note: '' });
  it('waives only skill and stable, and only gates that failed; every other gate must pass', () => {
    expect([...WAIVABLE]).toEqual(['skill', 'stable']);
    const gates = { fair: g(true), skill: g(false, 0.099), stable: g(true), limits: g(true), complete: g(true), budget: undefined };
    expect(applyWaivers(gates, [])).toEqual({ pass: false, waived: [] });
    expect(applyWaivers(gates, ['skill'])).toEqual({ pass: true, waived: ['skill'] });
    // Waiving a gate that passed records nothing; naming it twice records it once.
    expect(applyWaivers(gates, ['skill', 'stable', 'skill'])).toEqual({ pass: true, waived: ['skill'] });
    expect(applyWaivers({ ...gates, stable: g(false) }, ['skill'])).toEqual({ pass: false, waived: ['skill'] });
    expect(applyWaivers({ ...gates, fair: g(false) }, ['skill', 'stable'])).toEqual({ pass: false, waived: ['skill'] });
  });
  it('refuses a gate that is not waivable or not there, so a typo never lands stars', () => {
    const gates = { fair: g(false), skill: g(true), stable: g(true) };
    for (const w of ['fair', 'limits', 'complete', 'budget', 'recast', 'skil']) expect(() => applyWaivers(gates, [w])).toThrow(/cannot be waived/);
    expect(() => applyWaivers({ fair: g(true) }, ['skill'])).toThrow(/no skill gate here/);
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

describe('pull intents (Undercut casts)', () => {
  it('a pull takes the nearest body a pull may take, never a crown, heritage, a fixed part or one the line already pulled', async () => {
    const { U1, U2, U3 } = await import('@tb/keystone');
    for (const d of [U1, U2, U3]) {
      const c = compileLevel(d), keep = new Set([...c.meta.crowns, ...c.meta.heritage, ...c.meta.fixed]);
      for (const its of competentIntents(c, 32, 3)) {
        const shots = lineShots(c, its, 1);
        const bodies = shots.map((s) => (s.ammo === 'pull' ? s.body : -1));
        expect(bodies.every((b) => b >= 0 && !keep.has(b)), d.id).toBe(true);
        expect(new Set(bodies).size, d.id).toBe(bodies.length);
      }
    }
    const c = compileLevel(U3), it0 = competentIntents(c, 1, 1)[0]![0]!;
    expect(pullTarget(c, it0, new Set(Array.from({ length: 30 }, (_, i) => i)))).toBe(-1); // only the crown left
  });

  it('U3 (hold) casts on the share pulled; a line whose capstone falls is complete, and meets the objective at its bank point', async () => {
    const { U3 } = await import('@tb/keystone');
    const cast = await castLevel(U3, nodeCastPlayer({ kind: 'rapier' }), { recipe: { competent: 8, climbLines: 1, climbMoves: 1, climbNudges: 1, cloud: 2, confirmLines: 0, confirmNudges: 0 } });
    expect(cast.metric).toBe('pulled');
    expect(cast.lines.every((l) => l.shots.split('_').every((x) => x.startsWith('pull.')))).toBe(true);
    expect(cast.gates.complete.pass).toBe(true);
    // Some competent line topples before its rack runs out, and still counts complete.
    expect(cast.lines.some((l) => l.shots.split('_').length > l.samples.length)).toBe(true);
    expect(cast.gates.fair.pass).toBe(true);
    expect(cast.stars.t3).toBeGreaterThan(cast.stars.t2);
  }, 120_000);
});

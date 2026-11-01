import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { quatFromAxisAngle } from '@tb/geom';
import {
  aabbTop, baselineOf, compileLevel, crownDown, DEFAULT_GOLD, GRAVITY, HEIGHT_BINS, heritageBroken, type LevelDef, levelScore, leverage, peOf_mJ,
  potential_mJ, quietUnder, reduceCpu, type Reductions, SETTLE_CAP, SETTLE_CAP_V2, SETTLE_MIN, SETTLE_QUIET, settleAllowance, settleCap, type SettleRule, settleUpdate, type ShotOutcome, skyline, stampOf, tier,
} from '@tb/keystone';

const def: LevelDef = {
  id: 'R', name: 'r', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 2,
  rack: ['marble', 'marble', 'cannonball'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [{ kind: 'block', at: [0, 0, 0], size: [1, 4, 1], material: 'plaster', courses: [{ k: 3, role: 'crown' }] }, { kind: 'block', at: [2, 0, 0], size: [1, 1, 1], material: 'stone', role: 'heritage' }],
};
const c = compileLevel(def);
const h = c.frame.unit;

/** Snapshot at the compiled home poses, all asleep, plus `extra` bodies (ammo). */
function atHome(extra = 0): Snapshot {
  const s = emptySnapshot(c.meta.n + extra);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}

describe('reductions', () => {
  it('potential energy is an exact integer sum of rounded per-body millijoules', () => {
    const s = atHome();
    const expected = Array.from({ length: c.meta.n }, (_, i) => Math.round(c.meta.mass[i]! * GRAVITY * c.meta.home[3 * i + 1]! * 1000)).reduce((a, b) => a + b);
    expect(potential_mJ(s, c)).toBe(expected);
    expect(Number.isInteger(potential_mJ(s, c))).toBe(true);
    expect(peOf_mJ(31.25, 0.25)).toBe(76641);
  });
  it('counts displaced bodies strictly beyond 0.5 h of the shot baseline', () => {
    const s = atHome(), base = baselineOf(s, c, 0);
    s.pos[0] = s.pos[0]! + 0.5 * h; // exactly at the threshold: not displaced
    s.pos[3] = s.pos[3]! + 0.5 * h + 1e-9;
    expect(reduceCpu(s, null, c, base, 1).displaced).toBe(1);
  });
  it('counts bodies outside the lot grown by 0.5 h', () => {
    const s = atHome(), base = baselineOf(s, c, 0);
    s.pos[0] = c.lot.max[0] + 0.5 * h - 1e-9;
    s.pos[3] = c.lot.max[0] + 0.5 * h + 1e-9;
    expect(reduceCpu(s, null, c, base, 1).outOfLot).toBe(1);
  });
  it('bins by the top of the rotated world AABB', () => {
    const q = quatFromAxisAngle([0, 0, 1], Math.PI / 4);
    expect(aabbTop(1, q, [0.25, 0.25, 0.25])).toBeCloseTo(1 + 0.25 * Math.SQRT2, 12);
    const s = atHome(), r = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
    expect(r.heightHist.reduce((a, b) => a + b)).toBe(c.meta.n);
    expect(r.heightHist[HEIGHT_BINS - 1]).toBe(1); // the crown's top is the level's top
  });
  it('counts impacts by material and home band, net of gravity, for awake bodies only', () => {
    const s = atHome(), prev = new Float64Array(3 * s.count);
    // Body 0 (plaster, band 0) stops from 1 m/s; body 4 (stone heritage) is in free fall (no impact).
    prev[0] = 1;
    prev[3 * 4 + 1] = 0;
    s.linVel[3 * 4 + 1] = -GRAVITY / 60;
    s.awake[0] = 1; s.awake[4] = 1;
    const r = reduceCpu(s, prev, c, baselineOf(s, c, 0), 1);
    expect(r.impacts[0 * 8 + c.meta.band[0]!]).toBe(1);
    expect(r.impacts.reduce((a, b) => a + b)).toBe(1);
  });
  it('ignores ammo that has left the lot or lies on the ground when deciding motion', () => {
    const s = atHome(2), n = c.meta.n;
    s.awake[n] = 1; s.linVel[3 * n] = 3; s.pos.set([0, 0.1, 0], 3 * n); // rolling on the ground
    s.awake[n + 1] = 1; s.linVel[3 * (n + 1)] = 9; s.pos.set([50, 3, 0], 3 * (n + 1)); // far away
    const r = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
    expect(r.nAwake).toBe(0);
    expect(r.maxSpeed).toBe(0);
    s.pos.set([0, 2, 0], 3 * n); // in flight over the lot
    expect(reduceCpu(s, null, c, baselineOf(s, c, 0), 1).maxSpeed).toBe(3);
  });
  it('counts spin for the structure only: live ammo counts by its speed', () => {
    const s = atHome(1), n = c.meta.n;
    // A marble rolling slowly on a level top: slower than QUIET_SPEED, spinning faster than QUIET_SPIN.
    s.awake[n] = 1; s.pos.set([0, 5, 0], 3 * n); s.linVel.set([0.014, 0, 0], 3 * n); s.angVel.set([0, 0.1, -0.24], 3 * n);
    const r = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
    expect(r.nAwake).toBe(1);
    expect(r.maxSpeed).toBeCloseTo(0.014);
    expect(r.maxAngSpeed).toBe(0);
    expect(settleUpdate({ quietSince: 1 - SETTLE_QUIET + 1 }, r, -100).settled).toBe(true);
    // A structure body spinning in place still holds the shot open.
    s.awake[0] = 1; s.angVel.set([0, 0.24, 0], 0);
    const r2 = reduceCpu(s, null, c, baselineOf(s, c, 0), 1);
    expect(r2.maxAngSpeed).toBeCloseTo(0.24);
    expect(settleUpdate({ quietSince: 1 - SETTLE_QUIET + 1 }, r2, -100).settled).toBe(false);
  });
});

describe('settling', () => {
  const red = (step: number, speed: number, awake = 1): Reductions => ({ step, nAwake: awake, maxSpeed: speed, maxAngSpeed: 0, pe_mJ: 0, displaced: 0, outOfLot: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48), nMoving: 0, movingBox: new Float64Array(6), ammoSpeed: 0 });
  function run(speeds: number[], spawn = 0) {
    let st = { quietSince: null as number | null };
    for (let i = 0; i < speeds.length; i++) {
      const u = settleUpdate(st, red(spawn + 1 + i, speeds[i]!), spawn);
      st = u.state;
      if (u.settled) return spawn + 1 + i;
    }
    return null;
  }
  it(`settles after ${SETTLE_QUIET} consecutive quiet steps`, () => {
    expect(run([...Array(10).fill(1), ...Array(40).fill(0.01)])).toBe(10 + SETTLE_QUIET);
  });
  it('a spike resets the quiet run', () => {
    expect(run([...Array(20).fill(0.01), 1, ...Array(40).fill(0.01)])).toBe(21 + SETTLE_QUIET);
  });
  it(`never settles before spawn + ${SETTLE_MIN}, and always by spawn + ${SETTLE_CAP}`, () => {
    let st = { quietSince: null as number | null };
    const u = settleUpdate(st, red(5, 0, 0), 0);
    expect(u.settled).toBe(false);
    expect(settleUpdate(st, red(SETTLE_MIN, 0, 0), 0).settled).toBe(true);
    expect(run(Array(SETTLE_CAP + 5).fill(2))).toBe(SETTLE_CAP);
  });
});

describe('settle v2: a few stragglers per thousand', () => {
  const N = 10_000, A = settleAllowance(N);
  /** Reductions with `moving` structure bodies moving (the fastest at 1 m/s) and live ammo at ammoSpeed. */
  const red = (step: number, moving: number, ammoSpeed = 0): Reductions => ({
    step, nAwake: N, maxSpeed: moving ? 1 : 0.01, maxAngSpeed: 0, pe_mJ: 0, displaced: 0, outOfLot: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48),
    nMoving: moving, movingBox: new Float64Array(6), ammoSpeed,
  });
  function run(moving: (i: number) => number, steps: number, rule: SettleRule = 'v2', n = N, ammo: (i: number) => number = () => 0) {
    let st = { quietSince: null as number | null };
    for (let i = 0; i < steps; i++) {
      const u = settleUpdate(st, red(1 + i, moving(i), ammo(i)), 0, rule, n);
      st = u.state;
      if (u.settled) return 1 + i;
    }
    return null;
  }
  it('allows max(2, floor(n / 1000)) moving bodies', () => {
    expect([0, 1, 999, 1000, 2999, 3000, 9999, 10_000, 100_000].map(settleAllowance)).toEqual([2, 2, 2, 2, 2, 3, 9, 10, 100]);
  });
  it('settles with k stragglers at the allowance, and not with one more', () => {
    for (const n of [50, 2500, N]) {
      const a = settleAllowance(n);
      expect(run(() => a, 100, 'v2', n)).toBe(SETTLE_QUIET);
      expect(run(() => a + 1, 100, 'v2', n)).toBeNull();
    }
  });
  it(`counts ${SETTLE_QUIET} consecutive quiet steps, and one step over the allowance restarts them`, () => {
    expect(run((i) => (i < 40 ? 500 : A), 200)).toBe(40 + SETTLE_QUIET);
    expect(run((i) => (i < 40 ? 500 : i === 60 ? A + 1 : A), 200)).toBe(61 + SETTLE_QUIET);
  });
  it('waits for live ammo however quiet the structure is: a ball in flight moves no block', () => {
    expect(run(() => 0, 200, 'v2', N, (i) => (i < 50 ? 12 : 0))).toBe(50 + SETTLE_QUIET);
    // Under QUIET_SPEED (a ball rolling slowly on a top) counts as quiet, as in v1.
    expect(run(() => 0, 200, 'v2', N, () => 0.049)).toBe(SETTLE_QUIET);
  });
  it(`caps at ${SETTLE_CAP_V2} steps (v1: ${SETTLE_CAP})`, () => {
    expect(settleCap('v1')).toBe(SETTLE_CAP);
    expect(settleCap('v2')).toBe(SETTLE_CAP_V2);
    expect(run(() => 5000, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
    expect(run(() => 5000, SETTLE_CAP_V2 + 5, 'v1')).toBe(SETTLE_CAP);
  });
  it('v1 ignores nMoving and ammoSpeed: every awake body quiet, as before', () => {
    // A state v2 calls quiet (stragglers within the allowance) and v1 does not, and the reverse.
    const loose = red(1, A); // maxSpeed 1 m/s
    expect(quietUnder('v2', loose, N)).toBe(true);
    expect(quietUnder('v1', loose, N)).toBe(false);
    const still = { ...red(1, 0), maxSpeed: 0.01, nMoving: A + 1 };
    expect(quietUnder('v1', still, N)).toBe(true);
    expect(quietUnder('v2', still, N)).toBe(false);
    // Nothing awake is quiet under both.
    expect(quietUnder('v2', { ...red(1, A + 5, 3), nAwake: 0 }, N)).toBe(true);
  });
});

describe('ammoSpeed', () => {
  it('is the fastest live awake spawned body; the structure and dead ammo do not count', () => {
    const s = atHome(3), n = c.meta.n;
    s.awake[0] = 1; s.linVel.set([5, 0, 0], 0); // structure: not ammo
    s.awake[n] = 1; s.pos.set([0, 2, 0], 3 * n); s.linVel.set([0, 0, 2], 3 * n); // live
    s.awake[n + 1] = 1; s.pos.set([0, 0.1, 0], 3 * (n + 1)); s.linVel.set([7, 0, 0], 3 * (n + 1)); // on the ground: dead
    s.awake[n + 2] = 0; s.pos.set([0, 3, 0], 3 * (n + 2)); s.linVel.set([9, 0, 0], 3 * (n + 2)); // asleep
    expect(reduceCpu(s, null, c, baselineOf(s, c, 0), 1).ammoSpeed).toBe(2);
    expect(reduceCpu(atHome(), null, c, baselineOf(atHome(), c, 0), 1).ammoSpeed).toBe(0);
  });
});

describe('objectives and score', () => {
  it('crowns are down below the crown line or outside the lot', () => {
    expect(crownDown(c, [0, 2 * h - 1e-9, 0])).toBe(true);
    expect(crownDown(c, [0, 2 * h, 0])).toBe(false);
    expect(crownDown(c, [c.lot.max[0] + 1e-9, 5, 0])).toBe(true);
  });
  it('heritage breaks past 0.3 h of movement or 15 degrees of tilt', () => {
    const id: [number, number, number, number] = [0, 0, 0, 1];
    expect(heritageBroken(c, [0.3 * h - 1e-9, 0, 0], id, [0, 0, 0])).toBe(false);
    expect(heritageBroken(c, [0.3 * h + 1e-9, 0, 0], id, [0, 0, 0])).toBe(true);
    expect(heritageBroken(c, [0, 0, 0], quatFromAxisAngle([1, 0, 0], (14.9 * Math.PI) / 180), [0, 0, 0])).toBe(false);
    expect(heritageBroken(c, [0, 0, 0], quatFromAxisAngle([1, 0, 0], (15.1 * Math.PI) / 180), [0, 0, 0])).toBe(true);
  });
  it('skyline ignores two strays but counts three', () => {
    const hist = new Uint32Array(64);
    hist[10] = 50; hist[40] = 2;
    expect(skyline(hist, 64)).toBe(11);
    hist[40] = 3;
    expect(skyline(hist, 64)).toBe(41);
  });
  it('leverage and tiers', () => {
    expect(leverage(48_000_000, 1000)).toBe(48);
    expect(leverage(-5, 1000)).toBe(0);
    expect([4.99, 5, 14.99, 15, 39.9, 40].map(tier)).toEqual([0, 1, 1, 2, 2, 3]);
  });
  it('stamps', () => {
    expect([[1, 2], [1, 3], [2, 4], [3, 4], [4, 4], [5, 4], [6, 4], [9, 4]].map(([s, p]) => stampOf(s!, p!))).toEqual(['ACE', 'ACE', 'EAGLE', 'BIRDIE', 'PAR', 'BOGEY', 'DOUBLE BOGEY', '+5']);
  });
  const shot = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 1000, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
  it('reproduces the worked example: one marble on a par-1 level, L = 48, six crowns', () => {
    const s = levelScore({ ...def, par: 1 }, [shot({ ke: 1000, dPE_mJ: 48_000_000, crownsDown: 6 })], true, c.meta.n);
    expect(s.lines).toEqual([{ label: 'Strokes', value: 3000 }, { label: 'Leverage', value: Math.floor(300 * Math.log2(49)) }, { label: 'Combo', value: 1050 }]);
    expect(s.total).toBe(3000 + 1684 + 1050);
    expect(s.stars).toBe(3);
    expect(s.stamp).toBe('PAR');
  });
  it('stars: one for clearing over par, two at par below the gold line or with heritage broken, none when not cleared', () => {
    const lowL = [shot({ dPE_mJ: 1_000_000 })];
    expect(levelScore(def, [...lowL, ...lowL, ...lowL], true, 5).stars).toBe(1);
    expect(levelScore(def, lowL, true, 5).stars).toBe(2);
    expect(levelScore(def, [shot({ dPE_mJ: (DEFAULT_GOLD + 1) * 1e6, heritageNew: 1 })], true, 5).stars).toBe(2);
    expect(levelScore({ ...def, lGold: 3 }, [shot({ dPE_mJ: 3e6 })], true, 5).stars).toBe(3);
    const failed = levelScore(def, lowL, false, 5);
    expect([failed.stars, failed.stamp]).toEqual([0, 'INCOMPLETE']);
  });
  it('ace bonus and heritage penalty lines', () => {
    const s = levelScore(def, [shot({ heritageNew: 2 })], true, 5);
    expect(s.lines.map((l) => l.label)).toEqual(['Strokes', 'Leverage', 'Combo', 'Ace', 'Heritage']);
    expect(s.lines.at(-1)!.value).toBe(-1000);
    expect(s.stamp).toBe('ACE');
  });
});

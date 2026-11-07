import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { quatFromAxisAngle } from '@tb/geom';
import {
  aabbTop, ammoInFlight, baselineOf, compileLevel, crownDown, DEFAULT_GOLD, FROZEN_D, FROZEN_SPEED, FROZEN_STEPS, GRAVITY, HEIGHT_BINS, heritageBroken, type LevelDef, levelScore, leverage, parStars, peOf_mJ,
  potential_mJ, QUIET_SPEED, quietUnder, reduceCpu, type Reductions, SETTLE_CAP, SETTLE_CAP_V2, SETTLE_MIN, SETTLE_QUIET, SETTLE_RULES, settleAllowance, STEADY_D, STEADY_STEPS, settleCap, settleHeld, type SettleRule, type SettleState, settleUpdate, type ShotOutcome, skyline, stampOf, tier,
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
  const red = (step: number, speed: number, awake = 1): Reductions => ({ step, nAwake: awake, maxSpeed: speed, maxAngSpeed: 0, pe_mJ: 0, peHeritage_mJ: 0, displaced: 0, outOfLot: 0, mass_g: 0, spill_g: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48), nMoving: 0, movingBox: new Float64Array(6), ammoSpeed: 0 });
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
    step, nAwake: N, maxSpeed: moving ? 1 : 0.01, maxAngSpeed: 0, pe_mJ: 0, peHeritage_mJ: 0, displaced: 0, outOfLot: 0, mass_g: 0, spill_g: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48),
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

describe('settle v3: v2, or a frozen structure', () => {
  const N = 1000, A = settleAllowance(N);
  /** A wall ringing: `moving` bodies (over the allowance) at maxSpeed, the collapse D and displaced as given, live ammo at ammoSpeed. */
  const red = (step: number, o: { moving?: number; maxSpeed?: number; displaced?: number; ammoSpeed?: number } = {}): Reductions => ({
    step, nAwake: N, maxSpeed: o.maxSpeed ?? 0.3, maxAngSpeed: 0, pe_mJ: 0, peHeritage_mJ: 0, displaced: o.displaced ?? 40, outOfLot: 0, mass_g: 0, spill_g: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48),
    nMoving: o.moving ?? 150, movingBox: new Float64Array(6), ammoSpeed: o.ammoSpeed ?? 0,
  });
  /** The step a run of `steps` settles at (null: not within them), with reductions r(i) and D d(i). */
  function run(r: (i: number) => Reductions, d: (i: number) => number, steps: number, rule: SettleRule = 'v3') {
    let st: SettleState = { quietSince: null };
    for (let i = 0; i < steps; i++) {
      const u = settleUpdate(st, r(i), 0, rule, N, d(i));
      st = u.state;
      if (u.settled) return 1 + i;
    }
    return null;
  }
  it(`a ringing wall (150 bodies at 0.3 m/s, nothing changing) settles after ${FROZEN_STEPS} frozen steps; v2 holds it to the cap`, () => {
    expect(run((i) => red(1 + i), () => 0.0694, SETTLE_CAP_V2 + 5)).toBe(FROZEN_STEPS);
    expect(run((i) => red(1 + i), () => 0.0694, SETTLE_CAP_V2 + 5, 'v2')).toBe(SETTLE_CAP_V2);
  });
  it(`a fall (a body over ${FROZEN_SPEED} m/s) restarts the frozen run`, () => {
    expect(run((i) => red(1 + i, { maxSpeed: i === 30 ? FROZEN_SPEED : 0.3 }), () => 0.07, 400)).toBe(31 + FROZEN_STEPS);
    expect(run((i) => red(1 + i, { maxSpeed: 0.6 }), () => 0.07, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
  });
  it(`a slow slump (D gaining over ${FROZEN_D} in a run) or a slide (displaced growing) is not frozen`, () => {
    // D up 2e-6 a step: 1.2e-4 over the run, so each run breaks before its end.
    expect(run((i) => red(1 + i), (i) => 0.07 + 2e-6 * i, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
    // 1.5e-6 a step: 9e-5 over the run, within FROZEN_D: settles.
    expect(run((i) => red(1 + i), (i) => 0.07 + 1.5e-6 * i, 400)).toBe(FROZEN_STEPS);
    expect(run((i) => red(1 + i, { displaced: 40 + Math.floor(i / 50) }), () => 0.07, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
    // D falling back counts as change too.
    expect(run((i) => red(1 + i), (i) => 0.07 - 2e-6 * i, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
  });
  it(`live ammo counts as any body: a ball in flight (over ${FROZEN_SPEED} m/s) holds it, one rolling slowly with nothing changing does not`, () => {
    // Reductions.maxSpeed counts live ammo; ammoSpeed alone is what v2 reads.
    expect(run((i) => red(1 + i, { ammoSpeed: i < 300 ? 12 : 0.087, maxSpeed: i < 300 ? 12 : 0.3 }), () => 0.07, 600)).toBe(300 + FROZEN_STEPS);
    expect(run((i) => red(1 + i, { ammoSpeed: 0.087 }), () => 0.07, 600)).toBe(FROZEN_STEPS);
    expect(run((i) => red(1 + i, { ammoSpeed: 0.087 }), () => 0.07, SETTLE_CAP_V2 + 5, 'v2')).toBe(SETTLE_CAP_V2);
  });
  it('is v2 where v2 settles: stragglers within the allowance settle after the quiet run, not the frozen one', () => {
    expect(run((i) => red(1 + i, { moving: A, maxSpeed: 1 }), (i) => 0.07 + 0.01 * i, 200)).toBe(SETTLE_QUIET);
    expect(settleCap('v3')).toBe(SETTLE_CAP_V2);
  });
});

describe('settle v4: v3, or a steady collapse (agent playtest PT6)', () => {
  const N = 1000;
  /** Debris rolling (300 bodies at 1.5 m/s: v2 and v3 never settle on it) with displaced as given. */
  const red = (step: number, displaced = 40): Reductions => ({
    step, nAwake: N, maxSpeed: 1.5, maxAngSpeed: 0, pe_mJ: 0, peHeritage_mJ: 0, displaced, outOfLot: 0, mass_g: 0, spill_g: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48),
    nMoving: 300, movingBox: new Float64Array(6), ammoSpeed: 0,
  });
  function run(d: (i: number) => number, steps: number, rule: SettleRule = 'v4', r: (i: number) => Reductions = (i) => red(1 + i)) {
    let st: SettleState = { quietSince: null };
    for (let i = 0; i < steps; i++) {
      const u = settleUpdate(st, r(i), 0, rule, N, d(i));
      st = u.state;
      if (u.settled) return 1 + i;
    }
    return null;
  }
  it(`D within ${STEADY_D} for ${STEADY_STEPS} steps settles whatever still rolls; v3 holds it to the cap`, () => {
    expect(run(() => 0.17, SETTLE_CAP_V2 + 5)).toBe(STEADY_STEPS);
    expect(run(() => 0.17, SETTLE_CAP_V2 + 5, 'v3')).toBe(SETTLE_CAP_V2);
    // Displaced blocks creeping on do not hold it (v3's frozen run would restart on each).
    expect(run(() => 0.17, SETTLE_CAP_V2 + 5, 'v4', (i) => red(1 + i, 40 + Math.floor(i / 10)))).toBe(STEADY_STEPS);
  });
  it('a collapse still going (D gaining a step faster than the band allows over the run) restarts the run', () => {
    // A fall: D climbs 0.3 over 1 s, then holds.
    expect(run((i) => 0.1 + 0.3 * Math.min(1, i / 60), 600)).toBe(61 + STEADY_STEPS - 1);
    // A slow slump at 0.5% a second never settles on the steady run: each run breaks after 60 steps.
    expect(run((i) => 0.1 + (0.005 / 60) * i, SETTLE_CAP_V2 + 5)).toBe(SETTLE_CAP_V2);
    // Just inside the band over the run: settles.
    expect(run((i) => 0.1 + (0.0049 / STEADY_STEPS) * i, 400)).toBe(STEADY_STEPS);
  });
  it('is v3 where v3 settles first, and never before SETTLE_MIN', () => {
    const still = (i: number) => ({ ...red(1 + i), maxSpeed: 0.1, nMoving: 1 });
    expect(run(() => 0.2, 400, 'v4', still)).toBe(SETTLE_QUIET);
    expect(run(() => 0.2, 400, 'v4', (i) => ({ ...still(i), nMoving: 300 }))).toBe(FROZEN_STEPS);
    expect(settleCap('v4')).toBe(SETTLE_CAP_V2);
    let st: SettleState = { quietSince: null };
    for (let i = 1; i < SETTLE_MIN; i++) {
      const u = settleUpdate(st, { ...red(i), nAwake: 0 }, 0, 'v4', N, 0.2);
      expect(u.settled).toBe(false);
      st = u.state;
    }
  });
});

describe('ammo in flight holds the settle (agent playtest PT10)', () => {
  const asleep = (step: number): Reductions => ({ step, nAwake: 0, maxSpeed: 0, maxAngSpeed: 0, pe_mJ: 0, peHeritage_mJ: 0, displaced: 0, outOfLot: 0, mass_g: 0, spill_g: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48), nMoving: 0, movingBox: new Float64Array(6), ammoSpeed: 0 });
  /** The step a shot settles at over a structure asleep throughout, the ammo flying until `lands` (null: never). */
  function run(rule: SettleRule, lands: number | null, steps: number) {
    let st: SettleState = { quietSince: null };
    for (let i = 1; i <= steps; i++) {
      const u = settleUpdate(st, asleep(i), 0, rule, 1000, 0, lands === null || i < lands);
      st = u.state;
      if (u.settled) return i;
    }
    return null;
  }
  for (const rule of SETTLE_RULES) {
    it(`${rule}: a sleeping structure and approaching ammo settle when it lands, not at ${SETTLE_MIN}; a flight that never ends stops at the cap`, () => {
      // Before PT10 a sleeping structure (nAwake 0) settled the shot at SETTLE_MIN with the ball in the air.
      expect(run(rule, null, SETTLE_MIN)).toBe(null);
      expect(run(rule, 200, 400)).toBe(200);
      expect(run(rule, 5, 400)).toBe(SETTLE_MIN);
      expect(run(rule, null, settleCap(rule) + 5)).toBe(settleCap(rule));
    });
  }
  it('a flight resets the quiet and frozen runs, so a run cannot finish the step the ammo lands', () => {
    const quiet = (step: number): Reductions => ({ ...asleep(step), nAwake: 1, maxSpeed: 0.3 });
    let st: SettleState = { quietSince: null };
    for (let i = 1; i < 100; i++) st = settleUpdate(st, quiet(i), 0, 'v3', 1000, 0.07, true).state;
    expect(st).toEqual({ quietSince: null, frozenSince: null });
    const u = settleUpdate(st, quiet(100), 0, 'v3', 1000, 0.07, false);
    expect(u.settled).toBe(false);
    expect(u.state.quietSince).toBe(100);
  });
  it('settleHeld: ammo in flight holds every rule; a pending weapon (the hold) holds v4 only, v1 to v3 as their casts were made', () => {
    for (const rule of SETTLE_RULES) {
      expect(settleHeld(rule, true, false)).toBe(true);
      expect(settleHeld(rule, true, true)).toBe(true);
      expect(settleHeld(rule, false, false)).toBe(false);
      expect(settleHeld(rule, false, true)).toBe(rule === 'v4');
    }
  });
  it('ammoInFlight: before its first contact, moving, and above where it could rest on the ground', () => {
    const r = 0.25 * h; // a cannonball's radius
    expect(ammoInFlight(c, false, 3 * h, 12, r)).toBe(true);
    // L3's marble skims in at 0.6 h, where ammoLive already calls it grounded: still flying.
    expect(ammoInFlight(c, false, 0.6 * h, 15, 0.05 * h)).toBe(true);
    expect(ammoInFlight(c, true, 3 * h, 12, r)).toBe(false); // it touched something
    expect(ammoInFlight(c, false, r + 0.04 * h, 12, r)).toBe(false); // a grazing touchdown: rolling
    expect(ammoInFlight(c, false, 3 * h, 0.9 * QUIET_SPEED, r)).toBe(false); // a soft landing on a ledge
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
  it('stars (parStars): three less one per stroke over par and one for broken heritage, at least one once cleared', () => {
    // [strokes, par, heritage broken] -> stars: every row of the rule, the floor and the not-cleared case.
    const rows: Array<[number, number, number, number]> = [
      [1, 1, 0, 3], [2, 1, 0, 2], [3, 1, 0, 1], [9, 1, 0, 1],
      [1, 1, 1, 2], [1, 1, 4, 2], [2, 1, 1, 1], [3, 1, 2, 1],
      [1, 2, 0, 3], [2, 2, 0, 3], [3, 2, 0, 2], [4, 2, 0, 1], [1, 2, 1, 2], [2, 2, 1, 2], [3, 2, 1, 1],
    ];
    expect(rows.map(([s, p, h]) => parStars(true, s, p, h))).toEqual(rows.map((r) => r[3]));
    expect([parStars(false, 1, 1, 0), parStars(false, 5, 2, 3)]).toEqual([0, 0]);
  });
  it('stars never fall with fewer strokes or fewer heritage broken, and a clear in par with heritage intact is three', () => {
    for (let par = 1; par <= 4; par++) for (let s = 1; s <= 8; s++) for (let h = 0; h <= 3; h++) {
      const st = parStars(true, s, par, h);
      if (s > 1) expect(parStars(true, s - 1, par, h)).toBeGreaterThanOrEqual(st);
      if (h > 0) expect(parStars(true, s, par, h - 1)).toBeGreaterThanOrEqual(st);
      if (s <= par && h === 0) expect(st).toBe(3);
    }
  });
  it('the rule before 2026-11-06 (par, and leverage at lGold for the third star) never gives more stars: no record is demoted', () => {
    const old = (s: number, par: number, h: number, L: number, gold: number) => (s > par ? 1 : h === 0 && L >= gold ? 3 : 2);
    for (let par = 1; par <= 3; par++) for (let s = 1; s <= 6; s++) for (let h = 0; h <= 2; h++) for (const L of [0, 0.5, 1, 20]) {
      expect(parStars(true, s, par, h)).toBeGreaterThanOrEqual(old(s, par, h, L, 1));
    }
  });
  it('leverage earns the gold badge, not a star: one-shot clears either side of the line are both three stars', () => {
    const lowL = [shot({ dPE_mJ: 1_000_000 })];
    const p1 = { ...def, par: 1 };
    const below = levelScore({ ...p1, lGold: 3 }, [shot({ dPE_mJ: 2.99e6 })], true, 5), at = levelScore({ ...p1, lGold: 3 }, [shot({ dPE_mJ: 3e6 })], true, 5);
    expect([below.stars, below.gold, at.stars, at.gold]).toEqual([3, false, 3, true]);
    // Over par, or heritage broken, no badge however high the leverage.
    expect(levelScore({ ...p1, lGold: 3 }, [shot({ dPE_mJ: 3e6 }), shot({ dPE_mJ: 3e6 })], true, 5)).toMatchObject({ stars: 2, gold: false });
    expect(levelScore(p1, [shot({ dPE_mJ: (DEFAULT_GOLD + 1) * 1e6, heritageNew: 1 })], true, 5)).toMatchObject({ stars: 2, gold: false });
    // On the par-2 level: an ace and par are three, a bogey two, a double bogey one.
    expect([1, 2, 3, 4].map((n) => levelScore(def, Array(n).fill(lowL[0]), true, 5).stars)).toEqual([3, 3, 2, 1]);
    const failed = levelScore(def, lowL, false, 5);
    expect([failed.stars, failed.stamp, failed.gold]).toEqual([0, 'INCOMPLETE', false]);
  });
  it('ace bonus and heritage penalty lines', () => {
    const s = levelScore(def, [shot({ heritageNew: 2 })], true, 5);
    expect(s.lines.map((l) => l.label)).toEqual(['Strokes', 'Leverage', 'Combo', 'Ace', 'Heritage']);
    expect(s.lines.at(-1)!.value).toBe(-1000);
    expect(s.stamp).toBe('ACE');
  });
});

// A wave level's run window (LevelDef.runWindow, roadmap C22; rules.ts RUN_WINDOW_MAX's note): the cap is the window
// instead of the rule's, and a shot waits for its wave's front to die. Synthetic reductions shaped like probe X1's
// wave (a front of up to 16 awake, about 5 dominoes a second, D creeping up a domino at a time) on every settle rule,
// against the same stream without a window.
import { describe, expect, it } from 'vitest';
import {
  checkRunWindow, compileLevel, FROZEN_STEPS, type LevelDef, type Reductions, RUN_WINDOW_MAX, runWindowSteps, SETTLE_CAP, SETTLE_CAP_V2, SETTLE_QUIET, SETTLE_RULES,
  settleAllowance, settleCap, type SettleRule, type SettleState, settleUpdate, STEADY_STEPS,
} from '@tb/keystone';

const N = 10_000;
/** A wave over a 10k field for `front` steps: 8 structure bodies moving (within v2's allowance of 10) at 2 m/s, D up 0.6 per domino over N, 5 dominoes a second. Then it dies: `tail` bodies rock at 0.1 m/s, D holds. */
function wave(front: number, tail = 0) {
  const dAt = (i: number) => (0.6 * Math.floor((Math.min(i, front) * 5) / 60)) / N;
  const r = (i: number): Reductions => {
    const live = i < front;
    return {
      step: 1 + i, nAwake: live ? 16 : tail, maxSpeed: live ? 2 : tail ? 0.1 : 0, maxAngSpeed: live ? 4 : tail ? 0.3 : 0, pe_mJ: 0, displaced: Math.floor((Math.min(i, front) * 5) / 60),
      outOfLot: 0, heightHist: new Uint32Array(64), impacts: new Uint32Array(48), nMoving: live ? 8 : tail, movingBox: new Float64Array(6), ammoSpeed: 0, peAside_mJ: 0, mass_g: 0, spill_g: 0,
    };
  };
  return { r, d: dAt };
}

/** The step a shot spawned at 0 settles at (null: not within `steps`). */
function settleAt(w: ReturnType<typeof wave>, steps: number, rule: SettleRule, window?: number, inFlight = (_i: number) => false): number | null {
  let st: SettleState = { quietSince: null };
  for (let i = 0; i < steps; i++) {
    const u = settleUpdate(st, w.r(i), 0, rule, N, w.d(i), inFlight(i), window);
    st = u.state;
    if (u.settled) return 1 + i;
  }
  return null;
}

describe('run window: the cap', () => {
  it('is seconds over 30 and at most RUN_WINDOW_MAX, in steps of the level\'s dt', () => {
    for (const ok of [30.5, 45, 120, RUN_WINDOW_MAX]) expect(checkRunWindow(ok)).toBe(ok);
    for (const bad of [30, 10, 0, -5, RUN_WINDOW_MAX + 1, NaN, Infinity, '60', null]) expect(() => checkRunWindow(bad)).toThrow(/runWindow must be seconds over 30/);
    expect(runWindowSteps(45, 1 / 60)).toBe(2700);
    expect(runWindowSteps(RUN_WINDOW_MAX, 1 / 60)).toBe(36_000);
  });
  it('replaces the rule\'s cap when given, and leaves it alone when not', () => {
    for (const rule of SETTLE_RULES) {
      expect(settleCap(rule)).toBe(rule === 'v1' ? SETTLE_CAP : SETTLE_CAP_V2);
      expect(settleCap(rule, 2700)).toBe(2700);
    }
  });
  it('a front that never dies ends at the window, on every rule (and the ammo-in-flight hold ends there too)', () => {
    for (const rule of SETTLE_RULES) {
      expect(settleAt(wave(1e9), 4000, rule, 2700)).toBe(2700);
      expect(settleAt(wave(1e9), 4000, rule, 2700, () => true)).toBe(2700);
    }
  });
});

describe('run window: the settle waits for the front to die', () => {
  const FRONT = 3000; // 50 s, 250 dominoes
  it('without a window a 50 s wave over 10k is cut short on every rule: v1 by its 10 s cap, v2 and v3 by the stragglers allowance, v4 by its steady run too', () => {
    expect(settleAllowance(N)).toBe(10);
    expect(settleAt(wave(FRONT), 4000, 'v1')).toBe(SETTLE_CAP);
    expect(settleAt(wave(FRONT), 4000, 'v2')).toBe(SETTLE_QUIET);
    expect(settleAt(wave(FRONT), 4000, 'v3')).toBe(SETTLE_QUIET);
    // v4 alone (stragglers over the allowance): D creeps 0.6/N a domino, inside STEADY_D for far longer than STEADY_STEPS.
    const busy = wave(FRONT), over = { r: (i: number) => ({ ...busy.r(i), nMoving: i < FRONT ? 40 : 0 }), d: busy.d };
    expect(settleAt(over, 4000, 'v4')).toBe(STEADY_STEPS);
  });
  it('with a 60 s window it runs past 30 s to the front\'s death on every rule, and settles soon after it', () => {
    const W = runWindowSteps(60, 1 / 60);
    for (const rule of SETTLE_RULES) {
      const at = settleAt(wave(FRONT), 4000, rule, W)!;
      expect(at).toBeGreaterThan(FRONT);
      expect(at).toBeGreaterThan(SETTLE_CAP_V2);
      // Nothing awake once it dies: settled at once (from SETTLE_MIN; one step after the front's last).
      expect(at).toBe(FRONT + 1);
    }
  });
  it('a tail rocking after the front (3 bodies at 0.1 m/s, D holding) ends by v3 and v4\'s frozen run; v1 and v2, which have none, hold it to the window', () => {
    const W = runWindowSteps(60, 1 / 60), w = wave(FRONT, 3);
    expect(settleAt(w, 4000, 'v3', W)).toBe(FRONT + FROZEN_STEPS);
    expect(settleAt(w, 4000, 'v4', W)).toBe(FRONT + FROZEN_STEPS);
    // v2 under a window allows no stragglers; the tail's 3 are not quiet (v2 without a window would have settled, 3 <= 10).
    expect(settleAt(w, 4000, 'v2', W)).toBe(W);
    expect(settleAt(w, 4000, 'v1', W)).toBe(W);
  });
  it('v4\'s steady run counts only while nothing is fast: a slow creep with the front alive does not end it, the same creep after it does', () => {
    const W = runWindowSteps(60, 1 / 60), busy = wave(FRONT);
    const over = { r: (i: number) => ({ ...busy.r(i), nMoving: i < FRONT ? 40 : 2, nAwake: i < FRONT ? 40 : 2, maxSpeed: i < FRONT ? 2 : 0.3 }), d: busy.d };
    expect(settleAt(over, 4000, 'v4', W)).toBe(FRONT + Math.min(FROZEN_STEPS, STEADY_STEPS));
  });
});

describe('run window: the level', () => {
  const base: LevelDef = {
    id: 'RW', name: 'rw', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 1, objective: { kind: 'crowns' }, par: 1, rack: ['marble'], launcher: { radius: 10, y: 1, dropY: 8 },
    parts: [{ kind: 'run', path: [[0, 0], [0, 6]], pitch: 1.2, half: [0.5, 1, 0.15], material: 'plaster' }],
  };
  it('runWindow joins the hash when given, is checked at compile, and absent hashes as before', () => {
    const a = compileLevel(base), b = compileLevel({ ...base, runWindow: 60 }), c = compileLevel({ ...base, runWindow: 61 });
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3);
    expect(() => compileLevel({ ...base, runWindow: 20 })).toThrow(/runWindow must be seconds over 30/);
  });
  it('physics.asleep starts every structure body asleep, needs sleep, and joins the hash', () => {
    const awake = compileLevel({ ...base, physics: { sleep: true } }), asleep = compileLevel({ ...base, physics: { sleep: true, asleep: true } });
    expect(awake.scene.bodies.some((b) => b.asleep)).toBe(false);
    expect(asleep.scene.bodies.length).toBeGreaterThan(5);
    expect(asleep.scene.bodies.every((b) => b.asleep === true)).toBe(true);
    expect(asleep.hash).not.toBe(awake.hash);
    // Off is the default: written out, it hashes as absent.
    expect(compileLevel({ ...base, physics: { sleep: true, asleep: false } }).hash).toBe(awake.hash);
    expect(() => compileLevel({ ...base, physics: { asleep: true } })).toThrow(/asleep needs physics.sleep: true/);
  });
});

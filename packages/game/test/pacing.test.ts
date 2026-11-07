import { describe, expect, it } from 'vitest';
import { STEADY_D, STEADY_STEPS } from '@tb/keystone';
import {
  alphaAt, arrived, checkPaceFeel, DEFAULT_BUDGET_MS, DEFAULT_FEEL, FAST_SCALE, FRAME_MS, MAX_LAG_MS, newArrivals, Pacer, paceFeel, SLOWMO_IN, SLOWMO_MAX, SLOWMO_OUT, SLOWMO_SCALE, slowTag,
  SKIP_SCALE, SpeedMeter, stepCost, TAIL_GAIN, TAIL_STEPS, TailSkip, valve, VALVE_MIN, writePaceFeel, DEFAULT_UNDO_MB, MAX_UNDO_MB,
} from '../src/pacing.ts';

const DT_MS = 1000 / 60;

/** Frames of frameMs from t = 0: at each, as many steps as are due (a loop that asks again after each step). */
function steps(p: Pacer, frames: number, frameMs = DT_MS, o = {}, t0 = 0): number[] {
  const out: number[] = [];
  for (let f = 0; f < frames; f++) {
    const now = t0 + f * frameMs;
    let n = 0;
    while (n < 16 && p.due(now, DT_MS, o)) { p.stepped(DT_MS); n++; }
    out.push(n);
  }
  return out;
}
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe('pace feel', () => {
  it('juice and every camera motion are off unless the URL asks for them; the valve and the tail skip are on; every frame is drawn', () => {
    expect(paceFeel(new URLSearchParams(''))).toEqual(DEFAULT_FEEL);
    expect(DEFAULT_FEEL).toEqual({ hitStop: false, slowMo: false, budgetMs: DEFAULT_BUDGET_MS, tailSkip: true, follow: false, shake: false, frames: 'all', rapid: true, turnView: true, arcs: true, handoff: true, duelLead: true, undoMB: DEFAULT_UNDO_MB, launch: 'high', balls: 'painted', marks: true, view: 'goals', impact: true, xray: 'off', fx: 'damage', spent: true, sleepTint: false, sun: 'view', coats: true, pullAnim: true, frozenLook: true, frozenAim: true, chorusView: 'grid', modeUi: true });
    // Impact effects follow the damage by default (PT2); keystone.fx=classic restores the old look. Spent ammo fades (PT19), off by keystone.spent=0.
    expect(paceFeel(new URLSearchParams('?keystone.fx=classic'))).toEqual({ ...DEFAULT_FEEL, fx: 'classic' });
    expect(paceFeel(new URLSearchParams('?keystone.spent=0'))).toEqual({ ...DEFAULT_FEEL, spent: false });
    expect(() => paceFeel(new URLSearchParams('?keystone.fx=loud'))).toThrow(/keystone.fx/);
    // Undo memory: MB of checkpoints (0: undo replays the shots); out of range or not a number is refused.
    expect(paceFeel(new URLSearchParams('?keystone.undo=0'))).toEqual({ ...DEFAULT_FEEL, undoMB: 0 });
    expect(paceFeel(new URLSearchParams('?keystone.undo=256')).undoMB).toBe(256);
    for (const bad of ['-1', '', 'lots', String(MAX_UNDO_MB + 1)]) expect(() => paceFeel(new URLSearchParams(`?keystone.undo=${bad}`)), bad).toThrow(/keystone.undo must be from 0 to/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, undoMB: NaN })).toThrow(/undo memory must be from 0 to/);
    const q = new URLSearchParams();
    writePaceFeel({ ...DEFAULT_FEEL, undoMB: 64 }, q);
    expect(q.toString()).toBe('keystone.undo=64');
    expect(paceFeel(q).undoMB).toBe(64);
    expect(paceFeel(new URLSearchParams('?keystone.rapid=0'))).toEqual({ ...DEFAULT_FEEL, rapid: false });
    // A duel's aids are on by default (Will, 2026-11-06), each off by its key.
    expect(paceFeel(new URLSearchParams('?keystone.turnview=0'))).toEqual({ ...DEFAULT_FEEL, turnView: false });
    expect(paceFeel(new URLSearchParams('?keystone.arcs=0&keystone.turnview=1'))).toEqual({ ...DEFAULT_FEEL, arcs: false });
    expect(() => paceFeel(new URLSearchParams('?keystone.turnview=off'))).toThrow(/keystone.turnview must be 0 or 1: off/);
    expect(() => paceFeel(new URLSearchParams('?keystone.arcs=no'))).toThrow(/keystone.arcs must be 0 or 1: no/);
    // Stone marks are on by default (Will, 2026-11-06), off by keystone.marks=0.
    expect(paceFeel(new URLSearchParams('?keystone.marks=0'))).toEqual({ ...DEFAULT_FEEL, marks: false });
    expect(() => paceFeel(new URLSearchParams('?keystone.marks=off'))).toThrow(/keystone.marks must be 0 or 1: off/);
    // The real look's sun counts from the opening view (PT15), the look's own by keystone.sun=look.
    expect(paceFeel(new URLSearchParams('?keystone.sun=look'))).toEqual({ ...DEFAULT_FEEL, sun: 'look' });
    expect(() => paceFeel(new URLSearchParams('?keystone.sun=north'))).toThrow(/keystone.sun must be view or look: north/);
    // Crowns gilded and heritage glazed in every look (PT15), the old role tint by keystone.coats=0.
    expect(paceFeel(new URLSearchParams('?keystone.coats=0'))).toEqual({ ...DEFAULT_FEEL, coats: false });
    // Pulls drawn and Bullet Time's frozen look are on by default (playtest PT17, PT8), each off by its key, and write back.
    expect(paceFeel(new URLSearchParams('?keystone.pullanim=0'))).toEqual({ ...DEFAULT_FEEL, pullAnim: false });
    expect(paceFeel(new URLSearchParams('?keystone.frozenlook=0'))).toEqual({ ...DEFAULT_FEEL, frozenLook: false });
    expect(paceFeel(new URLSearchParams('?keystone.frozenaim=0'))).toEqual({ ...DEFAULT_FEEL, frozenAim: false });
    expect(paceFeel(new URLSearchParams('?keystone.modeui=0'))).toEqual({ ...DEFAULT_FEEL, modeUi: false });
    expect(() => paceFeel(new URLSearchParams('?keystone.frozenlook=off'))).toThrow(/keystone.frozenlook must be 0 or 1: off/);
    const off = new URLSearchParams();
    writePaceFeel({ ...DEFAULT_FEEL, pullAnim: false, frozenLook: false }, off);
    expect(off.toString()).toBe('keystone.pullanim=0&keystone.frozenlook=0');
    expect(paceFeel(off)).toEqual({ ...DEFAULT_FEEL, pullAnim: false, frozenLook: false });
    expect(() => paceFeel(new URLSearchParams('?keystone.rapid=off'))).toThrow(/keystone.rapid must be 0 or 1: off/);
    expect(paceFeel(new URLSearchParams('?keystone.hitstop=1'))).toEqual({ ...DEFAULT_FEEL, hitStop: true });
    expect(paceFeel(new URLSearchParams('?keystone.slowmo=1&keystone.hitstop=1'))).toEqual({ ...DEFAULT_FEEL, hitStop: true, slowMo: true });
    expect(paceFeel(new URLSearchParams('?keystone.slowmo=0'))).toEqual(DEFAULT_FEEL);
    expect(paceFeel(new URLSearchParams('?keystone.budget=0&keystone.tailskip=0'))).toEqual({ ...DEFAULT_FEEL, budgetMs: 0, tailSkip: false });
    expect(paceFeel(new URLSearchParams('?keystone.budget=16.7')).budgetMs).toBe(16.7);
    // The camera moves only when the player moves it (playtest, 2026-11-02): follow and shake are opt-in; =0 still reads.
    expect(paceFeel(new URLSearchParams('?keystone.follow=1'))).toEqual({ ...DEFAULT_FEEL, follow: true });
    expect(paceFeel(new URLSearchParams('?keystone.shake=1'))).toEqual({ ...DEFAULT_FEEL, shake: true });
    expect(paceFeel(new URLSearchParams('?keystone.follow=0&keystone.shake=0'))).toEqual(DEFAULT_FEEL);
    expect(() => paceFeel(new URLSearchParams('?keystone.follow=2'))).toThrow(/keystone.follow must be 0 or 1: 2/);
    expect(() => paceFeel(new URLSearchParams('?keystone.shake=on'))).toThrow(/keystone.shake must be 0 or 1: on/);
    expect(paceFeel(new URLSearchParams('?keystone.frames=auto'))).toEqual({ ...DEFAULT_FEEL, frames: 'auto' });
    expect(() => paceFeel(new URLSearchParams('?keystone.frames=60'))).toThrow(/keystone.frames must be one of all, half, auto: 60/);
    // Shots leave from high and balls are painted (playtest, 2026-11-06); each has its way back.
    expect(paceFeel(new URLSearchParams('?keystone.launch=level'))).toEqual({ ...DEFAULT_FEEL, launch: 'level' });
    expect(paceFeel(new URLSearchParams('?keystone.launch=high'))).toEqual(DEFAULT_FEEL);
    expect(() => paceFeel(new URLSearchParams('?keystone.launch=low'))).toThrow(/keystone.launch must be high or level: low/);
    expect(paceFeel(new URLSearchParams('?keystone.balls=plain'))).toEqual({ ...DEFAULT_FEEL, balls: 'plain' });
    expect(() => paceFeel(new URLSearchParams('?keystone.balls=red'))).toThrow(/keystone.balls must be painted or plain: red/);
  });
  it('refuses bad values, naming the key, and writes back only what differs from the default', () => {
    expect(() => paceFeel(new URLSearchParams('?keystone.budget=-1'))).toThrow(/keystone.budget must be from 0 to 1000 ms/);
    expect(() => paceFeel(new URLSearchParams('?keystone.budget='))).toThrow(/keystone.budget must be/);
    expect(() => paceFeel(new URLSearchParams('?keystone.tailskip=yes'))).toThrow(/keystone.tailskip must be 0 or 1: yes/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, budgetMs: NaN })).toThrow(/physics budget must be/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, frames: 'most' as 'all' })).toThrow(/keystone.frames must be/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, launch: 'up' as 'high' })).toThrow(/keystone.launch must be/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, balls: 'red' as 'plain' })).toThrow(/keystone.balls must be/);
    expect(() => checkPaceFeel({ ...DEFAULT_FEEL, sun: 'north' as 'look' })).toThrow(/keystone.sun must be/);
    for (const f of [DEFAULT_FEEL, { ...DEFAULT_FEEL, hitStop: true, budgetMs: 0 }, { ...DEFAULT_FEEL, slowMo: true, tailSkip: false, budgetMs: 20 }, { ...DEFAULT_FEEL, follow: true }, { ...DEFAULT_FEEL, shake: true }, { ...DEFAULT_FEEL, follow: true, shake: true }, { ...DEFAULT_FEEL, frames: 'half' as const }, { ...DEFAULT_FEEL, frames: 'auto' as const }, { ...DEFAULT_FEEL, rapid: false }, { ...DEFAULT_FEEL, launch: 'level' as const }, { ...DEFAULT_FEEL, balls: 'plain' as const }, { ...DEFAULT_FEEL, turnView: false }, { ...DEFAULT_FEEL, arcs: false }, { ...DEFAULT_FEEL, marks: false }, { ...DEFAULT_FEEL, sun: 'look' as const }, { ...DEFAULT_FEEL, coats: false }]) {
      const q = new URLSearchParams();
      writePaceFeel(f, q);
      expect(paceFeel(q)).toEqual(f);
    }
    const q = new URLSearchParams();
    writePaceFeel(DEFAULT_FEEL, q);
    expect(q.toString()).toBe('');
  });
});

describe('valve', () => {
  it('is budget / step time clamped to [0.25, 1]', () => {
    for (const [budget, step] of [[14, 5], [14, 14], [14, 18], [14, 28], [14, 56], [14, 200], [10, 20], [16.7, 18]] as const) {
      expect(valve(budget, step)).toBeCloseTo(Math.min(1, Math.max(VALVE_MIN, budget / step)), 12);
    }
    expect(valve(14, 28)).toBe(0.5);
    expect(valve(14, 1000)).toBe(VALVE_MIN);
    expect(valve(14, 1)).toBe(1);
  });
  it('lets fast-forward run up to its own scale, and is off with no budget or no measured step', () => {
    expect(valve(14, 3.5, FAST_SCALE)).toBe(FAST_SCALE);
    expect(valve(14, 7, FAST_SCALE)).toBe(2);
    expect(valve(0, 50)).toBe(1);
    expect(valve(14, NaN)).toBe(1);
    expect(valve(14, 0)).toBe(1);
  });
});

describe('stepCost', () => {
  it('counts from the later of submit and the step before\'s done', () => {
    expect(stepCost(100, 118, 90)).toBe(18); // the GPU was idle: from submit
    expect(stepCost(100, 136, 118)).toBe(18); // queued behind a running step: from its done
    expect(stepCost(100, 101, -Infinity)).toBe(1);
  });
});

describe('Pacer', () => {
  it('keeps the step cost each due() read, so the time scale it set can be checked against the cost it came from', () => {
    const p = new Pacer();
    expect(p.costMs).toBeNaN();
    p.due(0, DT_MS, { budgetMs: DEFAULT_BUDGET_MS, stepMs: 40 });
    expect(p.costMs).toBe(40);
    expect(p.timeScale).toBe(valve(DEFAULT_BUDGET_MS, 40));
    p.due(10, DT_MS, { budgetMs: DEFAULT_BUDGET_MS, stepMs: 80 });
    expect([p.costMs, p.timeScale]).toEqual([80, valve(DEFAULT_BUDGET_MS, 80)]);
    p.reset();
    expect(p.costMs).toBeNaN();
  });
  it('runs one step per 60 Hz frame, and one every other frame at 120 Hz', () => {
    expect(steps(new Pacer(), 10)).toEqual(Array(10).fill(1));
    const hi = steps(new Pacer(), 120, DT_MS / 2);
    expect(sum(hi)).toBeGreaterThanOrEqual(59);
    expect(sum(hi)).toBeLessThanOrEqual(61);
    expect(Math.max(...hi)).toBe(1);
  });
  it('catches up after a short stall, but drops owed time beyond MAX_LAG_MS (slow motion, not a burst)', () => {
    const p = new Pacer();
    steps(p, 5);
    let n = 0;
    while (p.due(5 * DT_MS + 500, DT_MS)) { p.stepped(DT_MS); n++; }
    expect(n).toBe(Math.floor(MAX_LAG_MS / DT_MS) + 1);
  });
  it('hit-stop holds steps for N 60 Hz frames, the longer request winning', () => {
    const p = new Pacer();
    steps(p, 3);
    p.hitStop(3); p.hitStop(5); p.hitStop(2);
    const after = steps(p, 9, DT_MS, {}, 3 * DT_MS);
    expect(after.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    expect(after.slice(5)).toEqual([1, 1, 1, 1]);
    expect(FRAME_MS).toBe(DT_MS);
  });
  it('slow motion follows its curve: ramp down, hold, ramp back after release', () => {
    expect(Pacer.curve(0, null)).toBe(1);
    expect(Pacer.curve(SLOWMO_IN / 2, null)).toBeCloseTo((1 + SLOWMO_SCALE) / 2, 12);
    expect(Pacer.curve(1, null)).toBe(SLOWMO_SCALE);
    expect(Pacer.curve(1 + SLOWMO_OUT / 2, 1)).toBeCloseTo((1 + SLOWMO_SCALE) / 2, 12);
    expect(Pacer.curve(SLOWMO_MAX + SLOWMO_OUT, null)).toBe(1); // never held forever
  });
  it('slow motion runs about 0.3 steps per frame while held, on real time, then recovers', () => {
    const p = new Pacer();
    p.slowMo();
    steps(p, 10);
    const held = sum(steps(p, 30, DT_MS, {}, 10 * DT_MS));
    expect(held).toBeGreaterThanOrEqual(8);
    expect(held).toBeLessThanOrEqual(10);
    p.release();
    steps(p, 30, DT_MS, {}, 40 * DT_MS);
    expect(p.slowing).toBe(false);
    expect(steps(p, 5, DT_MS, {}, 70 * DT_MS)).toEqual([1, 1, 1, 1, 1]);
  });
  it('fast-forward runs four steps a 60 Hz frame', () => {
    expect(steps(new Pacer(), 4, DT_MS, { fastForward: true }).slice(1)).toEqual([FAST_SCALE, FAST_SCALE, FAST_SCALE]);
  });
  it('the valve sets the time scale from the step cost and the budget', () => {
    const p = new Pacer();
    p.due(0, DT_MS, { stepMs: 28, budgetMs: 14 });
    expect(p.timeScale).toBe(0.5);
    p.due(1, DT_MS, { stepMs: 1000, budgetMs: 14 });
    expect(p.timeScale).toBe(VALVE_MIN);
    p.due(2, DT_MS, { stepMs: 5, budgetMs: 14 });
    expect(p.timeScale).toBe(1);
    // At half speed a step is due every other 60 Hz frame.
    const q = new Pacer();
    expect(sum(steps(q, 60, DT_MS, { stepMs: 28, budgetMs: 14 }))).toBe(30);
  });
});

describe('SpeedMeter', () => {
  it('reads sim time per real time from the steps as they complete', () => {
    for (const rate of [60, 45, 30, 15]) {
      const m = new SpeedMeter();
      for (let t = 0; t <= 4000; t += 1000 / rate) m.step(t, 1 / 60);
      expect(m.speed(4000)).toBeCloseTo(rate / 60, 1);
    }
  });
  it('starts as if at real time, and falls when steps stop', () => {
    const m = new SpeedMeter();
    expect(m.speed(0)).toBe(1);
    m.step(0, 1 / 60);
    expect(m.speed(2000)).toBeLessThan(0.05);
  });
  it('the HUD tag shows the speed only under 0.95', () => {
    expect([1, 0.96, 0.95, 0.8, 0.75, 0.25, 0.844].map(slowTag)).toEqual(['', '', '', '80% speed', '75% speed', '25% speed', '84% speed']);
  });
});

describe('TailSkip', () => {
  const n = 10_000;
  it(`turns on once under 1% move and D gained under ${TAIL_GAIN} over ${TAIL_STEPS} steps, and stays on`, () => {
    const t = new TailSkip();
    // A collapse: D climbing fast while thousands move.
    for (let i = 0; i < 200; i++) expect(t.update(3000, n, i * 0.002)).toBe(false);
    // The tail: 50 rocking, D creeping by 1e-5 a step (6e-4 over 60).
    let on = -1;
    for (let i = 0; i < 200 && on < 0; i++) if (t.update(50, n, 0.4 + i * 1e-5)) on = i;
    expect(on).toBe(TAIL_STEPS);
    expect(t.update(5000, n, 0.9)).toBe(true);
    t.reset();
    expect(t.on).toBe(false);
  });
  it('waits while D still gains or too many move, and needs a full window', () => {
    const t = new TailSkip();
    for (let i = 0; i < 300; i++) expect(t.update(50, n, i * 5e-5)).toBe(false); // 3e-3 over 60; past the steady band every 100 steps
    const u = new TailSkip();
    for (let i = 0; i < STEADY_STEPS - 1; i++) expect(u.update(100, n, 0.4 + 1e-5 * i)).toBe(false); // exactly 1%: not under
    const w = new TailSkip();
    for (let i = 0; i < TAIL_STEPS; i++) expect(w.update(0, n, 0.4)).toBe(false);
    expect(w.update(0, n, 0.4)).toBe(true);
  });
});

describe('TailSkip: a steady collapse (agent playtest PT6)', () => {
  const n = 10_000;
  it(`turns on once D stays within ${STEADY_D} for ${STEADY_STEPS} steps, however many still move`, () => {
    const t = new TailSkip();
    for (let i = 0; i < 60; i++) expect(t.update(3000, n, i * 0.005)).toBe(false); // falling
    let on = -1;
    for (let i = 0; i < 400 && on < 0; i++) if (t.update(3000, n, 0.3 + 1e-5 * i)) on = i;
    expect(on).toBe(STEADY_STEPS - 1);
  });
  it('a gain past the band restarts the run, as settle v4 counts it', () => {
    const t = new TailSkip();
    for (let i = 0; i < 100; i++) expect(t.update(3000, n, 0.3)).toBe(false);
    expect(t.update(3000, n, 0.3 + STEADY_D)).toBe(false); // at the band's edge: a new run
    for (let i = 1; i < STEADY_STEPS - 1; i++) expect(t.update(3000, n, 0.3 + STEADY_D)).toBe(false);
    expect(t.update(3000, n, 0.3 + STEADY_D)).toBe(true);
  });
});

describe('Skip (agent playtest PT6)', () => {
  it(`runs sim time at ${SKIP_SCALE}x real time past the valve; without it the valve and fast-forward hold`, () => {
    const p = new Pacer();
    p.due(0, DT_MS, { skip: true, stepMs: 12, budgetMs: 16.7 });
    expect(p.timeScale).toBe(SKIP_SCALE);
    p.due(1, DT_MS, { fastForward: true, stepMs: 12, budgetMs: 16.7 });
    expect(p.timeScale).toBeCloseTo(16.7 / 12, 9);
  });
});

describe('arrivals (moved from the viewer)', () => {
  it('alpha ramps over the usual interval between snapshots', () => {
    const a = newArrivals();
    expect(alphaAt(a, 0, DT_MS)).toBe(1);
    arrived(a, 0, DT_MS);
    arrived(a, 20, DT_MS);
    expect(alphaAt(a, 30, DT_MS)).toBeCloseTo(0.5, 9);
  });
});

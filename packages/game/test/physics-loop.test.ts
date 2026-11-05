// The game's physics loop on a fake clock (G4.2, spectacle-mode.md section 11):
// the time scale tracks the step budget. Each case runs the loop the game runs
// (runPhysics) for 10 s of fake time against an engine whose step costs a
// known time, and checks the sim speed it reached against
// min(valve(budget, cost), what the engine can do at all: dt / cost).
import { describe, expect, it } from 'vitest';
import type { PhysicsEngine } from '@tb/engine-api';
import { SlowedEngine } from '@tb/bench';
import { Pacer, valve } from '../src/pacing.ts';
import { type PhysicsHooks, runPhysics, type StepRun, wakeable } from '../src/physics-loop.ts';

const DT_MS = 1000 / 60;
const SECONDS = 10, WARM_MS = 2000;

interface Run { speed: number; costs: number[] }

/** Sim speed over [WARM_MS, end] and every cost the loop recorded. */
function measure(stepAt: number[], end: number, costs: number[]): Run {
  const n = stepAt.filter((t) => t >= WARM_MS && t < end).length;
  return { speed: (n * DT_MS) / (end - WARM_MS), costs };
}

/**
 * A GPU-like engine behind the game's pipelined driver: a step is submitted at once (0.2 ms to encode),
 * runs on the GPU when the one before is done and takes costMs; step() returns once the step before's
 * read has landed (its done). Frames come at frameMs.
 */
async function gpuRun(costMs: number, budgetMs: number, frameMs = 1000 / 120, jitter = 0): Promise<Run> {
  let now = 0, gpuFree = 0, prevDone = 0, k = 0;
  const stepAt: number[] = [], costs: number[] = [];
  const h: PhysicsHooks = {
    now: () => now,
    alive: () => now < SECONDS * 1000,
    active: () => true,
    dtMs: () => DT_MS,
    options: () => ({ budgetMs }),
    idle: async () => { now = (Math.floor(now / frameMs + 1e-9) + 1) * frameMs; },
    task: async () => {},
    step: async (): Promise<StepRun> => {
      const started = now;
      const c = costMs * (1 + jitter * Math.sin(k++ * 2.39996)); // a deterministic spread around costMs
      const start = Math.max(now + 0.2, gpuFree), done = start + c;
      gpuFree = done;
      now = Math.max(now + 0.2, prevDone);
      prevDone = done;
      stepAt.push(now);
      return { started, submitted: now, done: Promise.resolve(done), yielded: true };
    },
  };
  await runPhysics(h, new Pacer(), undefined, (ms) => costs.push(ms));
  return measure(stepAt, now, costs);
}

/** A CPU engine on this thread, its step padded by @tb/bench's SlowedEngine on the same fake clock. */
async function cpuRun(innerMs: number, fraction: number, budgetMs: number, frameMs = 1000 / 60): Promise<Run> {
  let now = 0;
  const clock = () => (now += 0.01);
  const inner = { stepIndex: 0, async step() { now += innerMs; } } as unknown as PhysicsEngine;
  const e = new SlowedEngine(inner, fraction, clock);
  const stepAt: number[] = [], costs: number[] = [];
  const h: PhysicsHooks = {
    now: () => now,
    alive: () => now < SECONDS * 1000,
    active: () => true,
    dtMs: () => DT_MS,
    options: () => ({ budgetMs }),
    idle: async () => { now = (Math.floor(now / frameMs + 1e-9) + 1) * frameMs; },
    task: async () => {},
    step: async (): Promise<StepRun> => {
      const started = now;
      await e.step();
      stepAt.push(now);
      return { started, submitted: now, yielded: false };
    },
  };
  await runPhysics(h, new Pacer(), undefined, (ms) => costs.push(ms));
  return measure(stepAt, now, costs);
}

const expected = (costMs: number, budgetMs: number) => Math.min(valve(budgetMs, costMs), DT_MS / costMs);
/** A budget under a whole step (as the default, DEFAULT_BUDGET_MS), so the valve itself sets the speed. */
const BUDGET_MS = 14;

describe('the physics loop: time scale tracks the step budget', () => {
  it('GPU-like engine: sim speed = min(budget / cost clamped to [0.25, 1], dt / cost)', async () => {
    const rows: string[] = [];
    for (const cost of [3, 8, 11, 14, 16, 18, 20, 28, 40, 56, 100]) {
      const r = await gpuRun(cost, BUDGET_MS);
      rows.push(`${cost}: ${r.speed.toFixed(3)} (want ${expected(cost, BUDGET_MS).toFixed(3)})`);
      expect(r.speed, rows.at(-1)).toBeGreaterThan(expected(cost, BUDGET_MS) * 0.97);
      expect(r.speed, rows.at(-1)).toBeLessThan(expected(cost, BUDGET_MS) * 1.03);
    }
  });

  it('measures a GPU step\'s own cost whether or not it queued behind the one before', async () => {
    // 18 ms against a 14 ms budget: the loop slows time to 0.78, so steps no longer queue; their cost must still read 18
    // (timing step() alone would read about 0.2 ms here, and the valve would open and close every few steps).
    const r = await gpuRun(18, 14);
    const late = r.costs.slice(100);
    expect(Math.min(...late)).toBeGreaterThan(17.5);
    expect(Math.max(...late)).toBeLessThan(18.5);
    // No budget: the engine runs flat out, every step queued behind the last; the cost still reads 18.
    const flat = await gpuRun(18, 0);
    expect(flat.speed).toBeCloseTo(DT_MS / 18, 2);
    expect(Math.max(...flat.costs.slice(100))).toBeLessThan(18.5);
  });

  it('a spread of step costs still settles on the median\'s scale (no oscillation)', async () => {
    const r = await gpuRun(20, 14, 1000 / 120, 0.3); // 14 to 26 ms
    expect(r.speed).toBeGreaterThan(0.7 * 0.95);
    expect(r.speed).toBeLessThan(0.7 * 1.05);
  });

  it('on a 60 Hz display and a 144 Hz one alike', async () => {
    for (const hz of [60, 144]) {
      const r = await gpuRun(28, 14, 1000 / hz);
      expect(r.speed).toBeGreaterThan(0.5 * 0.97);
      expect(r.speed).toBeLessThan(0.5 * 1.03);
    }
  });

  it('CPU engine slowed by SlowedEngine: the same rule on the step\'s wall time', async () => {
    // A 4 ms step padded by +250% and +600%: 14 and 28 ms; and unpadded.
    for (const [inner, f] of [[4, 0], [4, 2.5], [4, 6]] as const) {
      const cost = inner * (1 + f), r = await cpuRun(inner, f, 14);
      expect(r.speed, `${cost} ms`).toBeGreaterThan(expected(cost, 14) * 0.96);
      expect(r.speed, `${cost} ms`).toBeLessThan(expected(cost, 14) * 1.04);
    }
  });

  it('fast-forward runs as fast as the budget allows, up to four times real time', async () => {
    let now = 0, gpuFree = 0, prevDone = 0;
    const stepAt: number[] = [];
    const h: PhysicsHooks = {
      now: () => now, alive: () => now < SECONDS * 1000, active: () => true, dtMs: () => DT_MS,
      options: () => ({ budgetMs: 14, fastForward: true }),
      idle: async () => { now = (Math.floor(now / (1000 / 120) + 1e-9) + 1) * (1000 / 120); },
      task: async () => {},
      step: async () => {
        const started = now, start = Math.max(now + 0.2, gpuFree), done = start + 7;
        gpuFree = done; now = Math.max(now + 0.2, prevDone); prevDone = done; stepAt.push(now);
        return { started, submitted: now, done: Promise.resolve(done), yielded: true };
      },
    };
    await runPhysics(h, new Pacer());
    expect(measure(stepAt, now, []).speed).toBeCloseTo(2, 1); // 14 / 7
  });

  it('runs no step while inactive, and owes nothing for the time idle', async () => {
    let now = 0, ran = 0, active = false;
    const at: number[] = [];
    const h: PhysicsHooks = {
      now: () => now, alive: () => now < 3000, active: () => active, dtMs: () => DT_MS, options: () => ({ budgetMs: 14 }),
      idle: async () => { now += DT_MS; if (now >= 1000) active = true; },
      task: async () => {},
      step: async () => { ran++; at.push(now); return { started: now, submitted: now, yielded: false }; },
    };
    await runPhysics(h, new Pacer());
    expect(at[0]).toBeGreaterThanOrEqual(1000);
    // A second's idle is not owed: no burst of steps at the start.
    expect(at.filter((t) => t < 1000 + 2 * DT_MS).length).toBeLessThanOrEqual(3);
    expect(ran).toBeGreaterThan(110);
    expect(ran).toBeLessThan(125);
  });
});

describe('wakeable (P4: a fire wakes the idle physics loop)', () => {
  /** A frame clock the test advances by hand. */
  function frames() {
    const waiting: Array<() => void> = [];
    return { next: () => new Promise<void>((r) => { waiting.push(r); }), tick: () => { for (const r of waiting.splice(0)) r(); } };
  }
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));

  it('wait() ends at the next frame, or at a kick, whichever comes first; a kick with nobody waiting does nothing', async () => {
    const f = frames(), w = wakeable(f.next);
    w.kick();
    let done = false;
    void w.wait().then(() => { done = true; });
    expect(w.waiting).toBe(true);
    await flush();
    expect(done).toBe(false);
    w.kick();
    await flush();
    expect(done).toBe(true);
    expect(w.waiting).toBe(false);
    // The frame that comes later ends nothing new.
    f.tick();
    let second = false;
    void w.wait().then(() => { second = true; });
    f.tick();
    await flush();
    expect(second).toBe(true);
  });

  it("a shot's first step is submitted at the fire, with no frame passing", async () => {
    const f = frames(), w = wakeable(f.next);
    let active = false, alive = true, now = 0;
    const steps: number[] = [];
    const h: PhysicsHooks = {
      now: () => now,
      alive: () => alive,
      active: () => active,
      dtMs: () => DT_MS,
      options: () => ({}),
      idle: w.wait,
      task: async () => {},
      step: async (): Promise<StepRun> => {
        steps.push(now);
        alive = false; // one step is enough
        return { started: now, submitted: now, yielded: true };
      },
    };
    const loop = runPhysics(h, new Pacer());
    await flush();
    expect(w.waiting).toBe(true);
    expect(steps).toEqual([]);
    // The click: the shot starts and kicks the loop; no frame is ticked.
    now = 3;
    active = true;
    w.kick();
    await loop;
    expect(steps).toEqual([3]);
  });
});

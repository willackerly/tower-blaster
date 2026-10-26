// Fixed-step scheduling. Physics runs at the scene's dt, and a slow engine
// degrades into slow motion instead of a death spiral. Two schedules:
// - stepsDue, for loop=frame: each frame takes the steps that real time owes,
//   capped (default one step: when a step costs more than a frame, a second
//   step in the same frame doubles that frame without making the simulation
//   any faster).
// - stepDue/stepped, for loop=free (the default): physics runs in its own loop,
//   back to back while steps are due and never ahead of real time, while the
//   render loop draws every frame, interpolating between the two newest
//   snapshots by when they arrived (alphaAt). A CPU engine steps on the main
//   thread, so there frames run between steps, at most one per step.

/**
 * acc: owed real time (s, loop=frame). simSpeed: sim time per real time,
 * capped at 1, from sim and real, sums of each frame's sim and real time
 * (s) that decay with a time constant of SIM_SPEED_TAU of real time.
 */
export interface StepClock { acc: number; simSpeed: number; sim: number; real: number }

/** Seconds of real time the sim speed reading averages over. */
export const SIM_SPEED_TAU = 0.5;

/** A clock as if it had always run at real time. */
export function newClock(): StepClock {
  return { acc: 0, simSpeed: 1, sim: SIM_SPEED_TAU, real: SIM_SPEED_TAU };
}

/** Most steps a frame may take (the viewer's maxSteps URL option). */
export const MAX_STEPS_LIMIT = 4;

/** Steps to run this frame; mutates the clock. frameMs is real time since the last frame. */
export function stepsDue(c: StepClock, frameMs: number, dt: number, maxSteps = 1): number {
  const frame = Math.min(frameMs / 1000, 0.25);
  c.acc += frame;
  let n = Math.floor(c.acc / dt + 1e-9);
  if (n > maxSteps) {
    n = maxSteps;
    // Drop the owed time (slow motion, not catch-up), but keep just under one step, so the
    // renderer's alpha = acc / dt stays near 1 and draws the newest pose instead of the one before.
    c.acc = dt * (1 - 1e-6);
  } else {
    c.acc -= n * dt;
  }
  trackSimSpeed(c, n, frameMs, dt);
  return n;
}

/** A free-running physics loop's clock: the wall time (ms) the next step is due; NaN before the first. */
export interface Pacer { next: number }

export function newPacer(): Pacer {
  return { next: NaN };
}

/**
 * A wake-up this fraction of a step early still counts as due, so a frame
 * that fires slightly before the step's time does not skip it.
 */
export const PACE_SLACK = 0.25;

/**
 * Owed time the free loop keeps, ms; beyond it the rest is dropped (slow
 * motion). Enough for a fast engine on a 30 Hz display (2 steps a frame) and
 * a short stall, without a long burst of catch-up steps after one.
 */
export const FREE_MAX_LAG_MS = 50;

/** Whether a step is due at now (ms), with dtMs the scene's dt in ms. Drops owed time beyond maxLagMs. */
export function stepDue(p: Pacer, now: number, dtMs: number, maxLagMs = FREE_MAX_LAG_MS): boolean {
  if (Number.isNaN(p.next)) p.next = now;
  if (now < p.next - PACE_SLACK * dtMs) return false;
  if (now - p.next > maxLagMs) p.next = now - maxLagMs;
  return true;
}

/** Record a step taken: the next one is due one dt later. */
export function stepped(p: Pacer, dtMs: number): void {
  p.next += dtMs;
}

/** When the newest snapshot arrived and the usual time between snapshots (EMA), ms. */
export interface Arrivals { last: number; interval: number }

export function newArrivals(): Arrivals {
  return { last: NaN, interval: NaN };
}

/**
 * Record a snapshot arriving at now (ms). A gap counts as at most the larger
 * of 8 steps and twice the usual interval: one stall barely moves the
 * interval, while an engine that takes longer than 8 steps every step still
 * reaches its own interval (each sample can raise it by a fifth).
 */
export function arrived(a: Arrivals, now: number, dtMs: number): void {
  if (!Number.isNaN(a.last)) {
    const gap = Math.min(now - a.last, Math.max(8 * dtMs, Number.isNaN(a.interval) ? 0 : 2 * a.interval));
    a.interval = Number.isNaN(a.interval) ? gap : 0.8 * a.interval + 0.2 * gap;
  }
  a.last = now;
}

/**
 * The renderer's alpha for a frame at now: 0 draws the snapshot before the
 * newest, 1 the newest. It ramps over the usual time between snapshots (at
 * least one dt), so motion stays smooth when steps and frames run at different
 * rates; the price is drawing up to one snapshot interval behind.
 *
 * Why arrival time and not sim time (each snapshot stamped with the time its
 * step was due, drawn at now minus a fixed delay): sim time is the exact
 * cadence while physics keeps up, but in slow motion snapshots arrive slower
 * than their stamps advance, so a fixed delay runs out of snapshots and the
 * pose stalls and jumps. Arrival time stretches with the engine.
 */
export function alphaAt(a: Arrivals, now: number, dtMs: number): number {
  if (Number.isNaN(a.last)) return 1;
  const span = Math.max(dtMs, Number.isNaN(a.interval) ? dtMs : a.interval);
  return Math.min(1, Math.max(0, (now - a.last) / span));
}

/**
 * Fold a frame of frameMs real time (counted up to 0.25 s), in which `steps`
 * steps of dt seconds completed, into the sim speed. Only the ratio is
 * capped, so a 120 Hz display that sees 0 and 2 steps a frame still reads 100%.
 */
export function trackSimSpeed(c: StepClock, steps: number, frameMs: number, dt: number): void {
  const frame = Math.min(frameMs / 1000, 0.25);
  if (!(frame > 0)) return;
  const keep = Math.exp(-frame / SIM_SPEED_TAU);
  c.sim = keep * c.sim + steps * dt;
  c.real = keep * c.real + frame;
  c.simSpeed = Math.min(1, c.sim / c.real);
}

/** What the free physics loop needs from the page (main.ts); tests drive it with fakes. */
export interface FreeHooks {
  /** False ends the loop. */
  running(): boolean;
  /** No steps (paused, or a hidden tab); both clocks restart when it ends. */
  paused(): boolean;
  /** Wall clock, ms. */
  now(): number;
  /** The scene's dt in ms (a reset can change it). */
  dtMs(): number;
  /** Run a reset if one was asked for (here, because this loop owns the engine); resolves whether it did. */
  resetIfAsked(): Promise<boolean>;
  /** One step: submit it, wait until it has run, and record its time. */
  step(): Promise<void>;
  /** Read the new state back for the renderer. */
  refresh(): Promise<void>;
  /** True when step() and refresh() wait on the GPU, which hands control back to the event loop. */
  yields(): boolean;
  nextFrame(): Promise<void>;
  /** A task boundary (see taskYield). */
  nextTask(): Promise<void>;
}

/**
 * loop=free: step back to back while stepDue says a step is due, else wait for
 * the next frame. Each snapshot's arrival is recorded for alphaAt. Engines
 * that step synchronously on this thread (the CPU engines) get a task boundary
 * after every step: without it a run of due steps never leaves the microtask
 * queue, and no frame or input event would get a turn.
 *
 * Until a whole dt has passed since the loop woke, it asks whether a step is
 * due at the wake time, not now. Asking at now would count the time the
 * frame's own step took as owed: a frame waking a little after its step's time
 * then takes a second step, the next frame finds none due, and a display
 * slightly slower than 60 Hz (59.94) locks into 0, 2, 0, 2 steps a frame.
 * Once a dt has passed the engine is behind, and now is the right time to ask.
 */
export async function runFree(h: FreeHooks, pacer: Pacer, arrivals: Arrivals): Promise<void> {
  const restart = () => {
    Object.assign(pacer, newPacer());
    Object.assign(arrivals, newArrivals());
  };
  let wake = h.now();
  while (h.running()) {
    if (await h.resetIfAsked()) {
      restart();
      continue;
    }
    if (h.paused()) {
      // Owed time from before the pause is not owed: resume with one step, not a burst.
      restart();
      await h.nextFrame();
      wake = h.now();
      continue;
    }
    const now = h.now(), dtMs = h.dtMs();
    if (!stepDue(pacer, now - wake < dtMs ? wake : now, dtMs)) {
      await h.nextFrame();
      wake = h.now();
      continue;
    }
    await h.step();
    stepped(pacer, h.dtMs());
    await h.refresh();
    arrived(arrivals, h.now(), h.dtMs());
    if (!h.yields()) await h.nextTask();
  }
}

/**
 * A zero-delay task boundary through a MessageChannel. setTimeout(0) would do,
 * but nested timers are clamped to 4 ms.
 */
export function taskYield(): { next(): Promise<void>; close(): void } {
  const channel = new MessageChannel();
  const waiting: Array<() => void> = [];
  channel.port1.onmessage = () => waiting.shift()?.();
  return {
    next: () => new Promise<void>((resolve) => { waiting.push(resolve); channel.port2.postMessage(null); }),
    close: () => { channel.port1.close(); channel.port2.close(); },
  };
}

/** Rolling window of step times for the HUD. */
export class Window {
  private xs: number[] = [];
  constructor(private readonly size = 120) {}
  push(x: number) {
    this.xs.push(x);
    if (this.xs.length > this.size) this.xs.shift();
  }
  quantile(q: number): number {
    if (!this.xs.length) return NaN;
    const s = [...this.xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
}

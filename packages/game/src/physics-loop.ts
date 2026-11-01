// The game's physics loop, apart from its frames (spectacle-mode.md, section
// 9, the valve). Until G4 the game ran each frame's steps inside the frame and
// awaited them before drawing, so a 10k step of 18 ms made frames alternate
// between about 25 and 8 ms on a 120 Hz display, and the valve could only
// trade that unevenness for fewer steps. Here physics steps whenever the
// Pacer says a step is due and the frames draw on their own, interpolating
// between the two newest snapshots by when they arrived (arrivals.ts), as the
// viewer's loop=free does (viewer loop.ts runFree): a slow step slows sim time
// (declared slow motion) and never holds a frame. It changes when steps run,
// never which steps run, so sessions replay exactly as before.
import { Window } from '@tb/metrics';
import { Pacer, type PacerOptions, stepCost } from './pacing.ts';

/** One step the loop ran: when it was submitted, and when it was done (a promise on engines that submit and return). */
export interface StepRun {
  /** Wall ms after the step was submitted (step() returned). */
  submitted: number;
  /** Wall ms the step finished: a GPU engine's finish(); absent, the step ran in step() and `submitted - started` is its cost. */
  done?: Promise<number>;
  /** Wall ms just before the step started. */
  started: number;
  /** Whether waiting on the step handed control back to the event loop (a GPU engine): if not, the loop yields a task. */
  yielded: boolean;
}

/** What the loop needs from the page (play.ts); tests drive it with a fake clock and engine. */
export interface PhysicsHooks {
  now(): number;
  /** False ends the loop. */
  alive(): boolean;
  /** A shot is running and nothing else (a level load) holds the engine: steps may run. */
  active(): boolean;
  dtMs(): number;
  /** Fast-forward (Space, the round is over, the tail skip) and the budget; the step cost comes from the loop. */
  options(): Omit<PacerOptions, 'stepMs'>;
  /** Run one step (feedback, hooks, renderer update included); null when it did not run (the shot ended meanwhile). */
  step(): Promise<StepRun | null>;
  /** Wait for the next frame (nothing due, or idle). */
  idle(): Promise<void>;
  /** A task boundary, so a CPU engine stepping on this thread lets frames and input run. */
  task(): Promise<void>;
}

/** Step costs the valve reads: the median of the last 60 (the old frame loop's window). */
export const COST_WINDOW = 60;

/**
 * Runs until hooks.alive() is false. The valve reads the median cost of the last COST_WINDOW steps:
 * for an engine that submits and returns (the GPU), from when the step could start to its done
 * (stepCost), its true cost whether or not it queued behind the one before; otherwise the wall
 * time of step(). Each cost is passed to `cost` as it lands.
 */
export async function runPhysics(h: PhysicsHooks, pacer: Pacer, costs = new Window(COST_WINDOW), cost?: (ms: number) => void): Promise<void> {
  let active = false, lastDone = -Infinity;
  const record = (ms: number) => { costs.push(ms); cost?.(ms); };
  while (h.alive()) {
    if (!h.active()) {
      active = false;
      await h.idle();
      continue;
    }
    // A shot starts (or a load ended): nothing is owed from before.
    if (!active) { pacer.restart(); active = true; }
    const dtMs = h.dtMs();
    if (!pacer.due(h.now(), dtMs, { ...h.options(), stepMs: costs.quantile(0.5) })) {
      await h.idle();
      continue;
    }
    const r = await h.step();
    if (!r) continue;
    pacer.stepped(dtMs);
    if (r.done) {
      void r.done.then((t) => { record(stepCost(r.submitted, t, lastDone)); lastDone = t; }, () => {});
    } else {
      record(r.submitted - r.started);
    }
    if (!r.yielded) await h.task();
  }
}

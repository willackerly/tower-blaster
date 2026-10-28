// Runs a Session against any PhysicsEngine: step, observe, feed the rules,
// push the spawns they produce. The interactive game and the headless tools
// share this loop, so a recorded session replays through the same code.
import type { InputEvent, PhysicsEngine, Snapshot } from '@tb/engine-api';
import type { CompiledLevel } from './level.ts';
import { CpuObserver } from './rules.ts';
import { type Feedback, Session } from './session.ts';
import type { Shot } from './shots.ts';

/**
 * Steps run after init before play starts. New AVBD contacts hold nothing for
 * their first few steps, so stacks drop up to 41 mm (L2, 20 iterations) and
 * spring back with a time constant of about 45 steps; by 300 under 0.1 mm is
 * left to recover. Rapier is quiet and asleep by step 48, so the extra steps
 * change nothing there. A test holds both engines still afterwards.
 */
export const PRESETTLE_STEPS = 300;

/**
 * The AVBD settings Keystone plays and pins par lines at, on the reference
 * and the GPU engine alike. Measured 2026-10-27 on first par shots re-rolled
 * from starts 1e-6 m apart (f64 reference): a shot must settle before
 * SETTLE_CAP. At 20 iterations L1's settled in 1 of 8 runs, columns still
 * converging; at 30 with the slop L5 and L2 each capped once; only 40 with
 * the slop kept all 30 L1, L2 and L5 runs under the cap (median 300 to 452
 * steps), with no quiet faked by position corrections. The slop (3e-5 m, a
 * loaded contact's gap the main iterations do not count) stops the
 * post-stabilization pump that kept stacks rocking: late structure speed
 * falls from 1.3e-2 to 6.8e-4 m/s on L5.
 */
export const AVBD_ITERATIONS = 40;
export const AVBD_GAP_SLOP = 3e-5;

export interface DriverOptions {
  /**
   * Pipelined read-back: step n+1 is submitted before step n's snapshot is
   * awaited, so a GPU engine solves while the bodies come back (step() only
   * submits there). The rules see step n while the engine is at n+1, and a
   * shot the rules end at step n leaves the world at step n+1. The observed
   * steps are the same, so a one-shot session ends with the same score one
   * step later; later shots start one step later, so a session replays
   * exactly only on a driver with the same option.
   */
  pipelined?: boolean;
}

export class Driver {
  session!: Session;
  /** The newest observed state; while aiming, the world as it stands. */
  snapshot!: Snapshot;
  /**
   * How many engine steps `snapshot` holds. Serial, the engine's stepIndex; pipelined while
   * running, one less: the step after the snapshot is already submitted. An event applies at the
   * first step() whose stepIndex is at least event.step, so input pushed after seeing a snapshot
   * and stamped snapshotStep + 1 applies at the same step on either driver (stamped
   * engine.stepIndex it would not: one step later pipelined). keystone-lab driver-step.test.ts.
   */
  snapshotStep = 0;
  /** Every event pushed besides the shots' spawns (push), in push order. */
  readonly pushed: InputEvent[] = [];
  private observer!: CpuObserver;
  /** Pipelined only: the snapshot of the newest submitted step, not observed yet. */
  private ahead: Promise<Snapshot> | null = null;
  /** The engine step of every spawn pushed so far, shots' and others', to number the next shot's body. */
  private spawnSteps: number[] = [];

  constructor(readonly engine: PhysicsEngine, readonly level: CompiledLevel, readonly options: DriverOptions = {}) {}

  /**
   * Init the engine and let the structure settle before play: real engines
   * compress loaded stacks a little (Rapier: 2 to 4 mm per contact), so the
   * settled pose, not the authored one, is the home and the first baseline.
   */
  async reset(): Promise<void> {
    await this.engine.init(this.level.scene);
    for (let i = 0; i < PRESETTLE_STEPS; i++) await this.engine.step();
    this.snapshot = await this.engine.snapshot();
    this.snapshotStep = this.engine.stepIndex;
    this.session = new Session(this.level, this.snapshot.pos);
    this.observer = new CpuObserver(this.level, this.snapshot);
  }

  /** Fire now: the spawn applies at the next step. */
  fire(shot: Shot): Feedback[] {
    const step = this.engine.stepIndex;
    // Engines number spawns by (step, push order); every spawn pushed before is due by now or later
    // than this one (push's stamping rule), so the ammo comes after exactly those due by now.
    const { spawn, feedback } = this.session.fire(shot, step, this.level.meta.n + this.spawnSteps.filter((s) => s <= step).length);
    this.spawnSteps.push(step);
    this.observer.setBaseline(this.snapshot, step);
    this.engine.push([spawn]);
    return feedback;
  }

  /**
   * Push input decided from the observed state (a per-step hook: PlayOptions.perStep). Each
   * event must be due after the step observed (event.step > snapshotStep, so snapshotStep + 1 at
   * the soonest), which lands it at the same engine step on a serial and a pipelined driver.
   * A spawn becomes a body after the bodies due before it, so a later shot's ammo is numbered past it.
   */
  push(events: InputEvent[]): void {
    for (const e of events) if (e.step <= this.snapshotStep) throw new Error(`Driver.push: an event for step ${e.step} is not after the observed step ${this.snapshotStep}; stamp it snapshotStep + 1 or later`);
    for (const e of events) if (e.kind === 'spawn') this.spawnSteps.push(e.step);
    this.pushed.push(...events);
    this.engine.push(events);
  }

  async step(): Promise<Feedback[]> {
    if (!this.options.pipelined) {
      await this.engine.step();
      this.snapshot = await this.engine.snapshot();
      this.snapshotStep = this.engine.stepIndex;
      return this.session.observe(this.observer.observe(this.snapshot, this.engine.stepIndex, this.session.watchIdx));
    }
    if (!this.ahead) {
      await this.engine.step();
      this.ahead = this.read();
    }
    // snapshot() queues its copy when called, so it holds exactly the steps before it.
    const n = this.engine.stepIndex;
    await this.engine.step();
    this.snapshot = await this.ahead;
    this.snapshotStep = n;
    this.ahead = this.read();
    const feedback = this.session.observe(this.observer.observe(this.snapshot, n, this.session.watchIdx));
    if (this.session.phase !== 'running') await this.drain();
    return feedback;
  }

  /** A read that may be dropped (a level load disposes the engine under it) without an unhandled rejection. */
  private read(): Promise<Snapshot> {
    const p = Promise.resolve(this.engine.snapshot());
    p.catch(() => {});
    return p;
  }

  /** Pipelined: take the snapshot of the step past the last observed one, so `snapshot` is the world as it stands. */
  async drain(): Promise<void> {
    const ahead = this.ahead;
    this.ahead = null;
    if (ahead) {
      this.snapshot = await ahead;
      this.snapshotStep = this.engine.stepIndex;
    }
  }
}

export interface SessionResult { session: Session; feedback: Feedback[]; steps: number; snapshot: Snapshot }

/**
 * Plays `shots` in order, each fired as soon as the session is aiming, until
 * the level ends, the shots run out, or `maxSteps`.
 */
export async function runSession(engine: PhysicsEngine, level: CompiledLevel, shots: Shot[], opts: PlayOptions & DriverOptions = {}): Promise<SessionResult> {
  const d = new Driver(engine, level, { pipelined: opts.pipelined });
  await d.reset();
  return playShots(d, shots, 0, opts);
}

export interface PlayOptions {
  /** Stop once the engine reaches this step (default 20,000). */
  maxSteps?: number;
  /** Called while aiming before each later shot `next` fires: the driver may be copied there and played on. */
  onAiming?(d: Driver, next: number): void;
  /**
   * Called after every driver step with the driver as it stands (d.snapshot is of step
   * d.snapshotStep); the events it returns are pushed (Driver.push: each due after that step). The
   * weapons runtime hooks here; the game page calls the same hook live, so replays see its input.
   */
  perStep?: PerStep;
}

/** A per-step hook: input decided from the observed state. One per session: it may keep state. */
export type PerStep = (d: Driver) => InputEvent[];

/**
 * Play shots[next..] from a driver that is aiming before shot `next`: the
 * rest of runSession. A driver copied at an onAiming call and played on from
 * there ends in the same session, steps and snapshot as the whole session
 * (the feedback holds this call's only).
 */
export async function playShots(d: Driver, shots: Shot[], next: number, opts: PlayOptions = {}): Promise<SessionResult> {
  const engine = d.engine, feedback: Feedback[] = [];
  const max = opts.maxSteps ?? 20_000;
  let announced = next;
  while (engine.stepIndex < max) {
    if (d.session.phase === 'aiming') {
      if (next >= shots.length) break;
      if (next > announced) opts.onAiming?.(d, (announced = next));
      feedback.push(...d.fire(shots[next++]!));
    }
    if (d.session.phase === 'cleared' || d.session.phase === 'failed') break;
    feedback.push(...(await d.step()));
    const input = opts.perStep?.(d);
    if (input?.length) d.push(input);
  }
  await d.drain();
  return { session: d.session, feedback, steps: engine.stepIndex, snapshot: d.snapshot };
}

/** FNV-1a over the raw bytes of positions and rotations: equal states hash equal. */
export function snapshotHash(s: Snapshot): string {
  let h = 0x811c9dc5;
  for (const a of [s.pos, s.rot]) {
    const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    for (let i = 0; i < b.length; i++) h = Math.imul(h ^ b[i]!, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

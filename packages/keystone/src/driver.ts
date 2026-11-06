// Runs a Session against any PhysicsEngine: step, observe, feed the rules,
// push the spawns they produce. The interactive game and the headless tools
// share this loop, so a recorded session replays through the same code.
import { type BodyDesc, type EngineCheckpoint, type InputEvent, type PhysicsEngine, type Snapshot, type SpawnEvent, spawnedBodies } from '@tb/engine-api';
import { Arsenal } from './arsenal.ts';
import { forkDeep } from './fork.ts';
import { type CompiledLevel, physicsOf } from './level.ts';
import { CpuObserver, type Observation } from './rules.ts';
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

/**
 * A driver's whole state at one moment (Driver.checkpoint): the engine's checkpoint and a copy of
 * everything the driver keeps. restore() puts both back; it may be called again, and throws once
 * the engine has been init()ed again or disposed, or after dispose().
 */
export interface DriverCheckpoint {
  /** The engine's stepIndex when it was taken. */
  readonly step: number;
  /** Memory held, bytes: the engine checkpoint's and an estimate of the copied driver state. */
  readonly bytes: number;
  restore(): void;
  dispose(): void;
}

/** What a driver keeps besides its engine and level (Driver.checkpoint copies it as one graph, so shared events stay shared). */
interface DriverState {
  session: Session; snapshot: Snapshot; snapshotStep: number; observed: Observation | null; pushed: InputEvent[];
  observer: CpuObserver; spawnSteps: number[]; spawns: InputEvent[]; descs: BodyDesc[]; arsenal: Arsenal;
  blastsDue: Extract<Feedback, { t: 'blast' }>[];
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
  /** The rules' view of `snapshot` (null before the first step after reset): its reductions (nMoving, movingBox) feed pacing and the camera. */
  observed: Observation | null = null;
  /** Every event pushed besides the shots' spawns (push), in push order. */
  readonly pushed: InputEvent[] = [];
  private observer!: CpuObserver;
  /** Pipelined only: the snapshot of the newest submitted step, not observed yet. */
  private ahead: Promise<Snapshot> | null = null;
  /** The engine step of every spawn pushed so far, shots' and others', to number the next shot's body. */
  private spawnSteps: number[] = [];
  /** Every spawn so far in the order the engine numbers them (by step, then push order), for the bodies list. */
  private spawns: InputEvent[] = [];
  /** The structure then every spawned body, by engine id. */
  private descs: BodyDesc[] = [];
  /** The fired weapons' fuses (w- items), one per session. */
  private arsenal!: Arsenal;
  /** Blasts pushed whose 'blast' feedback waits for the first state that shows them. */
  private blastsDue: Extract<Feedback, { t: 'blast' }>[] = [];

  constructor(readonly engine: PhysicsEngine, readonly level: CompiledLevel, readonly options: DriverOptions = {}) {}

  /**
   * Init the engine and let the structure settle before play: real engines
   * compress loaded stacks a little (Rapier: 2 to 4 mm per contact), so the
   * settled pose, not the authored one, is the home and the first baseline.
   */
  async reset(): Promise<void> {
    await this.engine.init(this.level.scene);
    // PRESETTLE_STEPS unless the level's physics block sets its own.
    const presettle = physicsOf(this.level.def).presettle;
    for (let i = 0; i < presettle; i++) await this.engine.step();
    this.snapshot = await this.engine.snapshot();
    this.snapshotStep = this.engine.stepIndex;
    this.session = new Session(this.level, this.snapshot.pos);
    this.observer = new CpuObserver(this.level, this.snapshot);
    this.spawns = [];
    this.descs = [...this.level.scene.bodies];
    this.arsenal = new Arsenal(this.level, this.engine.info.integrator?.substeps ?? 1);
    this.blastsDue = [];
    this.observed = null;
  }

  /**
   * The session as it stands, to come back to (the game's undo takes one as each shot goes in), or
   * null when the engine has no checkpoint() (PhysicsEngine.checkpoint). Taken between steps, after
   * reset(). It holds the engine's checkpoint and a deep copy (forkDeep) of the rules' session, the
   * observer, the weapons' fuses, the spawns and the observed snapshot. A pipelined driver's read
   * of the step past the observed one is not copied: restore() asks the restored engine for it again,
   * and gets the same state, since the engine is back at that step.
   */
  checkpoint(): DriverCheckpoint | null {
    const engine = this.engine.checkpoint?.();
    if (!engine) return null;
    const own = (): DriverState => ({
      session: this.session, snapshot: this.snapshot, snapshotStep: this.snapshotStep, observed: this.observed, pushed: this.pushed,
      observer: this.observer, spawnSteps: this.spawnSteps, spawns: this.spawns, descs: this.descs, arsenal: this.arsenal, blastsDue: this.blastsDue,
    });
    // The compiled level and its bodies are immutable inputs: shared, not copied.
    const shared = [this.level, ...this.level.scene.bodies];
    let saved: DriverState | null;
    try {
      saved = forkDeep(own(), shared);
    } catch (e) {
      engine.dispose();
      throw e;
    }
    const ahead = this.ahead !== null;
    const s = this.snapshot;
    // The snapshot is copied about three times over (it, the observer's baseline and last state); the rest is small.
    const bytes = engine.bytes + 3 * (s.pos.byteLength + s.rot.byteLength + s.linVel.byteLength + s.angVel.byteLength + s.awake.byteLength) + 64 * (this.spawns.length + this.pushed.length) + 4096;
    return {
      step: engine.step, bytes,
      restore: () => {
        if (!saved) throw new Error('Driver: restore() of a disposed checkpoint');
        engine.restore();
        const c = forkDeep(saved, shared);
        this.session = c.session;
        this.snapshot = c.snapshot;
        this.snapshotStep = c.snapshotStep;
        this.observed = c.observed;
        this.pushed.length = 0;
        this.pushed.push(...c.pushed);
        this.observer = c.observer;
        this.spawnSteps = c.spawnSteps;
        this.spawns = c.spawns;
        this.descs = c.descs;
        this.arsenal = c.arsenal;
        this.blastsDue = c.blastsDue;
        this.ahead = ahead ? this.read() : null;
      },
      dispose: () => { saved = null; engine.dispose(); },
    };
  }

  /** Notes spawns in the engine's numbering order: by step, after those due at the same step. */
  private noteSpawns(events: readonly InputEvent[]): void {
    let added = false;
    for (const e of events) {
      if (e.kind !== 'spawn') continue;
      let i = this.spawns.length;
      while (i > 0 && this.spawns[i - 1]!.step > e.step) i--;
      this.spawns.splice(i, 0, e);
      added = true;
    }
    if (added) this.descs = [...this.level.scene.bodies, ...spawnedBodies(this.spawns)];
  }

  /** Every body by engine id: the structure, then each spawn (the shots', a weapon's children) in the order the engine applies them. */
  get bodies(): readonly BodyDesc[] {
    return this.descs;
  }

  /** The engine id of a spawn pushed through this driver (the same event object). */
  private idOf(spawn: SpawnEvent): number {
    const i = this.spawns.indexOf(spawn);
    if (i < 0) throw new Error(`Driver: a spawn due at step ${spawn.step} was not pushed through this driver`);
    return this.level.meta.n + i;
  }

  /**
   * Fire now: the spawn applies at the next step. While a shot runs (rapid fire) it is cut on the
   * state observed last (`snapshot`), which is also the new shot's baseline.
   */
  fire(shot: Shot): Feedback[] {
    const step = this.engine.stepIndex;
    // Engines number spawns by (step, push order); every spawn pushed before is due by now or later
    // than this one (push's stamping rule), so the ammo comes after exactly those due by now.
    const body = this.level.meta.n + this.spawnSteps.filter((s) => s <= step).length;
    const now = this.session.phase === 'running' ? this.observer.peek(this.snapshot, this.snapshotStep, this.session.watchIdx) : undefined;
    const { spawn, event, feedback } = this.session.fire(shot, step, body, now);
    this.observer.setBaseline(this.snapshot, step);
    if (!spawn) {
      // A pull: one removal, nothing spawned, so later ammo is numbered as if it were not there.
      this.engine.push([event]);
      return feedback;
    }
    this.spawnSteps.push(step);
    this.noteSpawns([spawn]);
    // A weapon's fuse starts with its spawn: what it knows at launch (a timer's blast) goes in with it.
    const armed = this.arsenal.launch(shot.ammo, body, step, spawn.body.shape);
    this.pushed.push(...armed);
    this.engine.push([spawn, ...armed]);
    this.blastsDue.push(...blasts(armed));
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
    this.noteSpawns(events);
    this.pushed.push(...events);
    this.engine.push(events);
  }

  /** Pushes the fired weapons' input from the state just observed (due after it); whether one is still to go off. */
  private arm(feedback: Feedback[]): boolean {
    const input = this.arsenal.observe(this.snapshot, this.snapshotStep, this.descs, (sp) => this.idOf(sp));
    if (input.length) {
      this.push(input);
      this.blastsDue.push(...blasts(input));
    }
    // A blast shows in the first state after the step it is due at (the engine applies it stepping from there).
    const shown = this.blastsDue.filter((b) => b.step < this.snapshotStep);
    if (shown.length) {
      feedback.push(...shown);
      this.blastsDue = this.blastsDue.filter((b) => b.step >= this.snapshotStep);
    }
    return this.arsenal.pending(this.snapshotStep);
  }

  /** End an outcome level now (Session.bank): the world is frozen while aiming, so the step is the observed one. */
  bank(): Feedback[] {
    return this.session.bank(this.snapshotStep);
  }

  async step(): Promise<Feedback[]> {
    if (!this.options.pipelined) {
      await this.engine.step();
      this.snapshot = await this.engine.snapshot();
      this.snapshotStep = this.engine.stepIndex;
      const out: Feedback[] = [], hold = this.arm(out);
      this.observed = this.observer.observe(this.snapshot, this.engine.stepIndex, this.session.watchIdx);
      return [...out, ...this.session.observe(this.observed, hold)];
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
    const out: Feedback[] = [], hold = this.arm(out);
    this.observed = this.observer.observe(this.snapshot, n, this.session.watchIdx);
    const feedback = [...out, ...this.session.observe(this.observed, hold)];
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

/** A 'blast' feedback for each blast among `events`. */
function blasts(events: readonly InputEvent[]): Extract<Feedback, { t: 'blast' }>[] {
  return events.flatMap((e) => (e.kind === 'blast' ? [{ t: 'blast' as const, step: e.step, body: typeof e.blast.centre === 'object' && 'body' in e.blast.centre ? e.blast.centre.body : -1, radius: e.blast.radius }] : []));
}

export interface SessionResult { session: Session; feedback: Feedback[]; steps: number; snapshot: Snapshot }

/**
 * Plays `shots` in order, each fired as soon as the session is aiming (or, for a rapid-fire shot
 * with `after`, that many steps after the shot before it went in, if that comes first), until the
 * level ends, the shots run out, or `maxSteps`.
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
  /**
   * An outcome level still open when the shots run out is banked there (default true): a recorded
   * session is (level, shots) and ends after its last shot. false leaves it aiming (a bot sampling each settle).
   */
  bank?: boolean;
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
      if (next >= shots.length) {
        if (opts.bank !== false && d.session.canBank()) feedback.push(...d.bank());
        break;
      }
      if (next > announced) opts.onAiming?.(d, (announced = next));
      feedback.push(...d.fire(shots[next++]!));
    }
    // Rapid-fire shots due now go in before the next step, as the game page fires them between steps.
    while (next < shots.length && d.session.phase === 'running' && rapidDue(d, shots[next]!)) feedback.push(...d.fire(shots[next++]!));
    if (d.session.phase === 'cleared' || d.session.phase === 'failed') break;
    feedback.push(...(await d.step()));
    const input = opts.perStep?.(d);
    if (input?.length) d.push(input);
  }
  await d.drain();
  return { session: d.session, feedback, steps: engine.stepIndex, snapshot: d.snapshot };
}

/**
 * Whether rapid-fire shot `shot` (with `after`) is due on `d` now: that many steps after the last shot
 * went in, with a freeze left to spend (Session.freezesLeft). Without one it waits for the settle
 * and goes in from aiming, as a shot without `after` does.
 */
export function rapidDue(d: Driver, shot: Shot): boolean {
  const last = d.session.inputs[d.session.inputs.length - 1];
  return shot.after !== undefined && last !== undefined && d.engine.stepIndex >= last.step + shot.after && d.session.freezesLeft > 0;
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

// Runs a Session against any PhysicsEngine: step, observe, feed the rules,
// push the spawns they produce. The interactive game and the headless tools
// share this loop, so a recorded session replays through the same code.
import type { PhysicsEngine, Snapshot } from '@tb/engine-api';
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

export class Driver {
  session!: Session;
  snapshot!: Snapshot;
  private observer!: CpuObserver;

  constructor(readonly engine: PhysicsEngine, readonly level: CompiledLevel) {}

  /**
   * Init the engine and let the structure settle before play: real engines
   * compress loaded stacks a little (Rapier: 2 to 4 mm per contact), so the
   * settled pose, not the authored one, is the home and the first baseline.
   */
  async reset(): Promise<void> {
    await this.engine.init(this.level.scene);
    for (let i = 0; i < PRESETTLE_STEPS; i++) await this.engine.step();
    this.snapshot = await this.engine.snapshot();
    this.session = new Session(this.level, this.snapshot.pos);
    this.observer = new CpuObserver(this.level, this.snapshot);
  }

  /** Fire now: the spawn applies at the next step. */
  fire(shot: Shot): Feedback[] {
    const { spawn, feedback } = this.session.fire(shot, this.engine.stepIndex);
    this.observer.setBaseline(this.snapshot, this.engine.stepIndex);
    this.engine.push([spawn]);
    return feedback;
  }

  async step(): Promise<Feedback[]> {
    await this.engine.step();
    this.snapshot = await this.engine.snapshot();
    return this.session.observe(this.observer.observe(this.snapshot, this.engine.stepIndex, this.session.watchIdx));
  }
}

export interface SessionResult { session: Session; feedback: Feedback[]; steps: number; snapshot: Snapshot }

/**
 * Plays `shots` in order, each fired as soon as the session is aiming, until
 * the level ends, the shots run out, or `maxSteps`.
 */
export async function runSession(engine: PhysicsEngine, level: CompiledLevel, shots: Shot[], opts: PlayOptions = {}): Promise<SessionResult> {
  const d = new Driver(engine, level);
  await d.reset();
  return playShots(d, shots, 0, opts);
}

export interface PlayOptions {
  /** Stop once the engine reaches this step (default 20,000). */
  maxSteps?: number;
  /** Called while aiming before each later shot `next` fires: the driver may be copied there and played on. */
  onAiming?(d: Driver, next: number): void;
}

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
  }
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

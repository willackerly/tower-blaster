// Runs a Session against any PhysicsEngine: step, observe, feed the rules,
// push the spawns they produce. The interactive game and the headless tools
// share this loop, so a recorded session replays through the same code.
import type { PhysicsEngine, Snapshot } from '@tb/engine-api';
import type { CompiledLevel } from './level.ts';
import { CpuObserver } from './rules.ts';
import { type Feedback, Session } from './session.ts';
import type { Shot } from './shots.ts';

/** Steps run after init before play starts. */
export const PRESETTLE_STEPS = 90;

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
export async function runSession(engine: PhysicsEngine, level: CompiledLevel, shots: Shot[], opts: { maxSteps?: number } = {}): Promise<SessionResult> {
  const d = new Driver(engine, level);
  await d.reset();
  const feedback: Feedback[] = [];
  let next = 0;
  const max = opts.maxSteps ?? 20_000;
  while (engine.stepIndex < max) {
    if (d.session.phase === 'aiming') {
      if (next >= shots.length) break;
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

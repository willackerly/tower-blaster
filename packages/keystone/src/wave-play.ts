// Playing a Wavefront level (M6, docs/game/wavefront.md) on any engine, as the
// game plays it: Driver.reset (its pre-settle), the line's shots, the session to
// its end, with the wave measured on the way. Shared by the lab (the reference
// and Rapier in Node) and the cast page (the game's engines, so the GPU in CI and
// Metal on the Mac): what it returns is what the level tests and the nudge gate
// read. Clock-free.
import { limitProblems, type PhysicsEngine } from '@tb/engine-api';
import type { CompiledLevel } from './level.ts';
import { Driver, type DriverOptions, playShots, snapshotHash } from './driver.ts';
import type { Shot } from './shots.ts';

/** Every this many steps the wave meters read the snapshot (probe X1's awake sampling). */
export const WAVE_EVERY = 5;

export interface WaveResult {
  /** The session's end: cleared (par: the objective met; outcome: met at the last settle) and how it ended. */
  cleared: boolean;
  phase: string;
  crownsDown: number;
  crowns: number;
  heritageBroken: number;
  /** Steps from the first shot to the session's end. */
  steps: number;
  /** Seconds from the first shot to its settle (the run the window bounds). */
  settledSeconds: number;
  /** Awake structure bodies, sampled every WAVE_EVERY steps after the first shot: the most and the mean (the front and its tail). */
  awakeMax: number;
  awakeMean: number;
  /** Structure bodies that ever moved more than half an h from where play started. */
  displaced: number;
  /** Per group (WaveOptions.groups), the first sampled step after the first shot its centre of mass moved `fell` h (-1: never). */
  fellAt: number[];
  hash: string;
  limits: string[];
}

export interface WaveOptions extends DriverOptions {
  maxSteps?: number;
  /**
   * Body groups to time (towers of a Steer city, runs of a Lay level): body indices per group. A group has fallen
   * once its centre of mass (equal weights) moved `fell` h from where play started, along the ground or down.
   */
  groups?: number[][];
  /** Default 0.6 h: an X3 tower (8 h tall) tipped onto its neighbour moves its centre about 1.7 h; a domino (2 h) fallen flat drops 0.7 h. */
  fell?: number;
}

/** Plays `shots` on `engine` (disposed by the caller) from the level's start and meters the wave. */
export async function wavePlay(engine: PhysicsEngine, c: CompiledLevel, shots: Shot[], opts: WaveOptions = {}): Promise<WaveResult> {
  const d = new Driver(engine, c, { pipelined: opts.pipelined, refereed: opts.refereed });
  await d.reset();
  const start = engine.stepIndex, n = c.meta.n, h = c.frame.unit, groups = opts.groups ?? [], fell = (opts.fell ?? 0.6) * h;
  const home = Float64Array.from(d.snapshot.pos.subarray(0, 3 * n));
  const centre = (pos: Float64Array, g: number[]) => {
    const p = [0, 0, 0];
    for (const i of g) for (let k = 0; k < 3; k++) p[k]! += pos[3 * i + k]! / g.length;
    return p;
  };
  const c0 = groups.map((g) => centre(home, g)), fellAt = groups.map(() => -1), moved = new Uint8Array(n);
  let awakeMax = 0, awakeSum = 0, samples = 0, firstShot = -1;
  const r = await playShots(d, shots, 0, {
    maxSteps: start + (opts.maxSteps ?? 36_000),
    perStep: () => {
      if (firstShot < 0 && d.session.inputs.length) firstShot = d.session.inputs[0]!.step;
      const step = d.snapshotStep;
      if (firstShot < 0 || (step - firstShot) % WAVE_EVERY) return [];
      const s = d.snapshot;
      let awake = 0;
      for (let i = 0; i < n; i++) {
        if (s.awake[i]) awake++;
        if (!moved[i] && Math.hypot(s.pos[3 * i]! - home[3 * i]!, s.pos[3 * i + 1]! - home[3 * i + 1]!, s.pos[3 * i + 2]! - home[3 * i + 2]!) > 0.5 * h) moved[i] = 1;
      }
      awakeMax = Math.max(awakeMax, awake); awakeSum += awake; samples++;
      groups.forEach((g, k) => {
        if (fellAt[k]! >= 0) return;
        const p = centre(s.pos, g), a = c0[k]!;
        if (Math.hypot(p[0]! - a[0]!, p[2]! - a[2]!) > fell || a[1]! - p[1]! > fell) fellAt[k] = step - firstShot;
      });
      return [];
    },
  });
  const s = r.session, first = s.outcomes[0];
  const health = engine.health ? await engine.health() : null;
  return {
    cleared: s.phase === 'cleared' || s.objectiveDone, phase: s.phase, crownsDown: s.crownDown.reduce((a, x) => a + x, 0), crowns: c.meta.crowns.length,
    heritageBroken: s.heritageBroken.reduce((a, x) => a + x, 0), steps: r.steps - (firstShot < 0 ? start : firstShot),
    settledSeconds: first ? (first.settleStep - first.spawnStep) * c.scene.dt : 0,
    awakeMax, awakeMean: samples ? awakeSum / samples : 0, displaced: moved.reduce((a, x) => a + x, 0), fellAt, hash: snapshotHash(r.snapshot), limits: limitProblems(health, engine.info.name),
  };
}

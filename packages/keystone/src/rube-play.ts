// Playing a Rube Lab level (M10, docs/game/rube-lab.md) on any engine, as the
// game plays it: Driver.reset (its pre-settle), the plunger that fires charge 0
// (the trapdoor's release), the session to its end. Shared by the lab's bot
// (the reference, rube.ts) and the cast page (the game's engines, so the GPU in
// CI): what it returns is what the gate and the level tests read.
import type { PhysicsEngine, Snapshot } from '@tb/engine-api';
import { type CompiledLevel } from './level.ts';
import { Driver, type DriverOptions, playShots, snapshotHash } from './driver.ts';
import type { Shot } from './shots.ts';

/** The plunger that starts every Rube Lab level: charge 0 (the release) at once. */
export const RUBE_GO: Shot = { ammo: 'plunger', fuse: [[0, 0]] };

export interface RubeResult {
  cleared: boolean;
  /** Bells rung at the end, of `bells`. */
  rung: number;
  bells: number;
  /**
   * Steps from the plunger to the step every bell had rung (-1: never), and to the session's end: both
   * observed steps (the session's levelEnd), so a pipelined driver's one step in flight past the end is not counted.
   */
  rungAt: number;
  steps: number;
  /**
   * Most any pinned body moved, h, from its authored pose (position, and rotation as the largest quaternion
   * component change), rounded as the engine stores it (f32 on WebGPU, whose info.backend is webgpu:vendor/arch): exactly 0 when pins hold.
   */
  pinnedMove: number;
  /** Where the most pinned move was (body, component, the two values), '' when none. */
  pinnedAt: string;
  hash: string;
}

/** Plays compiled Rube Lab level `c` on `engine` (disposed by the caller) with one plunger. */
export async function rubePlay(engine: PhysicsEngine, c: CompiledLevel, opts: DriverOptions & { maxSteps?: number } = {}): Promise<RubeResult> {
  const d = new Driver(engine, c, { pipelined: opts.pipelined });
  await d.reset();
  const start = engine.stepIndex;
  let rungAt = -1;
  const r = await playShots(d, [RUBE_GO], 0, {
    maxSteps: start + (opts.maxSteps ?? 2400),
    perStep: () => { if (rungAt < 0 && d.session.crownLive.length && d.session.crownLive.every(Boolean)) rungAt = d.snapshotStep - start; return []; },
  });
  // The observed step the session ended at (its levelEnd), not engine.stepIndex: a pipelined driver has stepped once more.
  const end = r.feedback.find((f) => f.t === 'levelEnd')?.step ?? r.steps;
  return {
    cleared: r.session.phase === 'cleared', rung: r.session.crownLive.reduce((a, x) => a + x, 0), bells: c.meta.crowns.length,
    rungAt, steps: end - start, ...pins(pinnedWorst(c, r.snapshot, engine.info.backend.startsWith('webgpu'))), hash: snapshotHash(r.snapshot),
  };
}

const pins = (w: { move: number; at: string }) => ({ pinnedMove: w.move, pinnedAt: w.at });

/** Most a pinned body of `c` moved in `s` from its authored pose, h (f32: the authored pose as an f32 engine stores it). */
export function pinnedMove(c: CompiledLevel, s: Snapshot, f32: boolean): number { return pinnedWorst(c, s, f32).move; }

/** pinnedMove, and where (body index and component, '' when nothing moved): what a failing pin test prints. */
export function pinnedWorst(c: CompiledLevel, s: Snapshot, f32: boolean): { move: number; at: string } {
  const round = f32 ? Math.fround : (x: number) => x;
  let move = 0, at = '';
  const see = (d: number, where: string) => { if (d > move) { move = d; at = where; } };
  c.scene.bodies.forEach((b, i) => {
    if (!b.pinned) return;
    for (let k = 0; k < 3; k++) see(Math.abs(s.pos[3 * i + k]! - round(b.pos[k]!)) / c.frame.unit, `body ${i} pos[${k}] ${s.pos[3 * i + k]} vs ${round(b.pos[k]!)}`);
    for (let k = 0; k < 4; k++) see(Math.abs(s.rot[4 * i + k]! - round(b.rot[k]!)), `body ${i} rot[${k}] ${s.rot[4 * i + k]} vs ${round(b.rot[k]!)}`);
  });
  return { move, at };
}

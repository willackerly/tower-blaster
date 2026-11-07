// A level at load (the agent playtest's PT11): its pre-settle as the game runs it, then `steps` more with
// nothing fired, on any engine. The game's cast page measures the same on the GPU solver (cast-page.ts rest).
import type { PhysicsEngine } from '@tb/engine-api';
import { type CompiledLevel, physicsOf } from '@tb/keystone';

export interface LoadReport {
  /** Over the pre-settle, from the authored poses: the most any structure body moved (m), and how many moved over half a cell (broken at load). */
  settle: { maxMove: number; fell: number };
  /** Over the `steps` after it: the most any structure body moved (m). */
  maxMove: number;
  steps: number;
}

/** Half a cell: a body that moved this far in the pre-settle fell or slid; real engines compress a loaded stack a few mm a contact. */
export const FELL_CELLS = 0.5;
/** The playtest's bound after the pre-settle: no body moves over 0.1 m. */
export const REST_BOUND_M = 0.1;

export async function loadReport(engine: PhysicsEngine, c: CompiledLevel, steps = 300): Promise<LoadReport> {
  const n = c.meta.n, home = c.meta.home, h = c.frame.unit;
  await engine.init(c.scene);
  for (let i = 0, k = physicsOf(c.def).presettle; i < k; i++) await engine.step();
  const a = Float64Array.from((await engine.snapshot()).pos.subarray(0, 3 * n));
  let settleMove = 0, fell = 0;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(a[3 * i]! - home[3 * i]!, a[3 * i + 1]! - home[3 * i + 1]!, a[3 * i + 2]! - home[3 * i + 2]!);
    settleMove = Math.max(settleMove, d);
    if (d > FELL_CELLS * h) fell++;
  }
  for (let i = 0; i < steps; i++) await engine.step();
  const b = (await engine.snapshot()).pos;
  let maxMove = 0;
  for (let i = 0; i < n; i++) maxMove = Math.max(maxMove, Math.hypot(b[3 * i]! - a[3 * i]!, b[3 * i + 1]! - a[3 * i + 1]!, b[3 * i + 2]! - a[3 * i + 2]!));
  return { settle: { maxMove: settleMove, fell }, maxMove, steps };
}

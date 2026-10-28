// The loaded-gap slop's (AvbdParams.gapSlop) probe, shared by its test files
// (engine-gapslop.test.ts and engine-gapslop-column.test.ts, and with manifold records
// engine-gapslop-records.test.ts and engine-gapslop-records-rest.test.ts, apart
// so CI's shard planner can put them on different workers): the reference
// test's 8-cube column (physics-ref/test/avbd.test.ts), kicked sideways.
import { expect } from 'vitest';
import type { SceneDesc, Vec3 } from '@tb/engine-api';
import type { AvbdParams } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import type { GpuEngineOptions } from '../src/index.ts';
import type * as Drivers from './page.ts';
import { call } from './harness.ts';

export const column = () => buildScenario('S1', { F: 1, H: 8, gap: 0 }, 1);
// The reference test's sideways kick: before step 401 every body's velocity gains 0.01 (2 rnd - 1) m/s on x,
// then on z, drawn in body order from its LCG.
export const sideways = (n: number): Vec3[] => {
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  return Array.from({ length: n }, (): Vec3 => { const x = 0.01 * (2 * rnd() - 1); return [x, 0, 0.01 * (2 * rnd() - 1)]; });
};
type Poke = Parameters<typeof Drivers.pokedRun>[4];
export const poked = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, poke: Poke, opts: Omit<GpuEngineOptions, 'device'> = {}) => {
  const r = await call('pokedRun', scene, steps, params, opts, poke);
  expect(r.error).toBeNull();
  expect(r.diagnostics.uncolored).toBe(0);
  expect(r.diagnostics.colorOverflow).toBe(0);
  expect(r.diagnostics.pairsRequired).toBeLessThanOrEqual(r.diagnostics.pairsWritten);
  expect(r.diagnostics.pairsOverflowSteps).toBe(0); // on any step of the run
  return r;
};
export const state = (s: Drivers.PlainSnapshot) => [s.pos, s.rot, s.linVel, s.angVel];
// The kicked column's state after 450 steps (the reference test's kicked()).
export const kicked = async (params: Partial<AvbdParams>, scene = column(), opts: Omit<GpuEngineOptions, 'device'> = {}) =>
  state((await poked(scene, 450, params, { at: 400, dv: sideways(scene.bodies.length) }, opts)).final);
/** The kicked column after 1500 steps: max speed over steps 1201-1500, and the largest sideways offset at step 1500. */
export const settled = async (params: Partial<AvbdParams>) => {
  const scene = column();
  const r = await poked(scene, 1500, params, { at: 400, dv: sideways(8), win: 300 });
  let side = 0;
  scene.bodies.forEach((b, i) => { side = Math.max(side, Math.hypot(r.final.pos[3 * i]! - b.pos[0], r.final.pos[3 * i + 2]! - b.pos[2])); });
  return { maxV: r.maxV, side };
};

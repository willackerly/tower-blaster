// One run of a quality case (quality.ts) on any engine: the positions every
// `every` steps, and the first and last state. Page-safe (no Node or
// Playwright imports): the GPU runs it in the browser (quality-entry.ts), the
// f64 reference in Node.
import type { PhysicsEngine, SceneDesc } from '@tb/engine-api';

export interface CaseState { pos: number[]; rot: number[] }
export interface CaseRun {
  /** Steps 0, every, 2 every, ..., and the last. */
  samples: Array<{ step: number; pos: number[] }>;
  first: CaseState;
  last: CaseState;
}

const state = (s: { pos: ArrayLike<number>; rot: ArrayLike<number> }): CaseState => ({ pos: Array.from(s.pos), rot: Array.from(s.rot) });

/** Steps `e` (already init()ed on `scene`) `steps` times. */
export async function runCase(e: PhysicsEngine, steps: number, every: number): Promise<CaseRun> {
  const first = state(await e.snapshot());
  const samples = [{ step: 0, pos: first.pos }];
  let last = first;
  for (let i = 1; i <= steps; i++) {
    await e.step();
    if (i % every === 0 || i === steps) {
      last = state(await e.snapshot());
      samples.push({ step: i, pos: last.pos });
    }
  }
  return { samples, first, last };
}

/** init() then runCase(); the engine is disposed of afterwards. */
export async function simulateCase(e: PhysicsEngine & { dispose?(): void }, scene: SceneDesc, steps: number, every: number): Promise<CaseRun> {
  try {
    await e.init(scene);
    return await runCase(e, steps, every);
  } finally {
    e.dispose?.();
  }
}

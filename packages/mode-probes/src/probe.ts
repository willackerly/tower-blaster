// The mode probes (docs/game/modes-roadmap.md section 7): each asks one
// question about how the physics behaves at game settings, which a family of
// game modes depends on. A probe is plain data and pure functions: its cases
// (a scene, a step count, engine settings), a meter that reads the run as it
// goes, and a verdict over every case's result against the probe's pass
// rule. The same code runs in the page (the GPU engine, page.ts) and in Node
// (the tests' CPU checks), so what CI checks is what the CLI measures.
import type { InputEvent, PhysicsEngine, SceneDesc, Snapshot, Vec3 } from '@tb/engine-api';
import type { GpuEngineOptions } from '@tb/physics-gpu';
import type { AvbdParams } from '@tb/physics-ref';

/** ci: small enough for a CI shard on SwiftShader, the harness and the physics' sanity. full: the roadmap's setup. */
export const SIZES = ['ci', 'full'] as const;
export type Size = (typeof SIZES)[number];

export interface RunSpec {
  scene: SceneDesc;
  /** Step cap; the meter may stop the run earlier. */
  steps: number;
  params: Partial<AvbdParams>;
  /** GPU engine options (sleep and its rule, pair room, box broadphase). */
  opts: Omit<GpuEngineOptions, 'device'>;
}

/**
 * What a meter asks for after reading a sample: nothing, the end of the run, or events to push
 * (applied from the next step on, PhysicsEngine.push).
 */
export type Action = void | 'stop' | InputEvent[];

export interface Meter<R> {
  /** Sample period in steps (step 0, after init, is always sampled, and the last step). */
  every: number;
  sample(step: number, s: Snapshot): Action;
  result(): R;
}

export interface Check { name: string; pass: boolean; detail: string }
export interface Verdict {
  /** Every check passed (null: the size cannot decide the probe, e.g. a CI run with fewer nudges than the rule). */
  pass: boolean | null;
  checks: Check[];
  /** Markdown table rows (header first) of the per-case numbers. */
  table: string[];
}

export interface CaseRun<C, R> { c: C; result: R; steps: number; wallMs: number; limits: string[] }

export interface Probe<C = unknown, R = unknown> {
  id: string;
  title: string;
  question: string;
  /** The roadmap's pass rule, in words. */
  rule: string;
  cases(size: Size): C[];
  /** A short label for one case. */
  label(c: C): string;
  spec(c: C): RunSpec;
  meter(c: C, spec: RunSpec): Meter<R>;
  verdict(runs: CaseRun<C, R>[], size: Size): Verdict;
}

/**
 * Runs a spec on an engine: init, then step until the cap or the meter stops it, sampling every
 * meter.every steps (and step 0, and the last). `afterInit` runs once init() resolves.
 */
export async function drive<R>(engine: PhysicsEngine, spec: RunSpec, meter: Meter<R>, afterInit?: () => void | Promise<void>): Promise<{ steps: number; wallMs: number }> {
  await engine.init(spec.scene);
  await afterInit?.();
  const t0 = performance.now();
  let act = meter.sample(0, await engine.snapshot());
  let i = 0;
  while (act !== 'stop' && i < spec.steps) {
    if (Array.isArray(act) && act.length) engine.push(act);
    await engine.step();
    i++;
    act = i % meter.every === 0 || i === spec.steps ? meter.sample(i, await engine.snapshot()) : undefined;
  }
  await engine.finish?.();
  return { steps: i, wallMs: performance.now() - t0 };
}

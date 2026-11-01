// Browser side of rest-stability.test.ts (bundled by @tb/testkit loadBundle):
// runs a scene on the GPU engine for a number of frames and measures, on the
// page, how far the structure's bodies moved over a watch window, so only a
// few numbers cross back to Node however many bodies there are.
import type { EngineHealth, SceneDesc } from '@tb/engine-api';
import { sharedDevice } from '@tb/gpu';
import type { AvbdParams } from '@tb/physics-ref';
import { GpuAvbdEngine, type GpuEngineOptions } from '../src/index.ts';

export interface RestPlan {
  /** Frames to run; each is `substeps` engine steps (a world at a scale other than 1 runs several, worldScene). */
  frames: number;
  substeps: number;
  /** The frame whose state the window measures from (the end is the last frame). */
  watchFrom: number;
  /** The structure: bodies [0, structure) (spawned bodies such as a ball come after and are left out). */
  structure: number;
  /** A body that moved more than this over the window counts as moved (scene units). */
  tol: number;
  /** Also sample the structure's largest speed every this many frames inside the window (0: only at the end). */
  sampleEvery: number;
}

export interface RestResult {
  error: string | null;
  adapter: string;
  /** Largest displacement of a structure body over the window, and how many moved more than tol. */
  maxDisp: number;
  moved: number;
  /** The structure's largest body speed at the end, and the largest seen at any sample in the window. */
  endSpeed: number;
  windowSpeed: number;
  /** The structure's highest body centre at the window's start and end. */
  topFrom: number;
  topEnd: number;
  /** Mean height of the structure's centres at the start (frame 0), the window's start and end. */
  meanY: [number, number, number];
  health: EngineHealth;
  wallMs: number;
  /** Engine steps per second over the whole run (never a performance result off a physical GPU). */
  stepsPerSecond: number;
}

export async function restRun(scene: SceneDesc, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>, plan: RestPlan): Promise<RestResult> {
  const { adapter, device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  const n = plan.structure;
  try {
    await e.init(scene);
    const pos = async () => (await e.snapshot()).pos.slice(0, 3 * n);
    const speed = async () => {
      const s = await e.snapshot();
      let m = 0;
      for (let i = 0; i < n; i++) m = Math.max(m, Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!));
      return m;
    };
    const top = (p: Float64Array) => { let t = -Infinity; for (let i = 0; i < n; i++) t = Math.max(t, p[3 * i + 1]!); return t; };
    const mean = (p: Float64Array) => { let t = 0; for (let i = 0; i < n; i++) t += p[3 * i + 1]!; return t / n; };
    const p0 = await pos();
    let from: Float64Array | null = null, windowSpeed = 0;
    const t0 = performance.now();
    for (let f = 0; f < plan.frames; f++) {
      if (f === plan.watchFrom) from = await pos();
      for (let k = 0; k < plan.substeps; k++) e.step();
      // Bound the queue on slow adapters.
      if (f % 20 === 19) await e.finish();
      if (from && plan.sampleEvery && (f + 1 - plan.watchFrom) % plan.sampleEvery === 0) windowSpeed = Math.max(windowSpeed, await speed());
    }
    await e.finish();
    const wallMs = performance.now() - t0;
    const end = await pos();
    from ??= p0;
    let maxDisp = 0, moved = 0;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(end[3 * i]! - from[3 * i]!, end[3 * i + 1]! - from[3 * i + 1]!, end[3 * i + 2]! - from[3 * i + 2]!);
      maxDisp = Math.max(maxDisp, d);
      if (d > plan.tol) moved++;
    }
    const endSpeed = await speed();
    const health = await e.health();
    const error = await device.popErrorScope();
    const info = adapter.info;
    return {
      error: error?.message ?? null, adapter: `${info.vendor} ${info.architecture} ${info.description}`.trim(),
      maxDisp, moved, endSpeed, windowSpeed: Math.max(windowSpeed, endSpeed), topFrom: top(from), topEnd: top(end),
      meanY: [mean(p0), mean(from), mean(end)], health, wallMs, stepsPerSecond: (plan.frames * plan.substeps) / (wallMs / 1000),
    };
  } finally {
    e.dispose();
  }
}

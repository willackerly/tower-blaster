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
  /** Also record a RestSample every sampleEvery frames from the start (when the late motion begins, and how). */
  trace?: boolean;
}

/** The structure at one frame of a traced run. */
export interface RestSample {
  frame: number;
  /** Largest body speed, and how many bodies move faster than tol per second. */
  maxSpeed: number;
  fast: number;
  meanY: number;
  top: number;
}

/** One of the bodies that moved most over the window: where it was at the window's start and end. */
export interface RestMover {
  body: number;
  disp: number;
  from: [number, number, number];
  end: [number, number, number];
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
  /** The (up to) MOVERS bodies that moved most over the window, largest first, if they moved more than tol. */
  movers: RestMover[];
  /** Every sampleEvery frames from frame sampleEvery to the end when plan.trace (else empty). */
  trace: RestSample[];
  health: EngineHealth;
  wallMs: number;
  /** Engine steps per second over the whole run (never a performance result off a physical GPU). */
  stepsPerSecond: number;
}

export const MOVERS = 8;

export async function restRun(scene: SceneDesc, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>, plan: RestPlan): Promise<RestResult> {
  const { adapter, device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  const n = plan.structure;
  try {
    await e.init(scene);
    const pos = async () => (await e.snapshot()).pos.slice(0, 3 * n);
    const top = (p: ArrayLike<number>) => { let t = -Infinity; for (let i = 0; i < n; i++) t = Math.max(t, p[3 * i + 1]!); return t; };
    const mean = (p: ArrayLike<number>) => { let t = 0; for (let i = 0; i < n; i++) t += p[3 * i + 1]!; return t / n; };
    // Units per second: a body faster than tol a second counts as fast.
    const sample = async (frame: number): Promise<RestSample> => {
      const s = await e.snapshot();
      let maxSpeed = 0, fast = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!);
        maxSpeed = Math.max(maxSpeed, v);
        if (v > plan.tol) fast++;
      }
      return { frame, maxSpeed, fast, meanY: mean(s.pos), top: top(s.pos) };
    };
    const p0 = await pos();
    let from: Float64Array | null = null, windowSpeed = 0;
    const trace: RestSample[] = [];
    const t0 = performance.now();
    for (let f = 0; f < plan.frames; f++) {
      if (f === plan.watchFrom) from = await pos();
      for (let k = 0; k < plan.substeps; k++) e.step();
      // Bound the queue on slow adapters.
      if (f % 20 === 19) await e.finish();
      const inWindow = from && plan.sampleEvery && (f + 1 - plan.watchFrom) % plan.sampleEvery === 0;
      const traced = plan.trace && plan.sampleEvery && (f + 1) % plan.sampleEvery === 0;
      if (inWindow || traced) {
        const s = await sample(f + 1);
        if (inWindow) windowSpeed = Math.max(windowSpeed, s.maxSpeed);
        if (traced) trace.push(s);
      }
    }
    await e.finish();
    const wallMs = performance.now() - t0;
    const end = await pos();
    from ??= p0;
    let maxDisp = 0, moved = 0;
    const movers: RestMover[] = [];
    const at = (p: Float64Array, i: number): [number, number, number] => [p[3 * i]!, p[3 * i + 1]!, p[3 * i + 2]!];
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(end[3 * i]! - from[3 * i]!, end[3 * i + 1]! - from[3 * i + 1]!, end[3 * i + 2]! - from[3 * i + 2]!);
      maxDisp = Math.max(maxDisp, d);
      if (d <= plan.tol) continue;
      moved++;
      if (movers.length === MOVERS && d <= movers[MOVERS - 1]!.disp) continue;
      movers.splice(MOVERS - 1, 1, { body: i, disp: d, from: at(from, i), end: at(end, i) });
      movers.sort((a, b) => b.disp - a.disp);
    }
    const endSpeed = (await sample(plan.frames)).maxSpeed;
    const health = await e.health();
    const error = await device.popErrorScope();
    const info = adapter.info;
    return {
      error: error?.message ?? null, adapter: `${info.vendor} ${info.architecture} ${info.description}`.trim(),
      maxDisp, moved, endSpeed, windowSpeed: Math.max(windowSpeed, endSpeed), topFrom: top(from), topEnd: top(end),
      meanY: [mean(p0), mean(from), mean(end)], movers, trace, health, wallMs, stepsPerSecond: (plan.frames * plan.substeps) / (wallMs / 1000),
    };
  } finally {
    e.dispose();
  }
}

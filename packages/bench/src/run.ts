// Timing and quality runs. Timing and quality are separate passes so that
// snapshotting and metric computation never land inside a timed region.
import { bodiesAt, type EngineHealth, limitProblems, type PhysicsEngine, type SceneDesc, type Snapshot, TAG_BALL } from '@tb/engine-api';
import {
  drift, driftSuspect, energy, energyGain, jitter, median, nonFinite, pairedPercentDiff, penetration,
  sleepRatio, stateHash, summarize, survival, verdict, type Interval, type Verdict,
} from '@tb/metrics';

export type Clock = () => number;
export const wallClock: Clock = () => performance.now();

/**
 * How steps are timed. 'latency': each sample is one step() plus finish(), the
 * cost of a step to a caller that waits for it. 'throughput': a block runs its
 * steps back to back and waits once at the end, so a GPU can overlap them; the
 * block gives one sample, its time divided by its steps. For an engine without
 * finish() the modes differ only in the statistic (a block's median step
 * against its mean step).
 */
export type TimingMode = 'latency' | 'throughput';

export interface TimingOptions {
  /** Steps run before measuring (pipeline creation, caches, settling). */
  warmup: number;
  /** Steps per measured block. */
  blockSteps: number;
  blocks: number;
  /** Default 'latency'. */
  mode?: TimingMode;
  clock?: Clock;
}

export const DEFAULT_TIMING: TimingOptions = { warmup: 120, blockSteps: 300, blocks: 10 };

export interface BlockTiming {
  mode: TimingMode;
  steps: number;
  /** Wall time per step, ms: one per step ('latency') or one per block ('throughput'). */
  samples: number[];
  /** GPU time per step, ms, when the engine reports it. */
  gpu: number[];
  median: number;
  /** Null in 'throughput' mode: one sample per block can't show drift within it. */
  driftSuspect: boolean | null;
}

async function stepTimed(e: PhysicsEngine, clock: Clock): Promise<[number, number | undefined]> {
  const t0 = clock();
  const r = await e.step();
  if (e.finish) await e.finish();
  return [clock() - t0, r ? r.gpuMs : undefined];
}

/** Must start with every engine idle (see timeInterleaved). */
async function runBlock(e: PhysicsEngine, steps: number, clock: Clock, mode: TimingMode): Promise<BlockTiming> {
  const samples: number[] = [], gpu: number[] = [];
  if (mode === 'throughput') {
    const t0 = clock();
    for (let i = 0; i < steps; i++) {
      const r = await e.step();
      if (r && r.gpuMs !== undefined) gpu.push(r.gpuMs);
    }
    if (e.finish) await e.finish();
    const perStep = (clock() - t0) / steps;
    return { mode, steps, samples: [perStep], gpu, median: perStep, driftSuspect: null };
  }
  for (let i = 0; i < steps; i++) {
    const [ms, g] = await stepTimed(e, clock);
    samples.push(ms);
    if (g !== undefined) gpu.push(g);
  }
  return { mode, steps, samples, gpu, median: median(samples), driftSuspect: driftSuspect(samples) };
}

/**
 * Time several engines on the same scene with interleaved blocks: block i of
 * every engine covers the same simulated steps, run back to back, so blocks
 * can be compared as pairs.
 */
export async function timeInterleaved(engines: PhysicsEngine[], scene: SceneDesc, opts: TimingOptions): Promise<BlockTiming[][]> {
  const clock = opts.clock ?? wallClock;
  for (const e of engines) await e.init(scene);
  for (const e of engines) for (let i = 0; i < opts.warmup; i++) await e.step();
  // Every block starts with every engine idle: GPU engines each have their own
  // device, and work still queued on one competes with the block timing another.
  const idle = async () => { for (const e of engines) if (e.finish) await e.finish(); };
  const out: BlockTiming[][] = engines.map(() => []);
  for (let b = 0; b < opts.blocks; b++) {
    // Alternate which engine goes first, so neither always follows the other.
    const order = engines.map((_, i) => i);
    if (b % 2 === 1) order.reverse();
    for (const i of order) {
      await idle();
      out[i]!.push(await runBlock(engines[i]!, opts.blockSteps, clock, opts.mode ?? 'latency'));
    }
  }
  // finish() rejects once a GPU engine has seen a device error, but the browser
  // may deliver that event a task later: let it arrive, then check once more.
  await new Promise((resolve) => setTimeout(resolve, 0));
  await idle();
  return out;
}

export function timingSummary(blocks: BlockTiming[]) {
  const all = blocks.flatMap((b) => b.samples);
  const gpu = blocks.flatMap((b) => b.gpu);
  return {
    mode: blocks[0]?.mode ?? 'latency',
    blocks: blocks.length,
    stepsPerBlock: blocks[0]?.steps ?? 0,
    blockMedians: blocks.map((b) => b.median),
    wallMs: summarize(all),
    gpuMs: gpu.length ? summarize(gpu) : null,
    // Null when not checked (throughput mode).
    driftSuspectBlocks: blocks.some((b) => b.driftSuspect === null) ? null : blocks.filter((b) => b.driftSuspect).length,
  };
}

/**
 * Each engine's health() over the steps since its last init() (null for an
 * engine without one), and one sentence per limit that changed the physics,
 * labelled `labels[i]`. Read it after timing, never inside it.
 */
export async function engineHealth(engines: PhysicsEngine[], labels: string[]): Promise<{ health: Array<EngineHealth | null>; limitProblems: string[] }> {
  const health = await Promise.all(engines.map((e) => (e.health ? e.health() : null)));
  return { health, limitProblems: health.flatMap((h, i) => limitProblems(h, labels[i]!)) };
}

export interface Comparison { diff: Interval; verdict: Verdict; threshold: number }

/** B relative to A; negative means B is faster. */
export function compareBlocks(a: BlockTiming[], b: BlockTiming[], threshold = 0.02): Comparison {
  const diff = pairedPercentDiff(a.map((x) => x.median), b.map((x) => x.median));
  return { diff, verdict: verdict(diff, threshold), threshold };
}

export interface QualityOptions { steps: number; sampleEvery: number; h?: number }

export interface QualityReport {
  steps: number;
  bodies: number;
  penetration: ReturnType<typeof penetration>;
  /** Max horizontal displacement over the run, cube edges; untouched scenes only. */
  drift: number;
  jitter: number;
  energyGain: number;
  survival: number;
  sleepRatio: number;
  /** First sampled step at which every body was asleep, or null. */
  allAsleepStep: number | null;
  nonFinite: number;
  hash: string;
  series: { step: number; energy: number; sleepRatio: number; penetrationMax: number }[];
}

/**
 * Run a scene for `steps`, sampling metrics every `sampleEvery` steps.
 * Drift and survival are measured against the initial state, which is only
 * meaningful when nothing is fired at the scene.
 */
export async function qualityRun(e: PhysicsEngine, scene: SceneDesc, opts: QualityOptions): Promise<QualityReport> {
  const h = opts.h ?? 1;
  await e.init(scene);
  const s0 = await e.snapshot();
  const series: QualityReport['series'] = [];
  const energies: number[] = [];
  let allAsleepStep: number | null = null;
  let maxPen = penetration(bodiesAt(scene, 0), s0, scene.ground?.y ?? null, h);
  let last: Snapshot = s0;
  const sample = async (step: number) => {
    const s = await e.snapshot();
    const bodies = bodiesAt(scene, step);
    const pen = penetration(bodies, s, scene.ground?.y ?? null, h);
    if (pen.max > maxPen.max) maxPen = pen;
    const en = energy(bodies, s, scene.gravity).total;
    energies.push(en);
    const sr = sleepRatio(s);
    if (sr === 1 && allAsleepStep === null) allAsleepStep = step;
    series.push({ step, energy: en, sleepRatio: sr, penetrationMax: pen.max });
    last = s;
  };
  await sample(0);
  for (let i = 1; i <= opts.steps; i++) {
    await e.step();
    if (i % opts.sampleEvery === 0 || i === opts.steps) await sample(i);
  }
  const initial = scene.bodies.length;
  const untouched = Array.from({ length: initial }, (_, i) => i);
  const towerTags = [...new Set(scene.bodies.map((b) => b.tag).filter((t) => t >= 0))];
  const fired = scene.inputs.some((ev) => ev.kind === 'spawn' && ev.body.tag === TAG_BALL);
  return {
    steps: opts.steps,
    bodies: last.count,
    penetration: maxPen,
    drift: fired ? NaN : drift(s0, last, untouched, h),
    jitter: jitter(last, undefined, h),
    energyGain: energyGain(energies),
    survival: fired ? NaN : survival(scene.bodies, s0, last, towerTags),
    sleepRatio: sleepRatio(last),
    allAsleepStep,
    nonFinite: nonFinite(last),
    hash: stateHash(last),
    series,
  };
}

/** Quality gates from the plan. Each returns null when passing, or a reason. */
export function qualityGates(q: QualityReport, untouched: boolean): Record<string, string | null> {
  return {
    finite: q.nonFinite === 0 ? null : `${q.nonFinite} non-finite values`,
    penetration: q.penetration.p99 < 0.02 ? null : `p99 penetration ${q.penetration.p99.toFixed(4)} >= 0.02`,
    energy: q.energyGain < 0.01 ? null : `energy gain ${(q.energyGain * 100).toFixed(2)}% >= 1%`,
    drift: !untouched || q.drift < 0.05 ? null : `drift ${q.drift.toFixed(4)} >= 0.05`,
    survival: !untouched || q.survival >= 0.98 ? null : `survival ${q.survival.toFixed(3)} < 0.98`,
  };
}

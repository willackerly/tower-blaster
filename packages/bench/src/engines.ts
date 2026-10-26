// Engine registry for the CLI: "name" or "name:key=value,key=value".
import type { InputEvent, PhysicsEngine, SceneDesc, StepReport } from '@tb/engine-api';
import { RapierEngine, RapierHost } from '@tb/adapter-rapier';
import { TieredEngine } from '@tb/lattice';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { GpuAvbdEngine, type GpuEngineOptions } from '@tb/physics-gpu';

type Options = Record<string, number | boolean | string>;

const REGISTRY: Record<string, (o: Options) => PhysicsEngine> = {
  rapier: (o) => new RapierEngine(o.iterations !== undefined ? { iterations: Number(o.iterations) } : {}),
  // Options are AvbdParams fields, e.g. avbd-ref:iterations=4,sweep=false.
  'avbd-ref': (o) => new AvbdReferenceEngine(o),
  // Same AvbdParams, plus the GpuEngineOptions that size its buffers (capacity, spare,
  // pairsPerBody, maxRadius) or shape its dispatch (colorTail, indirectColors, tailThreads, colorRounds,
  // hessian), which the engine checks; needs WebGPU, so it runs in the browser runner, not the Node CLI.
  'avbd-gpu': (o) => {
    const { capacity, spare, pairsPerBody, maxRadius, colorTail, indirectColors, tailThreads, colorRounds, hessian, ...params } = o;
    const opts = Object.fromEntries(Object.entries({ capacity, spare, pairsPerBody, maxRadius, colorTail, indirectColors, tailThreads, colorRounds, hessian }).filter(([, v]) => v !== undefined)) as GpuEngineOptions;
    return new GpuAvbdEngine(params, opts);
  },
  // Dormant lattice tier over a Rapier host; other options are TierParams (e.g. tiered:vWake=0.5).
  tiered: (o) => {
    const { iterations, ...tier } = o;
    return new TieredEngine(new RapierHost(iterations !== undefined ? { iterations: Number(iterations) } : {}), tier);
  },
};

/** Engine options whose value is a word rather than a number or boolean. */
const WORD_OPTIONS = new Set(['hessian']);

export function parseSpec(spec: string): { name: string; options: Options } {
  const [name, rest] = spec.split(':', 2) as [string, string | undefined];
  const options: Options = {};
  for (const kv of rest ? rest.split(',') : []) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined || v === '') throw new Error(`bad engine option "${kv}" in "${spec}"`);
    // Only options that take a word (hessian=array) keep a string; the engine checks its value. Any other
    // non-number is a mistake: sweep=off would otherwise be a truthy string and turn the sweep on.
    const num = Number(v);
    if (v === 'true' || v === 'false') options[k] = v === 'true';
    else if (!Number.isNaN(num)) options[k] = num;
    else if (WORD_OPTIONS.has(k)) options[k] = v;
    else throw new Error(`bad engine option "${kv}" in "${spec}": ${k} takes a number, true or false`);
  }
  return { name, options };
}

export function makeEngine(spec: string): PhysicsEngine {
  const { name, options } = parseSpec(spec);
  const make = REGISTRY[name];
  if (!make) throw new Error(`unknown engine ${name}; known: ${Object.keys(REGISTRY).join(', ')}`);
  return make(options);
}

export const engineNames = () => Object.keys(REGISTRY);

/**
 * Wraps an engine and busy-waits so each step takes (1 + fraction) times as
 * long. The harness self-check must detect this. Fraction 0 runs the same
 * code and spins zero time, which makes it the baseline arm. The spin is a
 * fraction of the host-side step; finish() is passed through, so a wrapped
 * GPU engine is still timed to completion.
 */
export class SlowedEngine implements PhysicsEngine {
  readonly finish?: () => Promise<void>;
  constructor(private readonly inner: PhysicsEngine, private readonly fraction: number, private readonly clock: () => number = () => performance.now()) {
    if (inner.finish) this.finish = () => inner.finish!();
  }
  get info() { return { ...this.inner.info, variant: { ...this.inner.info.variant, slowed: this.fraction } }; }
  get stepIndex() { return this.inner.stepIndex; }
  init(scene: SceneDesc) { return this.inner.init(scene); }
  push(events: InputEvent[]) { this.inner.push(events); }
  async step(): Promise<StepReport | void> {
    const t0 = this.clock();
    const r = await this.inner.step();
    const t1 = this.clock();
    const until = t1 + (t1 - t0) * this.fraction;
    while (this.clock() < until) { /* spin */ }
    return r;
  }
  snapshot() { return this.inner.snapshot(); }
  dispose() { this.inner.dispose(); }
}

/**
 * The self-check's baseline and slowed arms. Both are SlowedEngines, so they
 * run the same wrapper code and differ only in the spin. With a bare baseline
 * against a wrapped copy, a true 10% slowdown was estimated anywhere from -4%
 * to +18% (37 runs, 3 failed the check); with both wrapped, 8% to 12% (25 runs,
 * none failed). Measured 2026-10-25 on a 4-core VM.
 */
export function slowdownArms(make: () => PhysicsEngine, fraction: number, clock?: () => number): [SlowedEngine, SlowedEngine] {
  return [new SlowedEngine(make(), 0, clock), new SlowedEngine(make(), fraction, clock)];
}

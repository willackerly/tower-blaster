// Engine registry for the CLI: "name" or "name:key=value,key=value".
import type { PhysicsEngine, SceneDesc, StepReport } from '@tb/engine-api';
import { RapierEngine } from '@tb/adapter-rapier';

type Options = Record<string, number | boolean>;

const REGISTRY: Record<string, (o: Options) => PhysicsEngine> = {
  rapier: (o) => new RapierEngine(o.iterations !== undefined ? { iterations: Number(o.iterations) } : {}),
};

export function parseSpec(spec: string): { name: string; options: Options } {
  const [name, rest] = spec.split(':', 2) as [string, string | undefined];
  const options: Options = {};
  for (const kv of rest ? rest.split(',') : []) {
    const [k, v] = kv.split('=');
    if (!k || v === undefined) throw new Error(`bad engine option "${kv}" in "${spec}"`);
    options[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
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
 * code and spins zero time, which makes it the baseline arm.
 */
export class SlowedEngine implements PhysicsEngine {
  constructor(private readonly inner: PhysicsEngine, private readonly fraction: number, private readonly clock: () => number = () => performance.now()) {}
  get info() { return { ...this.inner.info, variant: { ...this.inner.info.variant, slowed: this.fraction } }; }
  get stepIndex() { return this.inner.stepIndex; }
  init(scene: SceneDesc) { return this.inner.init(scene); }
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

// The engines the lab plays on. A spec is plain data so a worker thread can
// build the same engine the main thread would.
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { AVBD_ITERATIONS } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

export const LAB_ENGINES = ['rapier', 'ref'] as const;
export type LabEngineKind = (typeof LAB_ENGINES)[number];
/** `iterations` defaults to the engine's own (Rapier 4) or AVBD_ITERATIONS for the reference. */
export interface EngineSpec { kind: LabEngineKind; iterations?: number }

export function makeEngine(spec: EngineSpec): PhysicsEngine {
  if (spec.kind === 'rapier') return new RapierEngine(spec.iterations === undefined ? {} : { iterations: spec.iterations });
  return new AvbdReferenceEngine({ iterations: spec.iterations ?? AVBD_ITERATIONS });
}

/** Integrator substeps per step, which shots must be aimed with. */
export const engineSubsteps = (spec: EngineSpec): number => makeEngine(spec).info.integrator?.substeps ?? 1;

export function engineLabel(spec: EngineSpec): string {
  const e = makeEngine(spec);
  return `${spec.kind} (${e.info.variant.iterations} iterations)`;
}

/**
 * A CLI argument list: every `--name value` pair as a flag, the rest as ids.
 * `--engine rapier|ref`, `--iterations N` and `--jobs N` are read here.
 */
export function labArgs(args: string[], defaultJobs: number): { spec: EngineSpec; jobs: number; flags: Map<string, string>; ids: string[] } {
  const flags = new Map<string, string>(), ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
    else ids.push(a);
  }
  const kind = flags.get('engine') ?? 'rapier';
  if (!(LAB_ENGINES as readonly string[]).includes(kind)) throw new Error(`unknown engine ${kind}: use ${LAB_ENGINES.join(' or ')}`);
  const num = (name: string) => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a whole number >= 1, got ${v}`);
    return n;
  };
  const iterations = num('iterations');
  return { spec: iterations === undefined ? { kind: kind as LabEngineKind } : { kind: kind as LabEngineKind, iterations }, jobs: num('jobs') ?? defaultJobs, flags, ids };
}

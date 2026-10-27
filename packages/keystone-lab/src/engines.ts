// The engines the lab plays on. A spec is plain data so a worker thread can
// build the same engine the main thread would.
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

export const LAB_ENGINES = ['rapier', 'ref'] as const;
export type LabEngineKind = (typeof LAB_ENGINES)[number];
/**
 * `iterations` defaults to the engine's own (Rapier 4) or AVBD_ITERATIONS for
 * the reference; `gapSlop` (reference only) to AVBD_GAP_SLOP, 0 turns it off.
 */
export interface EngineSpec { kind: LabEngineKind; iterations?: number; gapSlop?: number }

export function makeEngine(spec: EngineSpec): PhysicsEngine {
  if (spec.kind === 'rapier') return new RapierEngine(spec.iterations === undefined ? {} : { iterations: spec.iterations });
  return new AvbdReferenceEngine({ iterations: spec.iterations ?? AVBD_ITERATIONS, gapSlop: spec.gapSlop ?? AVBD_GAP_SLOP });
}

/** Integrator substeps per step, which shots must be aimed with. */
export const engineSubsteps = (spec: EngineSpec): number => makeEngine(spec).info.integrator?.substeps ?? 1;

export function engineLabel(spec: EngineSpec): string {
  const v = makeEngine(spec).info.variant;
  return `${spec.kind} (${v.iterations} iterations${v.gapSlop ? `, gap slop ${v.gapSlop} m` : ''})`;
}

/**
 * A CLI argument list: every `--name value` pair as a flag, the rest as ids.
 * `--engine ref|rapier` (the reference, which pins par lines, by default),
 * `--iterations N`, `--gap-slop M` (metres, reference only) and `--jobs N`
 * are read here.
 */
export function labArgs(args: string[], defaultJobs: number): { spec: EngineSpec; jobs: number; flags: Map<string, string>; ids: string[] } {
  const flags = new Map<string, string>(), ids: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) flags.set(a.slice(2), args[++i] ?? '');
    else ids.push(a);
  }
  const kind = flags.get('engine') ?? 'ref';
  if (!(LAB_ENGINES as readonly string[]).includes(kind)) throw new Error(`unknown engine ${kind}: use ${LAB_ENGINES.join(' or ')}`);
  const num = (name: string) => {
    const v = flags.get(name);
    if (v === undefined) return undefined;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} needs a whole number >= 1, got ${v}`);
    return n;
  };
  const spec: EngineSpec = { kind: kind as LabEngineKind };
  const iterations = num('iterations');
  if (iterations !== undefined) spec.iterations = iterations;
  const slop = flags.get('gap-slop');
  if (slop !== undefined) {
    const g = Number(slop);
    if (kind !== 'ref') throw new Error('--gap-slop is a reference engine setting: add --engine ref');
    if (slop === '' || !Number.isFinite(g) || g < 0) throw new Error(`--gap-slop needs metres >= 0, got ${slop}`);
    spec.gapSlop = g;
  }
  return { spec, jobs: num('jobs') ?? defaultJobs, flags, ids };
}

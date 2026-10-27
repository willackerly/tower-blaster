// pnpm bench:probe --engine "avbd-gpu:key=value,...": the engine variant P2
// times, parsed as pnpm bench parses engine specs (packages/bench engines.ts).
// Node side only (it imports the bench registry); the page gets the result.
import { gpuEngineArgs, parseSpec } from '@tb/bench';
import { GpuAvbdEngine } from './engine.ts';
import type { ProbeOptions } from './probe.ts';

/** The probe flags that set a GpuEngineOptions field of P2's engine, by the field they set. */
const FLAGS = { hessian: '--hessian', pairsPerBody: '--pairs-per-body', boxBroadphase: '--box-broadphase' } as const;

/**
 * ProbeOptions.engine for a spec; throws on another engine, a bad option, or an
 * option given twice (in the spec and as its own flag, whose value is in flags).
 */
export function probeEngine(spec: string, flags: { [K in keyof typeof FLAGS]?: unknown } = {}): NonNullable<ProbeOptions['engine']> {
  const { name, options } = parseSpec(spec);
  if (name !== 'avbd-gpu') throw new Error(`--engine: P2 times the GPU engine, so the spec must be avbd-gpu[:key=value,...], got ${spec}`);
  const { params, opts } = gpuEngineArgs(options);
  for (const [k, flag] of Object.entries(FLAGS) as Array<[keyof typeof FLAGS, string]>) {
    if (flags[k] !== undefined && flags[k] !== false && opts[k] !== undefined) throw new Error(`--engine: give ${k} in the spec or as ${flag}, not both`);
  }
  // The engine checks its options when constructed (no device needed): fail here, not in the page.
  new GpuAvbdEngine(params, opts);
  return { spec, params, opts };
}

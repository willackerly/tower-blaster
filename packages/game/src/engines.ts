// Which physics engine plays the game. Live play and a replay build their
// engine here with the same options, so a replay on the same device is
// bit-identical (the GPU engine is deterministic per device, and its buffers
// are sized at init from these options).
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine, ShapeDesc } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, ammoBody, type CompiledLevel, type DriverOptions, physicsOf, rackBodies } from '@tb/keystone';
import { GpuAvbdEngine, type GpuEngineOptions } from '@tb/physics-gpu';

export const ENGINES = ['rapier', 'gpu'] as const;
export type EngineKind = (typeof ENGINES)[number];
/**
 * The GPU solver plays by default: par lines are pinned on its f64 reference
 * and each one clears on it (par-gpu tests, SwiftShader and Metal). Rapier
 * stays one `?engine=rapier` away, for comparison and for weak GPUs.
 */
export const DEFAULT_ENGINE: EngineKind = 'gpu';

/**
 * The GPU solver's settings: the ones par lines are pinned at on the f64
 * reference (AVBD_ITERATIONS and AVBD_GAP_SLOP). The slop builds on Metal
 * and costs nothing measurable there (M5 Max, S4 10k, 2026-10-27). The
 * colouring is the GPU's default, colorMode 3 (physics-gpu gpuColorMode),
 * where the reference pins with colorMode 0: only the update order differs,
 * and every par line clears under either on both engines (the par-gpu
 * tests run colorMode 3; perf-competition r3-colormode).
 */
export const GPU_PARAMS = { iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP } as const;

/** The `?engine=` value, or the default when absent; avbd-gpu (the viewer's name for it) is the GPU solver too. */
export function engineKind(param: string | null): EngineKind {
  if (param === null || param === '') return DEFAULT_ENGINE;
  if (param === 'avbd-gpu') return 'gpu';
  if ((ENGINES as readonly string[]).includes(param)) return param as EngineKind;
  throw new Error(`unknown engine ${param}: use ${ENGINES.join(' or ')}`);
}

export const radiusOf = (s: ShapeDesc): number => (s.kind === 'sphere' ? s.radius : Math.hypot(...s.half));

/** Room the GPU engine reserves at init for every body the rack can fire (a weapon's whole budget: keystone rackBodies). */
export function gpuOptions(c: CompiledLevel): Required<Pick<GpuEngineOptions, 'capacity' | 'maxRadius'>> {
  const rack = c.def.rack;
  // A weapon's children count and reach too (its arm: every munition it can spawn).
  const maxRadius = Math.max(0, ...rack.map((k) => c.arms[k]?.maxRadius ?? radiusOf(ammoBody(k, c.frame, [0, 0, 0], [0, 0, 0]).shape)));
  return { capacity: c.scene.bodies.length + rackBodies(rack, c.arms), maxRadius };
}

/**
 * How the driver runs each engine. The GPU engine's step() only submits, so
 * its read-back is pipelined: the next step solves while the last one's
 * bodies come back. Live play and replays take the same options.
 */
export const driverOptions = (kind: EngineKind): DriverOptions => ({ pipelined: kind === 'gpu' });

/** The GPU solver's params (physics-ref AvbdParams, as GpuAvbdEngine takes them). */
export type GpuParams = NonNullable<ConstructorParameters<typeof GpuAvbdEngine>[0]>;

/**
 * The GPU solver's params for a level: its physics block (LevelDef.physics; absent, GPU_PARAMS), and
 * the restitution pass on when the block sets a bounce (the compiled scene already carries the e).
 */
export function gpuParams(c: CompiledLevel): GpuParams {
  const p = physicsOf(c.def);
  return { iterations: p.iterations, gapSlop: p.gapSlop, ...(p.bounce !== null ? { restitution: true } : {}) };
}

/** gpuOptions plus the level's own pair buffer when its physics block sets one. */
export function gpuEngineOptions(c: CompiledLevel): GpuEngineOptions {
  const p = physicsOf(c.def);
  return { ...gpuOptions(c), ...(p.pairsPerBody !== undefined ? { pairsPerBody: p.pairsPerBody } : {}) };
}

/**
 * The engine a level plays on. Rapier takes the scene as compiled (Bounce's e is on its bodies and
 * ground); its own iterations are not AVBD's, so the block's iterations and slop are the GPU's only.
 */
export function makeEngine(kind: EngineKind, c: CompiledLevel, device?: GPUDevice): PhysicsEngine {
  if (kind === 'rapier') return new RapierEngine();
  return new GpuAvbdEngine(gpuParams(c), { device, ...gpuEngineOptions(c) });
}

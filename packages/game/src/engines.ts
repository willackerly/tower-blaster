// Which physics engine plays the game. Live play and a replay build their
// engine here with the same options, so a replay on the same device is
// bit-identical (the GPU engine is deterministic per device, and its buffers
// are sized at init from these options).
import { RapierEngine } from '@tb/adapter-rapier';
import { type EngineHealth, limitsHit, type PhysicsEngine, type ShapeDesc } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, ammoBody, type CompiledLevel, type DriverOptions } from '@tb/keystone';
import { everyPairPerBody, GpuAvbdEngine, type GpuEngineOptions } from '@tb/physics-gpu';

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

/**
 * Room the GPU engine reserves at init for every body the rack can fire, and a pair buffer that holds
 * every pair of them (everyPairPerBody), so no shot can drop a contact. Its blocks are 0.5 m and the
 * broadphase's sweep is in metres, so a packed block moving at about 3.3 m/s already reaches past its
 * 26 neighbours, inside the rack's speeds. A level of tens to a hundred-odd bodies costs at most a few
 * thousand slots more than the default 16 per body. Past 362 bodies and rack every pair no longer fits
 * everyPairPerBody's slots, so `pairsPerBody` (the room an earlier round of the level asked for,
 * roomAfter) replaces it when given.
 */
export function gpuOptions(c: CompiledLevel, pairsPerBody?: number): Required<Pick<GpuEngineOptions, 'capacity' | 'maxRadius' | 'pairsPerBody'>> {
  const rack = c.def.rack;
  const maxRadius = Math.max(0, ...rack.map((k) => radiusOf(ammoBody(k, c.frame.unit, [0, 0, 0], [0, 0, 0]).shape)));
  const capacity = c.scene.bodies.length + rack.length;
  return { capacity, maxRadius, pairsPerBody: pairsPerBody ?? everyPairPerBody(capacity) };
}

/**
 * The pair room per body for a level's next round, after a round played at `pairsPerBody` whose engine
 * reported `health` (read once the round is over): the engine's own fix (health.ts pairFix: room for
 * 1.25 x the peak, or the most the device holds) when the round dropped pairs, else unchanged. Never
 * less than before, so a level's room only grows; null health (Rapier) changes nothing.
 */
export function roomAfter(pairsPerBody: number, health: EngineHealth | null): number {
  const pairs = limitsHit(health).find((l) => l.id === 'pairs');
  const fix = pairs?.fix?.option === 'pairsPerBody' && typeof pairs.fix.value === 'number' ? pairs.fix.value : 0;
  return Math.max(pairsPerBody, fix);
}

/**
 * How the driver runs each engine. The GPU engine's step() only submits, so
 * its read-back is pipelined: the next step solves while the last one's
 * bodies come back. Live play and replays take the same options.
 */
export const driverOptions = (kind: EngineKind): DriverOptions => ({ pipelined: kind === 'gpu' });

/** The engine for one round of level c; `pairsPerBody` as gpuOptions takes it (GPU only). */
export function makeEngine(kind: EngineKind, c: CompiledLevel, device?: GPUDevice, pairsPerBody?: number): PhysicsEngine {
  if (kind === 'rapier') return new RapierEngine();
  return new GpuAvbdEngine({ ...GPU_PARAMS }, { device, ...gpuOptions(c, pairsPerBody) });
}

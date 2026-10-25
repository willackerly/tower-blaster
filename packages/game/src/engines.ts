// Which physics engine plays the game. Live play and a replay build their
// engine here with the same options, so a replay on the same device is
// bit-identical (the GPU engine is deterministic per device, and its buffers
// are sized at init from these options).
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine, ShapeDesc } from '@tb/engine-api';
import { ammoBody, type CompiledLevel } from '@tb/keystone';
import { GpuAvbdEngine, type GpuEngineOptions } from '@tb/physics-gpu';

export const ENGINES = ['rapier', 'gpu'] as const;
export type EngineKind = (typeof ENGINES)[number];
export const DEFAULT_ENGINE: EngineKind = 'rapier';

/**
 * Solver iterations on the GPU. At the default 10, AVBD bends columns taller
 * than about 10 cubes and topples them early; Keystone towers reach 12
 * courses, and a 20-cube column is within 1% of rigid at 20 (scenario S13).
 */
export const GPU_ITERATIONS = 20;

/** The `?engine=` value, or the default when absent. */
export function engineKind(param: string | null): EngineKind {
  if (param === null || param === '') return DEFAULT_ENGINE;
  if ((ENGINES as readonly string[]).includes(param)) return param as EngineKind;
  throw new Error(`unknown engine ${param}: use ${ENGINES.join(' or ')}`);
}

export const radiusOf = (s: ShapeDesc): number => (s.kind === 'sphere' ? s.radius : Math.hypot(...s.half));

/** Room the GPU engine reserves at init for every body the rack can fire. */
export function gpuOptions(c: CompiledLevel): Required<Pick<GpuEngineOptions, 'capacity' | 'maxRadius'>> {
  const rack = c.def.rack;
  const maxRadius = Math.max(0, ...rack.map((k) => radiusOf(ammoBody(k, c.frame.unit, [0, 0, 0], [0, 0, 0]).shape)));
  return { capacity: c.scene.bodies.length + rack.length, maxRadius };
}

export function makeEngine(kind: EngineKind, c: CompiledLevel, device?: GPUDevice): PhysicsEngine {
  if (kind === 'rapier') return new RapierEngine();
  return new GpuAvbdEngine({ iterations: GPU_ITERATIONS }, { device, ...gpuOptions(c) });
}

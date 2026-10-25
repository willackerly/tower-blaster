// The contract between the world tiers (@tb/lattice's TieredEngine) and the
// rigid-body engine that simulates the active set underneath them (Rapier
// on the CPU, the GPU AVBD pipeline). The tiers decide which bodies the host
// simulates; the host simulates them.
//
// Agreed with the GPU AVBD thread (2026-10-25):
// - A body is addressed by its stable id (scene index; spawned bodies follow
//   in input order). The id is the host's slot; ids are never reused, so
//   contact warm starts keyed by slot pairs stay valid.
// - Capacity is fixed at init: the id table. Static bodies count against it.
// - Changes are batched between steps and applied atomically.
// - Dormant lattice cells reach the host in one of two ways. A host with
//   caps.latticeNative takes the lattice occupancy itself (Rapier: a voxel
//   collider per lattice; GPU: brick lookups) and gets cell changes in each
//   batch. Otherwise a cell near moving bodies is a static body with the
//   cell's own id at the exact cell pose (a proxy). Native is preferred:
//   separate static boxes have internal seams that catch sliding cubes
//   (measured in Rapier: a cube sliding without friction across 16 static
//   boxes went from 3 to 0.2 m/s and hopped; across voxels, unchanged).
// - State reads may lag by a fixed number of steps (caps.stateLag); the tier
//   always consumes exactly the state of step k - stateLag, so results never
//   depend on readback timing.
import type { BodyDesc, EngineInfo, Quat, SceneDesc, StepReport, Vec3 } from './index.ts';

/** Not simulated (dormant in the lattice, or not spawned yet). */
export const MODE_OFF = 0;
/** Infinite mass, never moves: a lattice proxy or frozen rubble. */
export const MODE_STATIC = 1;
/** Simulated. */
export const MODE_DYNAMIC = 2;
export type BodyMode = typeof MODE_OFF | typeof MODE_STATIC | typeof MODE_DYNAMIC;

export interface HostCaps {
  /** Ids 0 .. capacity-1 are valid. */
  capacity: number;
  /** read() after step k returns the state of step k - stateLag. 0 on CPU hosts. */
  stateLag: number;
  /** Whether read() reports contact forces on static bodies (and native lattice cells). */
  contactForces: boolean;
  /** Whether the host takes lattice occupancy natively (init lattices + batch cells). */
  latticeNative: boolean;
  /**
   * Whether filling or emptying a native cell disturbs only contacts with
   * that cell. Rapier's voxel colliders fail this: any setVoxel jolts every
   * contact on the collider (a resting 10-cube stack on one voxel went from
   * 0.0027 to 0.04 m/s when a voxel 10 m away was filled), so settling cubes
   * back into cells keeps whole rubble piles awake there. The tiers settle
   * cubes into native cells only on hosts that have this.
   */
  localCellChanges?: boolean;
}

/**
 * A lattice the host represents natively: cell (i, j, k) is the cube centred
 * at origin + (i, j, k) * edge, computed per axis in f64 as
 * `origin[a] + index * edge` (the tiers use the same expression, so poses
 * agree bit for bit).
 */
export interface HostLattice {
  origin: Vec3;
  edge: number;
  dims: [number, number, number];
  friction: number;
}

/** Fill or empty one native lattice cell. */
export interface CellChange {
  lattice: number;
  i: number;
  j: number;
  k: number;
  /** Body id of the cube now in the cell, or -1 to empty it. */
  id: number;
  /** The cube's rotation in the cell (one of the 24 cube symmetries); set whenever id >= 0. */
  rot?: Quat;
}

/** The scene-wide settings a host simulates with; frictionCombine applies to every contact, lattice cells and ground included. */
export type HostWorld = Pick<SceneDesc, 'gravity' | 'dt' | 'ground' | 'sleep' | 'frictionCombine'>;

/** A change of mode or state for one body, applied before the next step. */
export interface ModeChange {
  id: number;
  mode: BodyMode;
  /** Pose to put the body at. Required when it was off; optional otherwise (keeps its pose). */
  pos?: Vec3;
  rot?: Quat;
  /** Velocity for a dynamic body. Default: unchanged, or zero when it was not dynamic. */
  linVel?: Vec3;
  angVel?: Vec3;
  /**
   * Normal force through the body's bottom face in newtons (the weight of
   * the stack it carries plus its own), so a woken stack can start in
   * equilibrium instead of sagging. A hint; hosts may ignore it.
   */
  restLoad?: number;
}

export interface HostBatch {
  /** Ids ascending, each at most once. */
  changes: ModeChange[];
  /** Dynamic bodies to wake (asleep bodies next to something that changed). */
  wake: number[];
  /** Native lattice cells to fill or empty (latticeNative hosts only); applied before `changes`. */
  cells?: CellChange[];
}

/** Summed contact forces on static bodies over one step. */
export interface StaticContacts {
  /** Static bodies that had contacts, ascending. */
  ids: Int32Array;
  /** 3 per id: net force on the static body, N (world frame). */
  force: Float64Array;
  /** 1 per id: sum of contact normal force magnitudes, N (a wedge shows up as magnitude >> |force|). */
  magnitude: Float64Array;
}

export interface HostState {
  /** The step these states are for (steps taken when they were sampled). */
  step: number;
  /** Dynamic bodies, ascending. */
  ids: Int32Array;
  pos: Float64Array; // 3 per id
  rot: Float64Array; // 4 per id
  linVel: Float64Array; // 3 per id
  angVel: Float64Array; // 3 per id
  awake: Uint8Array; // 1 per id
  /** Present when caps.contactForces. */
  contacts?: StaticContacts;
}

export interface PhysicsHost {
  readonly info: EngineInfo;
  readonly caps: HostCaps;
  /**
   * `table` describes every id the run can use (shape, material, initial
   * state); all start off. Ids that start in a lattice cell are at that
   * cell's exact pose (centre and CellChange rot). `lattices` are the
   * frames native cells live in (ignored unless caps.latticeNative); they
   * start empty.
   */
  init(world: HostWorld, table: readonly BodyDesc[], lattices?: readonly HostLattice[]): Promise<void>;
  /** Throws on an invalid batch (unknown id, off without a pose) and applies nothing. */
  apply(batch: HostBatch): void;
  /** Advance one fixed step. */
  step(): StepReport | void | Promise<StepReport | void>;
  /** Exactly the state of step (steps taken - caps.stateLag); see HostState. */
  read(): HostState | Promise<HostState>;
  /** Current state of every dynamic body, exact (for snapshots; never in a timed region). */
  current(): HostState | Promise<HostState>;
  /** MODE_STATIC for a body in a native lattice cell. */
  modeOf(id: number): BodyMode;
  dispose(): void;
}

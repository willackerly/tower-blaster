// CPU baseline: Rapier (WASM, SIMD build, single thread) behind the engine
// contract. Used as a reference for quality metrics and as the number every
// GPU variant has to beat by a wide margin.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { type BodyDesc, emptySnapshot, type EngineInfo, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { createBody, createGround, initRapier } from './bodies.ts';

export interface RapierOptions {
  /** Solver iterations per step; Rapier's default is 4. */
  iterations?: number;
}

export class RapierEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  private world: RAPIER.World | null = null;
  private bodies: RAPIER.RigidBody[] = [];
  private pending: InputEvent[] = [];
  private sleep = true;

  constructor(private readonly opts: RapierOptions = {}) {
    this.info = { name: 'rapier', variant: { version: 'uninitialised', iterations: opts.iterations ?? 4 }, backend: 'wasm-simd-st' };
  }

  async init(scene: SceneDesc): Promise<void> {
    await initRapier();
    this.info.variant.version = RAPIER.version();
    this.dispose();
    const world = new RAPIER.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] });
    world.timestep = scene.dt;
    if (this.opts.iterations) world.numSolverIterations = this.opts.iterations;
    if (scene.ground) createGround(world, scene.ground);
    this.world = world;
    this.sleep = scene.sleep;
    this.bodies = [];
    for (const b of scene.bodies) this.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
  }

  private add(b: BodyDesc): void {
    this.bodies.push(createBody(this.world!, b, this.sleep, RAPIER.RigidBodyDesc.dynamic()).body);
  }

  step(): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) this.add(this.pending.shift()!.body);
    w.step();
    this.stepIndex++;
  }

  snapshot(): Snapshot {
    const s = emptySnapshot(this.bodies.length);
    this.bodies.forEach((rb, i) => {
      const p = rb.translation(), q = rb.rotation(), v = rb.linvel(), a = rb.angvel();
      s.pos.set([p.x, p.y, p.z], 3 * i);
      s.rot.set([q.x, q.y, q.z, q.w], 4 * i);
      s.linVel.set([v.x, v.y, v.z], 3 * i);
      s.angVel.set([a.x, a.y, a.z], 3 * i);
      s.awake[i] = rb.isSleeping() ? 0 : 1;
    });
    return s;
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
    this.bodies = [];
  }
}

export { RapierHost } from './host.ts';
export { createBody, createGround, initRapier } from './bodies.ts';

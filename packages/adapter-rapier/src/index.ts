// CPU baseline: Rapier (WASM, SIMD build, single thread) behind the engine
// contract. Used as a reference for quality metrics and as the number every
// GPU variant has to beat by a wide margin.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { type BodyDesc, type CombineRule, emptySnapshot, type EngineInfo, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';

export interface RapierOptions {
  /** Solver iterations per step; Rapier's default is 4. */
  iterations?: number;
}

const RULES: Record<CombineRule, RAPIER.CoefficientCombineRule> = {
  average: RAPIER.CoefficientCombineRule.Average,
  min: RAPIER.CoefficientCombineRule.Min,
  max: RAPIER.CoefficientCombineRule.Max,
  multiply: RAPIER.CoefficientCombineRule.Multiply,
};

let ready: Promise<void> | null = null;
const initRapier = () => (ready ??= RAPIER.init());

export class RapierEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  private world: RAPIER.World | null = null;
  private bodies: RAPIER.RigidBody[] = [];
  private pending: InputEvent[] = [];
  private sleep = true;
  private combine = RAPIER.CoefficientCombineRule.Average;

  constructor(private readonly opts: RapierOptions = {}) {
    // Rapier takes one substep per solver iteration.
    this.info = { name: 'rapier', variant: { version: 'uninitialised', iterations: opts.iterations ?? 4 }, backend: 'wasm-simd-st', integrator: { substeps: opts.iterations ?? 4 } };
  }

  async init(scene: SceneDesc): Promise<void> {
    await initRapier();
    this.info.variant.version = RAPIER.version();
    this.dispose();
    const world = new RAPIER.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] });
    world.timestep = scene.dt;
    if (this.opts.iterations) world.numSolverIterations = this.opts.iterations;
    this.combine = RULES[scene.frictionCombine ?? 'average'];
    if (scene.ground) {
      world.createCollider(
        RAPIER.ColliderDesc.cuboid(1e4, 0.5, 1e4).setTranslation(0, scene.ground.y - 0.5, 0).setFriction(scene.ground.friction).setFrictionCombineRule(this.combine),
      );
    }
    this.world = world;
    this.sleep = scene.sleep;
    this.bodies = [];
    for (const b of scene.bodies) this.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
  }

  private add(b: BodyDesc): void {
    const w = this.world!;
    const desc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(b.pos[0], b.pos[1], b.pos[2])
      .setRotation({ x: b.rot[0], y: b.rot[1], z: b.rot[2], w: b.rot[3] })
      .setLinvel(b.linVel[0], b.linVel[1], b.linVel[2])
      .setAngvel({ x: b.angVel[0], y: b.angVel[1], z: b.angVel[2] })
      .setCanSleep(this.sleep)
      // Fast balls tunnel without continuous collision detection.
      .setCcdEnabled(b.shape.kind === 'sphere');
    const rb = w.createRigidBody(desc);
    const col = b.shape.kind === 'box'
      ? RAPIER.ColliderDesc.cuboid(b.shape.half[0], b.shape.half[1], b.shape.half[2])
      : RAPIER.ColliderDesc.ball(b.shape.radius);
    // Every collider carries the scene's rule (Rapier uses the higher-priority rule of a pair).
    w.createCollider(col.setDensity(b.density).setFriction(b.friction).setFrictionCombineRule(this.combine).setRestitution(b.restitution), rb);
    this.bodies.push(rb);
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

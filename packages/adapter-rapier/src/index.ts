// CPU baseline: Rapier (WASM, SIMD build, single thread) behind the engine
// contract. Used as a reference for quality metrics and as the number every
// GPU variant has to beat by a wide margin.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { blastArea, blastKick, type BodyDesc, checkBlast, DEFAULT_RESTITUTION_COMBINE, emptySnapshot, type EngineInfo, type InputEvent, massOf, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { createBody, createGround, initRapier, RULES } from './bodies.ts';

export interface RapierOptions {
  /** Solver iterations per step; Rapier's default is 4. */
  iterations?: number;
}

export class RapierEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  private world: RAPIER.World | null = null;
  private bodies: RAPIER.RigidBody[] = [];
  /** Each body's description, for blasts. */
  private descs: BodyDesc[] = [];
  private pending: InputEvent[] = [];
  private sleep = true;
  private combine = RAPIER.CoefficientCombineRule.Average;
  private restitutionCombine = RAPIER.CoefficientCombineRule.Average;

  constructor(private readonly opts: RapierOptions = {}) {
    // Rapier takes one substep per solver iteration.
    this.info = { name: 'rapier', variant: { version: 'uninitialised', iterations: opts.iterations ?? 4 }, backend: 'wasm-simd-st', integrator: { substeps: opts.iterations ?? 4 } };
  }

  async init(scene: SceneDesc): Promise<void> {
    for (const ev of scene.inputs) if (ev.kind === 'blast') checkBlast(ev.blast);
    await initRapier();
    this.info.variant.version = RAPIER.version();
    this.dispose();
    const world = new RAPIER.World({ x: scene.gravity[0], y: scene.gravity[1], z: scene.gravity[2] });
    world.timestep = scene.dt;
    if (this.opts.iterations) world.numSolverIterations = this.opts.iterations;
    this.combine = RULES[scene.frictionCombine ?? 'average'];
    this.restitutionCombine = RULES[scene.restitutionCombine ?? DEFAULT_RESTITUTION_COMBINE];
    if (scene.ground) {
      const ground = createGround(world, scene.ground);
      ground.setFrictionCombineRule(this.combine);
      ground.setRestitutionCombineRule(this.restitutionCombine);
    }
    this.world = world;
    this.sleep = scene.sleep;
    this.bodies = [];
    this.descs = [];
    for (const b of scene.bodies) this.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
  }

  private add(b: BodyDesc): void {
    const { body, collider } = createBody(this.world!, b, this.sleep, RAPIER.RigidBodyDesc.dynamic());
    // Every collider carries the scene's rules (Rapier uses the higher-priority rule of a pair).
    collider.setFrictionCombineRule(this.combine);
    collider.setRestitutionCombineRule(this.restitutionCombine);
    this.bodies.push(body);
    this.descs.push(b);
  }

  push(events: InputEvent[]): void {
    for (const ev of events) if (ev.kind === 'blast') checkBlast(ev.blast);
    // Stable insertion keeps push order among events due at the same step.
    for (const ev of events) {
      let i = this.pending.length;
      while (i > 0 && this.pending[i - 1]!.step > ev.step) i--;
      this.pending.splice(i, 0, ev);
    }
  }

  step(): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) {
      const ev = this.pending.shift()!;
      if (ev.kind === 'spawn') { this.add(ev.body); continue; }
      // A blast (engine-api blast.ts): mass and volume from the description, as the AVBD engines.
      const b = checkBlast(ev.blast);
      this.bodies.forEach((rb, id) => {
        const p = rb.translation(), d = this.descs[id]!;
        const dv = blastKick(b, id, [p.x, p.y, p.z], massOf(d), blastArea(d.shape));
        if (!dv) return;
        const v = rb.linvel();
        rb.setLinvel({ x: v.x + dv[0], y: v.y + dv[1], z: v.z + dv[2] }, true);
      });
    }
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
export { createBody, createGround, icosphere, initRapier, RULES } from './bodies.ts';

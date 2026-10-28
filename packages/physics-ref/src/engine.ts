// The reference AVBD solver behind the engine contract.
import { blastArea, blastKick, checkBlast, emptySnapshot, type EngineInfo, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { type AvbdParams, avbdVariant, AvbdWorld, checkColoring, checkGapSlop, checkRecords, checkRemoved, checkRestitution, DEFAULT_AVBD } from './avbd.ts';

export class AvbdReferenceEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  world: AvbdWorld | null = null;
  private pending: InputEvent[] = [];
  private readonly params: AvbdParams;

  constructor(params: Partial<AvbdParams> = {}) {
    this.params = { ...DEFAULT_AVBD, ...params };
    checkRestitution(this.params);
    checkGapSlop(this.params);
    checkRemoved(this.params);
    checkRecords(this.params);
    checkColoring(this.params);
    // Every param, but an opt-in switch (restitution, gapSlop, records, colorMode, colorPriority) and its params only while it is on (avbdVariant).
    const variant = avbdVariant(this.params);
    // Free flight converges to the inertial target x + h v + h^2 g: one semi-implicit Euler step.
    this.info = { name: 'avbd-ref', variant, backend: 'js-f64', integrator: { substeps: 1 } };
  }

  async init(scene: SceneDesc): Promise<void> {
    const e = scene.ground?.restitution;
    if (e !== undefined && !(e >= 0 && e <= 1)) throw new Error(`AvbdReferenceEngine: SceneDesc.ground.restitution must be in [0, 1], got ${e}`);
    for (const ev of scene.inputs) if (ev.kind === 'blast') checkBlast(ev.blast);
    this.world = new AvbdWorld(scene, this.params);
    for (const b of scene.bodies) this.world.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
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
      if (ev.kind === 'spawn') { w.add(ev.body); continue; }
      // A blast (blast.ts) pushes the bodies that exist now, before the step starts.
      const b = checkBlast(ev.blast);
      w.bodies.forEach((body, id) => {
        const dv = blastKick(b, id, body.pos, body.mass, blastArea(body.desc.shape));
        if (!dv) return;
        body.linVel = [body.linVel[0] + dv[0], body.linVel[1] + dv[1], body.linVel[2] + dv[2]];
        // The adaptive warm start compares linVel with prevLinVel: the kick is not an acceleration (blast.ts).
        body.prevLinVel = [body.prevLinVel[0] + dv[0], body.prevLinVel[1] + dv[1], body.prevLinVel[2] + dv[2]];
      });
    }
    w.step();
    this.stepIndex++;
  }

  snapshot(): Snapshot {
    const bodies = this.world?.bodies ?? [];
    const s = emptySnapshot(bodies.length);
    bodies.forEach((b, i) => {
      s.pos.set(b.pos, 3 * i);
      s.rot.set(b.rot, 4 * i);
      s.linVel.set(b.linVel, 3 * i);
      s.angVel.set(b.angVel, 3 * i);
      s.awake[i] = 1; // no sleeping yet
    });
    return s;
  }

  dispose(): void {
    this.world = null;
  }
}

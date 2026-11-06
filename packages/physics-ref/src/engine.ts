// The reference AVBD solver behind the engine contract.
import { blastArea, blastCentre, blastVelocity, type BodyMotion, checkBlast, checkInputQueue, emptySnapshot, queueInputs, relativeBody, TIER_FREE, type EngineInfo, type InputEvent, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
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
    const pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    checkInputQueue(scene.bodies.length, pending);
    this.world = new AvbdWorld(scene, this.params);
    for (const b of scene.bodies) this.world.add(b);
    this.pending = pending;
    this.stepIndex = 0;
  }

  push(events: InputEvent[]): void {
    // Stable insertion keeps push order among events due at the same step; checked before anything changes.
    const pending = queueInputs(this.pending, events);
    checkInputQueue(this.world?.bodies.length ?? 0, pending, this.removed(), this.stepIndex);
    this.pending = pending;
  }

  step(): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    const due: InputEvent[] = [];
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) due.push(this.pending.shift()!);
    // A relative spawn reads its parent as the step starts, before any of the step's events (engine-api spawn.ts).
    const parents = new Map<number, BodyMotion>();
    for (const ev of due) {
      if (ev.kind !== 'spawn' || !ev.from || parents.has(ev.from.body)) continue;
      const b = w.bodies[ev.from.body]!;
      parents.set(ev.from.body, { pos: [...b.pos], rot: [...b.rot], linVel: [...b.linVel], angVel: [...b.angVel] });
    }
    for (const ev of due) {
      if (ev.kind === 'spawn') { w.add(ev.from ? relativeBody(parents.get(ev.from.body)!, ev.body, ev.from.axes) : ev.body); continue; }
      // A removal (remove.ts): the body touches nothing from this step on.
      if (ev.kind === 'remove') { w.remove(ev.id); continue; }
      // A blast (blast.ts) pushes the bodies that exist now, before the step starts; never a removed one.
      const b = checkBlast(ev.blast);
      const centre = blastCentre(b, b.body >= 0 ? w.bodies[b.body]!.pos : null);
      w.bodies.forEach((body, id) => {
        if (body.removed) return;
        const v = blastVelocity(b, centre, id, body.pos, body.linVel, body.mass, blastArea(body.desc.shape));
        if (!v) return;
        // The adaptive warm start compares linVel with prevLinVel: the kick is not an acceleration (blast.ts).
        const p = body.prevLinVel, u = body.linVel;
        body.prevLinVel = [p[0] + (v[0] - u[0]), p[1] + (v[1] - u[1]), p[2] + (v[2] - u[2])];
        body.linVel = v;
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
      s.awake[i] = b.removed ? 0 : 1; // no sleeping yet
    });
    // Tiers only once a body is removed (Snapshot.tier: absent, every body is active).
    if (bodies.some((b) => b.removed)) s.tier = Uint8Array.from(bodies, (b) => (b.removed ? TIER_FREE : 0));
    return s;
  }

  /** The ids of removed bodies (remove.ts). */
  private removed(): Set<number> {
    const out = new Set<number>();
    this.world?.bodies.forEach((b, i) => { if (b.removed) out.add(i); });
    return out;
  }

  dispose(): void {
    this.world = null;
  }
}

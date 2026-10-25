// Rapier as the active-set host under the world tiers (see
// @tb/engine-api host.ts). Bodies are created the first time an id is
// switched on and then only enabled, disabled or retyped, so a cell that
// wakes keeps its Rapier body and contacts.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import {
  type BodyDesc, type BodyMode, type EngineInfo, type HostBatch, type HostCaps, type HostState, type HostWorld,
  MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type PhysicsHost,
} from '@tb/engine-api';
import { createBody, createGround, initRapier } from './bodies.ts';
import type { RapierOptions } from './index.ts';

export class RapierHost implements PhysicsHost {
  readonly info: EngineInfo;
  caps: HostCaps = { capacity: 0, stateLag: 0, contactForces: true };
  private world: RAPIER.World | null = null;
  private table: readonly BodyDesc[] = [];
  private bodies: Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider } | undefined> = [];
  private modes = new Uint8Array(0);
  private dynamicIds: number[] = [];
  private staticIds: number[] = [];
  private idsDirty = false;
  private sleep = true;
  private dt = 1 / 60;
  private steps = 0;

  constructor(private readonly opts: RapierOptions = {}) {
    this.info = { name: 'rapier-host', variant: { version: 'uninitialised', iterations: opts.iterations ?? 4 }, backend: 'wasm-simd-st' };
  }

  async init(world: HostWorld, table: readonly BodyDesc[]): Promise<void> {
    await initRapier();
    this.info.variant.version = RAPIER.version();
    this.dispose();
    const w = new RAPIER.World({ x: world.gravity[0], y: world.gravity[1], z: world.gravity[2] });
    w.timestep = world.dt;
    if (this.opts.iterations) w.numSolverIterations = this.opts.iterations;
    if (world.ground) createGround(w, world.ground);
    this.world = w;
    this.table = table;
    this.bodies = new Array(table.length);
    this.modes = new Uint8Array(table.length);
    this.caps = { ...this.caps, capacity: table.length };
    this.sleep = world.sleep;
    this.dt = world.dt;
    this.steps = 0;
    this.dynamicIds = [];
    this.staticIds = [];
  }

  modeOf(id: number): BodyMode { return this.modes[id] as BodyMode; }

  apply(batch: HostBatch): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    // Validate everything before touching the world, so a bad batch changes nothing.
    let last = -1;
    for (const c of batch.changes) {
      if (!(c.id >= 0 && c.id < this.table.length)) throw new Error(`id ${c.id} outside capacity ${this.table.length}`);
      if (c.id <= last) throw new Error('changes must have ascending, unique ids');
      last = c.id;
      if (c.mode !== MODE_OFF && this.modes[c.id] === MODE_OFF && (!c.pos || !c.rot)) throw new Error(`id ${c.id} is off: switching it on needs a pose`);
    }
    for (const id of batch.wake) if (this.modes[id] !== MODE_DYNAMIC && !batch.changes.some((c) => c.id === id && c.mode === MODE_DYNAMIC)) {
      throw new Error(`wake: id ${id} is not dynamic`);
    }
    for (const c of batch.changes) {
      const prev = this.modes[c.id]!;
      if (c.mode === prev && !c.pos && !c.linVel && !c.angVel) continue;
      this.idsDirty ||= c.mode !== prev;
      this.modes[c.id] = c.mode;
      if (c.mode === MODE_OFF) {
        this.bodies[c.id]?.body.setEnabled(false);
        continue;
      }
      let entry = this.bodies[c.id];
      const type = c.mode === MODE_STATIC ? RAPIER.RigidBodyType.Fixed : RAPIER.RigidBodyType.Dynamic;
      if (!entry) {
        const desc = c.mode === MODE_STATIC ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic();
        entry = this.bodies[c.id] = createBody(w, { ...this.table[c.id]!, pos: c.pos!, rot: c.rot!, linVel: [0, 0, 0], angVel: [0, 0, 0] }, this.sleep, desc);
      } else {
        if (prev === MODE_OFF) entry.body.setEnabled(true);
        if (entry.body.bodyType() !== type) entry.body.setBodyType(type, true);
      }
      const rb = entry.body;
      if (c.pos) rb.setTranslation({ x: c.pos[0], y: c.pos[1], z: c.pos[2] }, true);
      if (c.rot) rb.setRotation({ x: c.rot[0], y: c.rot[1], z: c.rot[2], w: c.rot[3] }, true);
      if (c.mode === MODE_DYNAMIC) {
        const v = c.linVel ?? (prev === MODE_DYNAMIC ? null : [0, 0, 0]);
        const a = c.angVel ?? (prev === MODE_DYNAMIC ? null : [0, 0, 0]);
        if (v) rb.setLinvel({ x: v[0], y: v[1], z: v[2] }, true);
        if (a) rb.setAngvel({ x: a[0], y: a[1], z: a[2] }, true);
        rb.wakeUp();
      }
    }
    for (const id of batch.wake) this.bodies[id]!.body.wakeUp();
  }

  step(): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    w.step();
    this.steps++;
  }

  private refreshIds(): void {
    if (!this.idsDirty) return;
    this.dynamicIds = [];
    this.staticIds = [];
    this.modes.forEach((m, id) => {
      if (m === MODE_DYNAMIC) this.dynamicIds.push(id);
      else if (m === MODE_STATIC) this.staticIds.push(id);
    });
    this.idsDirty = false;
  }

  read(): HostState {
    const s = this.current();
    s.contacts = this.staticContacts();
    return s;
  }

  current(): HostState {
    this.refreshIds();
    const ids = this.dynamicIds, n = ids.length;
    const s: HostState = {
      step: this.steps, ids: Int32Array.from(ids),
      pos: new Float64Array(3 * n), rot: new Float64Array(4 * n), linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n),
    };
    for (let i = 0; i < n; i++) {
      const rb = this.bodies[ids[i]!]!.body;
      const p = rb.translation(), q = rb.rotation(), v = rb.linvel(), a = rb.angvel();
      s.pos[3 * i] = p.x; s.pos[3 * i + 1] = p.y; s.pos[3 * i + 2] = p.z;
      s.rot[4 * i] = q.x; s.rot[4 * i + 1] = q.y; s.rot[4 * i + 2] = q.z; s.rot[4 * i + 3] = q.w;
      s.linVel[3 * i] = v.x; s.linVel[3 * i + 1] = v.y; s.linVel[3 * i + 2] = v.z;
      s.angVel[3 * i] = a.x; s.angVel[3 * i + 1] = a.y; s.angVel[3 * i + 2] = a.z;
      s.awake[i] = rb.isSleeping() ? 0 : 1;
    }
    return s;
  }

  /**
   * Net contact force on each static body over the last step, from the
   * normal impulses of its manifolds. Rapier does not expose the tangent
   * basis of its friction impulses, so friction drag along a face is not
   * included (a known gap: the tiers only need pushes into faces).
   */
  private staticContacts() {
    const w = this.world!;
    const ids: number[] = [], force: number[] = [], magnitude: number[] = [];
    for (const id of this.staticIds) {
      const col = this.bodies[id]!.collider;
      let fx = 0, fy = 0, fz = 0, mag = 0;
      w.contactPairsWith(col, (other) => {
        w.contactPair(col, other, (m, flipped) => {
          const n = m.normal();
          // The normal points out of the first collider of the manifold; the
          // other body pushes the static one against it.
          const sgn = flipped ? 1 : -1;
          for (let i = 0; i < m.numContacts(); i++) {
            const f = m.contactImpulse(i) / this.dt;
            if (!(f > 0)) continue;
            fx += sgn * f * n.x; fy += sgn * f * n.y; fz += sgn * f * n.z;
            mag += f;
          }
        });
      });
      if (mag > 0) { ids.push(id); force.push(fx, fy, fz); magnitude.push(mag); }
    }
    return { ids: Int32Array.from(ids), force: Float64Array.from(force), magnitude: Float64Array.from(magnitude) };
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
    this.bodies = [];
  }
}

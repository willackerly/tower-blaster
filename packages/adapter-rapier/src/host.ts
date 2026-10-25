// Rapier as the active-set host under the world tiers (see
// @tb/engine-api host.ts). Bodies are created the first time an id is
// switched on and then only enabled, disabled or retyped. Lattices are
// native: one voxel collider per lattice, so dormant towers have no internal
// seams for sliding cubes to catch on, and a dormant tower is a single
// broadphase entry however many cubes it holds.
import RAPIER from '@dimforge/rapier3d-simd-compat';
import {
  type BodyDesc, type BodyMode, type EngineInfo, type HostBatch, type HostCaps, type HostLattice, type HostState, type HostWorld,
  MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type PhysicsHost, type Quat, type Vec3,
} from '@tb/engine-api';
import { boundingRadius, signedDepth } from '@tb/geom';
import { createBody, createGround, initRapier, RULES } from './bodies.ts';
import type { RapierOptions } from './index.ts';

/** Spheres are icosphere hulls (162 vertices), since they meet voxels here: see createBody. */
const SPHERE_HULL = 2;

export class RapierHost implements PhysicsHost {
  readonly info: EngineInfo;
  caps: HostCaps = { capacity: 0, stateLag: 0, contactForces: true, latticeNative: true };
  private world: RAPIER.World | null = null;
  private table: readonly BodyDesc[] = [];
  private bodies: Array<{ body: RAPIER.RigidBody; collider: RAPIER.Collider } | undefined> = [];
  private modes = new Uint8Array(0);
  /** 1 while an id sits in a native lattice cell. */
  private inCell = new Uint8Array(0);
  private dynamicIds: number[] = [];
  private staticIds: number[] = [];
  private idsDirty = false;
  private sleep = true;
  private dt = 1 / 60;
  private combine = RAPIER.CoefficientCombineRule.Average;
  private steps = 0;
  private lattices: Array<HostLattice & { cells: Int32Array; collider: RAPIER.Collider | null }> = [];
  private events: RAPIER.EventQueue | null = null;
  /** Collider handle -> lattice index, for voxel colliders. */
  private voxelOf = new Map<number, number>();
  private bodyOfCollider = new Map<number, number>();
  private voxelForces: Array<{ lattice: number; body: number; force: Vec3; magnitude: number }> = [];

  constructor(private readonly opts: RapierOptions = {}) {
    this.info = { name: 'rapier-host', variant: { version: 'uninitialised', iterations: opts.iterations ?? 4, sphereHull: SPHERE_HULL }, backend: 'wasm-simd-st' };
  }

  async init(world: HostWorld, table: readonly BodyDesc[], lattices: readonly HostLattice[] = []): Promise<void> {
    await initRapier();
    this.info.variant.version = RAPIER.version();
    this.dispose();
    const w = new RAPIER.World({ x: world.gravity[0], y: world.gravity[1], z: world.gravity[2] });
    w.timestep = world.dt;
    if (this.opts.iterations) w.numSolverIterations = this.opts.iterations;
    // Every collider carries the scene's friction rule: bodies, ground and voxel lattices.
    this.combine = RULES[world.frictionCombine ?? 'average'];
    if (world.ground) createGround(w, world.ground).setFrictionCombineRule(this.combine);
    this.world = w;
    this.table = table;
    this.bodies = new Array(table.length);
    this.modes = new Uint8Array(table.length);
    this.inCell = new Uint8Array(table.length);
    this.caps = { ...this.caps, capacity: table.length };
    this.sleep = world.sleep;
    this.dt = world.dt;
    this.steps = 0;
    this.dynamicIds = [];
    this.staticIds = [];
    this.events = new RAPIER.EventQueue(true);
    this.voxelOf = new Map();
    this.bodyOfCollider = new Map();
    this.voxelForces = [];
    this.lattices = lattices.map((l) => ({ ...l, cells: new Int32Array(l.dims[0] * l.dims[1] * l.dims[2]).fill(-1), collider: null }));
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
      if (c.mode !== MODE_OFF && !this.bodies[c.id] && (!c.pos || !c.rot)) throw new Error(`id ${c.id} has no body yet: switching it on needs a pose`);
    }
    for (const id of batch.wake) if (this.modes[id] !== MODE_DYNAMIC && !batch.changes.some((c) => c.id === id && c.mode === MODE_DYNAMIC)) {
      throw new Error(`wake: id ${id} is not dynamic`);
    }
    for (const c of batch.cells ?? []) {
      const l = this.lattices[c.lattice];
      if (!l) throw new Error(`cell change for unknown lattice ${c.lattice}`);
      if (!(c.i >= 0 && c.j >= 0 && c.k >= 0 && c.i < l.dims[0] && c.j < l.dims[1] && c.k < l.dims[2])) throw new Error(`cell ${c.i},${c.j},${c.k} outside lattice ${c.lattice}`);
      if (c.id >= this.table.length) throw new Error(`cell id ${c.id} outside capacity`);
    }
    this.applyCells(batch.cells ?? []);
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
        entry = this.bodies[c.id] = createBody(w, { ...this.table[c.id]!, pos: c.pos!, rot: c.rot!, linVel: [0, 0, 0], angVel: [0, 0, 0] }, this.sleep, desc, SPHERE_HULL);
        entry.collider.setFrictionCombineRule(this.combine);
        this.bodyOfCollider.set(entry.collider.handle, c.id);
      } else {
        if (prev === MODE_OFF) entry.body.setEnabled(true);
        // Freezing in place wakes nothing: a static body that does not move
        // disturbs no contact, and waking its island would keep piles awake.
        if (entry.body.bodyType() !== type) entry.body.setBodyType(type, c.mode === MODE_DYNAMIC);
      }
      const rb = entry.body;
      // A body put at the pose it already has is left alone: setRotation
      // renormalises, which moved 17% of quaternions by an f32 ulp, and a
      // collapse amplifies that (one S5 shot froze 310 cubes instead of 740).
      if (c.pos && !sameF32(rb.translation(), c.pos)) rb.setTranslation({ x: c.pos[0], y: c.pos[1], z: c.pos[2] }, true);
      if (c.rot && !sameF32(rb.rotation(), c.rot)) rb.setRotation({ x: c.rot[0], y: c.rot[1], z: c.rot[2], w: c.rot[3] }, true);
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

  private cellIndex(l: HostLattice, i: number, j: number, k: number) { return (k * l.dims[0] + i) * l.dims[1] + j; }

  private applyCells(cells: readonly NonNullable<HostBatch['cells']>[number][]): void {
    const w = this.world!;
    const byLattice = new Map<number, typeof cells[number][]>();
    for (const c of cells) {
      const list = byLattice.get(c.lattice);
      if (list) list.push(c); else byLattice.set(c.lattice, [c]);
    }
    for (const [li, list] of byLattice) {
      const l = this.lattices[li]!;
      if (!l.collider) {
        // Created on first use with its whole domain: the corners are filled and
        // then cleared unless the batch fills them, so later fills stay inside.
        const [nx, ny, nz] = l.dims;
        const data = new Int32Array([0, 0, 0, nx - 1, ny - 1, nz - 1]);
        l.collider = w.createCollider(
          RAPIER.ColliderDesc.voxels(data, { x: l.edge, y: l.edge, z: l.edge })
            .setTranslation(l.origin[0] - l.edge / 2, l.origin[1] - l.edge / 2, l.origin[2] - l.edge / 2)
            .setFriction(l.friction)
            .setFrictionCombineRule(this.combine)
            .setActiveEvents(RAPIER.ActiveEvents.CONTACT_FORCE_EVENTS)
            .setContactForceEventThreshold(0),
        );
        this.voxelOf.set(l.collider.handle, li);
        l.collider.setVoxel(0, 0, 0, false);
        l.collider.setVoxel(nx - 1, ny - 1, nz - 1, false);
      }
      for (const c of list) {
        const n = this.cellIndex(l, c.i, c.j, c.k);
        const prev = l.cells[n]!;
        if (prev >= 0) { this.inCell[prev] = 0; if (this.modes[prev] === MODE_STATIC) this.modes[prev] = MODE_OFF; }
        l.cells[n] = c.id;
        if (c.id >= 0) {
          // A body that settles into a cell leaves the solver.
          this.bodies[c.id]?.body.setEnabled(false);
          this.modes[c.id] = MODE_STATIC;
          this.inCell[c.id] = 1;
        }
        l.collider.setVoxel(c.i, c.j, c.k, c.id >= 0);
        this.idsDirty = true;
      }
    }
  }

  step(): void {
    const w = this.world;
    if (!w) throw new Error('init() first');
    const q = this.events!;
    w.step(q);
    this.voxelForces = [];
    q.drainContactForceEvents((ev) => {
      const h1 = ev.collider1(), h2 = ev.collider2();
      const l1 = this.voxelOf.get(h1), l2 = this.voxelOf.get(h2);
      if ((l1 === undefined) === (l2 === undefined)) return;
      const lattice = (l1 ?? l2)!, other = l1 === undefined ? h1 : h2;
      const body = this.bodyOfCollider.get(other);
      if (body === undefined) return;
      // totalForce acts on collider2; the lattice gets the opposite when it is collider1.
      const f = ev.totalForce(), sgn = l1 === undefined ? 1 : -1;
      this.voxelForces.push({ lattice, body, force: [sgn * f.x, sgn * f.y, sgn * f.z], magnitude: ev.totalForceMagnitude() });
    });
    this.steps++;
  }

  /** Ids of native cells within a small distance of a body's shape. */
  private touchedCells(l: HostLattice & { cells: Int32Array }, desc: BodyDesc, rb: RAPIER.RigidBody): number[] {
    const p = rb.translation(), q = rb.rotation();
    const pos: Vec3 = [p.x, p.y, p.z], rot: Quat = [q.x, q.y, q.z, q.w];
    const r = boundingRadius(desc.shape) + 0.05 * l.edge, e = l.edge, h = e / 2;
    const lo = (a: number) => Math.max(0, Math.ceil((pos[a]! - r - l.origin[a]!) / e - 0.5));
    const hi = (a: number) => Math.min(l.dims[a]! - 1, Math.floor((pos[a]! + r - l.origin[a]!) / e + 0.5));
    const out: number[] = [];
    for (let k = lo(2); k <= hi(2); k++)
      for (let i = lo(0); i <= hi(0); i++)
        for (let j = lo(1); j <= hi(1); j++) {
          const id = l.cells[this.cellIndex(l, i, j, k)]!;
          if (id < 0) continue;
          const c: Vec3 = [l.origin[0] + i * e, l.origin[1] + j * e, l.origin[2] + k * e];
          if (signedDepth(desc.shape, pos, rot, { kind: 'box', half: [h, h, h] }, c, [0, 0, 0, 1]) > -0.05 * e) out.push(id);
        }
    return out.sort((a, b) => a - b);
  }

  private refreshIds(): void {
    if (!this.idsDirty) return;
    this.dynamicIds = [];
    this.staticIds = [];
    this.modes.forEach((m, id) => {
      if (m === MODE_DYNAMIC) this.dynamicIds.push(id);
      else if (m === MODE_STATIC && !this.inCell[id]) this.staticIds.push(id);
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
    // Native lattice cells. Rapier reports no per-point impulses for voxel
    // manifolds, so each step's pair force (collider force events) is split
    // evenly over the cells the body touches.
    const perCell = new Map<number, [number, number, number, number]>();
    for (const ev of this.voxelForces) {
      const l = this.lattices[ev.lattice]!, entry = this.bodies[ev.body];
      if (!entry) continue;
      const touched = this.touchedCells(l, this.table[ev.body]!, entry.body);
      if (!touched.length) continue;
      const share = 1 / touched.length;
      for (const id of touched) {
        const acc = perCell.get(id) ?? [0, 0, 0, 0];
        acc[0] += share * ev.force[0]; acc[1] += share * ev.force[1]; acc[2] += share * ev.force[2]; acc[3] += share * ev.magnitude;
        perCell.set(id, acc);
      }
    }
    if (perCell.size) {
      const all = ids.map((id, n) => [id, force[3 * n]!, force[3 * n + 1]!, force[3 * n + 2]!, magnitude[n]!] as const);
      for (const [id, a] of perCell) all.push([id, a[0], a[1], a[2], a[3]]);
      all.sort((a, b) => a[0] - b[0]);
      ids.length = force.length = magnitude.length = 0;
      for (const r of all) { ids.push(r[0]); force.push(r[1], r[2], r[3]); magnitude.push(r[4]); }
    }
    return { ids: Int32Array.from(ids), force: Float64Array.from(force), magnitude: Float64Array.from(magnitude) };
  }

  dispose(): void {
    this.world?.free();
    this.world = null;
    this.events?.free();
    this.events = null;
    this.bodies = [];
    this.lattices = [];
  }
}

/** Whether Rapier's f32 pose `a` already equals `b` rounded to f32. */
function sameF32(a: { x: number; y: number; z: number; w?: number }, b: readonly number[]): boolean {
  return a.x === Math.fround(b[0]!) && a.y === Math.fround(b[1]!) && a.z === Math.fround(b[2]!) && (b.length < 4 || a.w === Math.fround(b[3]!));
}

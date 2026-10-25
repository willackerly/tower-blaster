import {
  type BodyDesc, type BodyMode, type HostBatch, type HostCaps, type HostState, type HostWorld, MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type PhysicsHost, type Vec3,
} from '@tb/engine-api';

/**
 * A host that simulates nothing: dynamic bodies stay at rest where they were
 * put, and each step reports the contact forces the test scripts. It isolates
 * the tier rules from solver noise.
 */
export class ScriptedHost implements PhysicsHost {
  readonly info = { name: 'scripted', variant: {}, backend: 'none' };
  caps: HostCaps = { capacity: 0, stateLag: 0, contactForces: true, latticeNative: true, localCellChanges: true };
  private modes: BodyMode[] = [];
  private pose = new Map<number, { pos: Vec3; rot: [number, number, number, number] }>();
  private steps = 0;
  /** Forces on static ids reported by the next read(). */
  next = new Map<number, Vec3>();
  /** Velocities reported for dynamic bodies (they still do not move). */
  vel = new Map<number, Vec3>();

  async init(_w: HostWorld, table: readonly BodyDesc[]): Promise<void> {
    this.caps = { ...this.caps, capacity: table.length };
    this.modes = table.map(() => MODE_OFF);
    table.forEach((b, id) => this.pose.set(id, { pos: b.pos, rot: b.rot }));
  }
  apply(batch: HostBatch): void {
    for (const c of batch.cells ?? []) if (c.id >= 0) this.modes[c.id] = MODE_STATIC;
    for (const c of batch.changes) {
      this.modes[c.id] = c.mode;
      if (c.linVel) this.vel.set(c.id, c.linVel);
      if (c.pos && c.rot) this.pose.set(c.id, { pos: c.pos, rot: c.rot });
    }
  }
  step(): void { this.steps++; }
  read(): HostState {
    const ids = this.modes.flatMap((m, id) => (m === MODE_DYNAMIC ? [id] : []));
    const n = ids.length;
    const pos = new Float64Array(3 * n), rot = new Float64Array(4 * n);
    const linVel = new Float64Array(3 * n);
    ids.forEach((id, k) => { const p = this.pose.get(id)!; pos.set(p.pos, 3 * k); rot.set(p.rot, 4 * k); linVel.set(this.vel.get(id) ?? [0, 0, 0], 3 * k); });
    const forced = [...this.next.keys()].sort((a, b) => a - b);
    const force = new Float64Array(3 * forced.length), magnitude = new Float64Array(forced.length);
    forced.forEach((id, k) => { const f = this.next.get(id)!; force.set(f, 3 * k); magnitude[k] = Math.hypot(...f); });
    this.next.clear();
    return {
      step: this.steps, ids: Int32Array.from(ids), pos, rot, linVel, angVel: new Float64Array(3 * n), awake: new Uint8Array(n).fill(1),
      contacts: { ids: Int32Array.from(forced), force, magnitude },
    };
  }
  current(): HostState { const next = this.next; this.next = new Map(); const s = this.read(); this.next = next; return s; }
  /** Move a body as if the solver had. */
  place(id: number, pos: Vec3): void { this.pose.set(id, { ...this.pose.get(id)!, pos }); }
  modeOf(id: number): BodyMode { return this.modes[id]!; }
  dispose(): void {}
}

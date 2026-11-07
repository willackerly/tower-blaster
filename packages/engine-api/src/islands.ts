// Many worlds in one solve (C10; docs/design/islands.md). K small worlds,
// each a SceneDesc of its own, run as islands of one scene: world k is
// translated to its island's offset on the ground plane, far enough from the
// others that no body of one ever touches a body of another. They share the
// engine, its steps, its colouring and its broadphase, never a contact. Probe
// X8 found that the islands' outcome distributions match solo runs' while each
// world is not bit-identical to its solo run on the GPU (docs/game/mode-probes.md).
//
// What this file owns, all pure TypeScript and engine-agnostic:
// - the layout: island 0 at the origin and the rest in square rings around it
//   (islandOffsets), a cell of side `gap` per island, the gap chosen from the
//   worlds' footprints plus a reach for debris;
// - the id map: the bodies of world k keep their order, and every event a
//   world sends (its scene's inputs, and push() during play) is in its own
//   local ids and coordinates; Islands releases them to the engine at the step
//   they are due (due()), translating positions and body ids, so a spawned
//   body's global id is known exactly when it is assigned;
// - reads per island: a world's own snapshot (local()), the bodies that have
//   left their cell (leaks()), island tags for the observer (tags()), and
//   world k alone at its island's position (solo()), the solo run nearest to
//   its island (X8's solo-far: within millimetres, not bit for bit);
// - the field schedule (C7: gravity steps, quakes, kicks), world-wide: the
//   islands share one solve, so they share its gravity and every kick, and a
//   field event is pushed once for all of them (pushField), never per island
//   (docs/design/gravity-and-pins.md).
import type { BodyDesc, FieldEvent, InputEvent, SceneDesc, ShapeDesc, Snapshot, Vec3 } from './index.ts';
import { queueInputs } from './blast.ts';
import { checkField } from './field.ts';

/** Most islands in one solve: the observer's per-island histogram has at most this many bins (OBSERVER_CAPS.maxBins). */
export const MAX_ISLANDS = 256;
/**
 * IslandOptions.reach when unset, m: room around a world's footprint for debris and a ball that flies on.
 * X8's wrecking ball (15 m/s into a 150-cube block) throws debris up to 21 m from the block's centre on
 * SwiftShader, about 17 m past its footprint; 24 m leaves a margin.
 */
export const DEFAULT_ISLAND_REACH = 24;

export interface IslandOptions {
  /** Centre-to-centre spacing of the islands, m. Default: 2 (footprint + reach), rounded up to a whole metre. Must leave reach >= 0. */
  gap?: number;
  /** How far beyond its starting footprint a world may spread, m (DEFAULT_ISLAND_REACH). Sets the default gap; point blasts must stay inside the footprint plus reach. */
  reach?: number;
}

/**
 * Island cells in the order islands take them: (0, 0), then square rings of
 * growing size, each ring by distance from the origin and then by (z, x).
 * Integer cell coordinates; island k sits at gap times its cell. Ring r holds
 * (2r + 1)^2 - (2r - 1)^2 cells, so K islands reach out to ring
 * ceil((sqrt K - 1) / 2): 64 islands reach ring 4 (an 8 x 8 grid centred on
 * the origin reaches 3.5 cells, the same f32 exponent for any gap from 37 to 63 m).
 */
export function islandCells(K: number): Array<[number, number]> {
  if (!Number.isInteger(K) || K < 1 || K > MAX_ISLANDS) throw new RangeError(`islands: K must be an integer from 1 to ${MAX_ISLANDS}, got ${K}`);
  const out: Array<[number, number]> = [];
  for (let r = 0; out.length < K; r++) {
    const ring: Array<[number, number]> = [];
    for (let z = -r; z <= r; z++) for (let x = -r; x <= r; x++) if (Math.max(Math.abs(x), Math.abs(z)) === r) ring.push([x + 0, z + 0]); // + 0: no -0 at the origin
    ring.sort((a, b) => a[0] * a[0] + a[1] * a[1] - (b[0] * b[0] + b[1] * b[1]) || a[1] - b[1] || a[0] - b[0]);
    out.push(...ring);
  }
  return out.slice(0, K);
}

/** Island offsets for K islands `gap` apart (islandCells), y 0. */
export function islandOffsets(K: number, gap: number): Vec3[] {
  return islandCells(K).map(([x, z]) => [x * gap, 0, z * gap]);
}

/** Bounding radius of a shape, m. */
export function shapeRadius(s: ShapeDesc): number {
  return s.kind === 'sphere' ? s.radius : Math.hypot(s.half[0], s.half[1], s.half[2]);
}

/** How far a world reaches from its origin on the ground plane, m: the largest |x| or |z| of any body's bounding sphere, spawned ones and point-blast spheres included. */
export function worldExtent(w: SceneDesc): number {
  let e = 0;
  const body = (b: BodyDesc) => { const r = shapeRadius(b.shape); e = Math.max(e, Math.abs(b.pos[0]) + r, Math.abs(b.pos[2]) + r); };
  w.bodies.forEach(body);
  for (const ev of w.inputs) {
    if (ev.kind === 'spawn') body(ev.body);
    else if (ev.kind === 'blast' && Array.isArray(ev.blast.centre)) e = Math.max(e, Math.abs(ev.blast.centre[0]) + ev.blast.radius, Math.abs(ev.blast.centre[2]) + ev.blast.radius);
  }
  return e;
}

/** The scene-wide fields every world must share to run in one solve. */
const SHARED = ['gravity', 'dt', 'ground', 'sleep', 'frictionCombine', 'restitutionCombine'] as const;

/** One body that has left its island's cell. */
export interface Leak { island: number; local: number; id: number; pos: Vec3 }

/** K worlds as islands of one scene; see the header. */
export class Islands {
  readonly K: number;
  readonly gap: number;
  readonly reach: number;
  /** Half the side of an island's cell, m: a body of island k stays within this of its offset on x and z, or it has leaked. */
  readonly half: number;
  /** The largest worldExtent of the worlds, m. */
  readonly extent: number;
  readonly offsets: readonly Vec3[];
  /** The packed scene: every world's bodies at its offset, island by island, and no inputs (due() releases them). */
  readonly scene: SceneDesc;
  /** Global id -> island and local id. Grows as spawns are released. */
  private readonly islandOfId: number[] = [];
  private readonly localOfId: number[] = [];
  /** Per island: local id -> global id. */
  private readonly globals: number[][];
  private readonly shapeOf: ShapeDesc[] = [];
  /** Per island: events still to release, local ids and coordinates, in queueInputs order. */
  private readonly queues: InputEvent[][];
  /** Per island: the local events released so far, each with the step it was released at. */
  private readonly sent: InputEvent[][];
  /** World-wide field events still to release (pushField), and those released, each with the step it was released at. */
  private fieldQueue: FieldEvent[] = [];
  private readonly fieldSent: FieldEvent[] = [];
  /** Every global event released so far, in release order (record()). */
  private readonly released: InputEvent[] = [];
  /** due() has run for steps below this. */
  private next = 0;
  /** pack() released every event up to this step: a push due at or before it is refused. */
  private sealed = -1;

  constructor(private readonly worlds: readonly SceneDesc[], opts: IslandOptions = {}) {
    const K = worlds.length;
    if (K < 1 || K > MAX_ISLANDS) throw new RangeError(`islands: 1 to ${MAX_ISLANDS} worlds, got ${K}`);
    const w0 = worlds[0]!;
    worlds.forEach((w, k) => {
      for (const f of SHARED) if (JSON.stringify(w[f] ?? null) !== JSON.stringify(w0[f] ?? null)) throw new Error(`islands: world ${k} differs from world 0 in ${f} (${JSON.stringify(w[f])} vs ${JSON.stringify(w0[f])}); every world shares one solve`);
    });
    this.K = K;
    this.extent = Math.max(...worlds.map(worldExtent));
    const reach = opts.reach ?? DEFAULT_ISLAND_REACH;
    if (!(reach >= 0 && Number.isFinite(reach))) throw new RangeError(`islands: reach must be a finite number >= 0, got ${reach}`);
    this.gap = opts.gap ?? Math.ceil(2 * (this.extent + reach));
    if (!(Number.isFinite(this.gap) && this.gap / 2 >= this.extent)) throw new RangeError(`islands: gap ${this.gap} m is narrower than the worlds (each reaches ${this.extent.toFixed(3)} m from its origin, so the gap must be at least ${(2 * this.extent).toFixed(3)} m)`);
    this.half = this.gap / 2;
    this.reach = this.half - this.extent;
    this.offsets = islandOffsets(K, this.gap);
    this.globals = worlds.map(() => []);
    const bodies: BodyDesc[] = [];
    worlds.forEach((w, k) => {
      for (const b of w.bodies) { this.register(k, b.shape); bodies.push(this.place(k, b)); }
    });
    this.queues = worlds.map(() => []);
    this.sent = worlds.map(() => []);
    worlds.forEach((w, k) => this.push(k, w.inputs));
    this.scene = { ...w0, id: `${w0.id}*${K}`, params: { ...w0.params, islands: K, islandGap: this.gap }, bodies, inputs: [] };
  }

  /** Bodies in the engine once every released spawn has been applied. */
  get count(): number { return this.islandOfId.length; }

  /** The global id of island k's local body `local`; throws if it does not exist yet. */
  idOf(k: number, local: number): number {
    const id = this.globals[this.check(k)]![local];
    if (id === undefined) throw new RangeError(`islands: island ${k} has no body ${local} (it has ${this.globals[k]!.length})`);
    return id;
  }

  islandOf(id: number): number { return this.at(this.islandOfId, id); }
  localOf(id: number): number { return this.at(this.localOfId, id); }
  /** Bodies island k has (its initial ones and the spawns released so far). */
  bodiesOf(k: number): number { return this.globals[this.check(k)]!.length; }
  /** Global ids of island k, in local order. */
  idsOf(k: number): readonly number[] { return this.globals[this.check(k)]!; }
  /** Per global id, its shape (the observer's ReduceInput.shapes). */
  shapes(): readonly ShapeDesc[] { return this.shapeOf; }

  /**
   * Queue events for island k, in its local ids and coordinates, as a solo
   * engine's push() would (an event applies at the first step >= its step).
   * Released by due(). A point blast must fit its island's cell; a blast
   * centred on a body must have a radius within the reach (leaks() checks the rest).
   */
  push(k: number, events: readonly InputEvent[]): void {
    this.check(k);
    for (const ev of events) {
      // A field event (field.ts) sets the one solve's gravity or kicks every body in it: it cannot belong to one island.
      if (ev.kind === 'field') throw new Error(`islands: island ${k} has a field event at step ${ev.step}; gravity and kicks are world-wide: push it once for every island with pushField()`);
      if (ev.kind === 'blast') {
        const c = ev.blast.centre, r = ev.blast.radius;
        if (Array.isArray(c) ? Math.max(Math.abs(c[0]), Math.abs(c[2])) + r > this.half : r > this.reach) {
          throw new RangeError(`islands: island ${k}'s blast (radius ${r} m) can reach past its cell (half side ${this.half} m, reach ${this.reach.toFixed(3)} m); widen the gap`);
        }
      }
    }
    this.queues[k] = queueInputs(this.queues[k]!, events);
  }

  /**
   * Queue world-wide field events (C7: a gravity step, a quake's keys, a kick), as a solo engine's push() would:
   * every island shakes alike. A kick goes to every body that moves and gravity is uniform, so both are the same
   * in every island's frame and are released unchanged. Within a step they are released before every island's
   * own events, so a body spawned at that step is never kicked, in every island alike (in island order, island
   * 0's same-step spawn would be released before the kick and island 5's after it, or the reverse).
   */
  pushField(events: readonly FieldEvent[]): void {
    for (const ev of events) {
      if ((ev as InputEvent).kind !== 'field') throw new Error(`islands: pushField takes field events only, got ${(ev as InputEvent).kind} at step ${ev.step}`);
      checkField(ev);
    }
    this.fieldQueue = queueInputs(this.fieldQueue, events) as FieldEvent[];
  }

  /**
   * The global events to push before the engine's step `step` (its stepIndex):
   * every queued event due at or before it, island by island, each in its
   * island's order, translated, with step = `step`. Spawns get their global
   * ids here, in this order, which is the order the engine assigns them.
   * Call it once per step, before step(), and push what it returns.
   */
  due(step: number): InputEvent[] {
    if (Number.isInteger(step) && step <= this.sealed) {
      // pack() put every event up to `sealed` in the scene's inputs; one pushed since and due by now would be late.
      if (this.queues.some((q) => q.length && q[0]!.step <= step) || (this.fieldQueue.length && this.fieldQueue[0]!.step <= step)) throw new Error(`islands: an event due by step ${step} was pushed after pack() sealed the scene to step ${this.sealed}; push only events due after step ${this.sealed}`);
      return [];
    }
    if (!Number.isInteger(step) || step < this.next) throw new RangeError(`islands: due(${step}) after due(${this.next - 1}); call it once per step, in order`);
    const out: InputEvent[] = [];
    // World-wide field events first (pushField): every island's same-step events come after them.
    while (this.fieldQueue.length && this.fieldQueue[0]!.step <= step) {
      const ev = { ...this.fieldQueue.shift()!, step };
      this.fieldSent.push(ev);
      out.push(ev);
    }
    for (let k = 0; k < this.K; k++) {
      const q = this.queues[k]!;
      while (q.length && q[0]!.step <= step) {
        const ev = q.shift()!, g = this.translate(k, ev, step);
        this.sent[k]!.push({ ...ev, step } as InputEvent);
        out.push(g);
      }
    }
    this.released.push(...out);
    this.next = step + 1;
    return out;
  }

  /**
   * The packed scene with every queued event already in its inputs, as due()
   * would release them step by step. For runs whose events are all known up
   * front (casts, probes). Pushes after it must be due after the last of
   * them; due() for the packed steps returns nothing and refuses one that is not.
   */
  pack(): SceneDesc {
    // Each round releases everything due by the earliest queued step (or the next step, for an event pushed late).
    const firsts = () => [...this.queues, this.fieldQueue].flatMap((q) => (q.length ? [q[0]!.step] : []));
    while (firsts().length) this.due(Math.max(this.next, Math.min(...firsts())));
    this.sealed = Math.max(this.sealed, this.next - 1);
    return this.record();
  }

  /** The packed scene with every event released so far in its inputs: replaying it gives the islands run again. */
  record(): SceneDesc {
    return { ...this.scene, inputs: [...this.released] };
  }

  /**
   * World k alone at its island's offset, with its own events (released and still queued) in local ids and the
   * world-wide field events, each step's field events first as due() releases them: the solo run nearest to its island.
   */
  solo(k: number): SceneDesc {
    const w = this.worlds[this.check(k)]!, o = this.offsets[k]!;
    const shift = (ev: InputEvent): InputEvent => {
      if (ev.kind === 'spawn') return { ...ev, body: this.place(k, ev.body) };
      if (ev.kind === 'blast' && Array.isArray(ev.blast.centre)) { const c = ev.blast.centre; return { ...ev, blast: { ...ev.blast, centre: [c[0] + o[0], c[1] + o[1], c[2] + o[2]] } }; }
      return ev;
    };
    const own = [...this.sent[k]!, ...this.queues[k]!].map(shift), field = [...this.fieldSent, ...this.fieldQueue];
    // Field events go in ahead of every event of the same step (queueInputs keeps push order within a step).
    return { ...w, id: `${w.id}@${k}`, bodies: w.bodies.map((b) => this.place(k, b)), inputs: queueInputs(field, own) };
  }

  /** Island k's own snapshot: its bodies in local order, positions relative to its offset (f64). */
  local(s: Snapshot, k: number): Snapshot {
    const ids = this.idsOf(k).filter((id) => id < s.count), n = ids.length, o = this.offsets[k]!;
    const out: Snapshot = { count: n, pos: new Float64Array(3 * n), rot: new Float64Array(4 * n), linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n) };
    if (s.tier) out.tier = new Uint8Array(n);
    ids.forEach((id, i) => {
      for (let a = 0; a < 3; a++) {
        out.pos[3 * i + a] = s.pos[3 * id + a]! - o[a]!;
        out.linVel[3 * i + a] = s.linVel[3 * id + a]!;
        out.angVel[3 * i + a] = s.angVel[3 * id + a]!;
      }
      for (let a = 0; a < 4; a++) out.rot[4 * i + a] = s.rot[4 * id + a]!;
      out.awake[i] = s.awake[id]!;
      if (s.tier) out.tier![i] = s.tier[id]!;
    });
    return out;
  }

  /** Bodies outside their island's cell (|x - ox| or |z - oz| over half - margin), or not finite. A run with a leak may have let worlds touch. */
  leaks(s: Snapshot, margin = 0): Leak[] {
    const out: Leak[] = [], lim = this.half - margin;
    for (let id = 0; id < Math.min(s.count, this.count); id++) {
      const k = this.islandOfId[id]!, o = this.offsets[k]!, x = s.pos[3 * id]!, z = s.pos[3 * id + 2]!;
      if (!(Math.abs(x - o[0]) <= lim && Math.abs(z - o[2]) <= lim)) out.push({ island: k, local: this.localOfId[id]!, id, pos: [x, s.pos[3 * id + 1]!, z] });
    }
    return out;
  }

  /** Per global id, its island index (Observer.setTags for ids first .. count - 1, one tag word per id). */
  tags(first = 0, count = this.count): Uint32Array {
    return Uint32Array.from({ length: Math.max(0, count - first) }, (_, i) => this.islandOfId[first + i]!);
  }

  private check(k: number): number {
    if (!Number.isInteger(k) || k < 0 || k >= this.K) throw new RangeError(`islands: no island ${k} (K = ${this.K})`);
    return k;
  }

  private at(xs: number[], id: number): number {
    const v = xs[id];
    if (v === undefined) throw new RangeError(`islands: no body ${id} (count ${this.count})`);
    return v;
  }

  private register(k: number, shape: ShapeDesc): void {
    this.localOfId.push(this.globals[k]!.length);
    this.globals[k]!.push(this.islandOfId.length);
    this.islandOfId.push(k);
    this.shapeOf.push(shape);
  }

  private place(k: number, b: BodyDesc): BodyDesc {
    const o = this.offsets[k]!;
    return { ...b, pos: [b.pos[0] + o[0], b.pos[1] + o[1], b.pos[2] + o[2]] };
  }

  /** A local event as the engine gets it: global ids, offset positions, due at `step`. Registers a spawn. */
  private translate(k: number, ev: InputEvent, step: number): InputEvent {
    const o = this.offsets[k]!;
    switch (ev.kind) {
      case 'spawn': {
        this.register(k, ev.body.shape);
        return { step, kind: 'spawn', body: this.place(k, ev.body) };
      }
      case 'remove':
        return { step, kind: 'remove', id: this.idOf(k, ev.id) };
      case 'blast': {
        const b = ev.blast, c = b.centre;
        const centre = Array.isArray(c) ? [c[0] + o[0], c[1] + o[1], c[2] + o[2]] as Vec3 : { ...c, body: this.idOf(k, c.body) };
        return { step, kind: 'blast', blast: { ...b, centre, ...(b.exclude ? { exclude: b.exclude.map((id) => this.idOf(k, id)) } : {}) } };
      }
      case 'field':
        throw new Error('islands: field events are refused by push()');
    }
  }
}

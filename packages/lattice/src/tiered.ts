// The world tiers behind the engine contract: dormant lattice cells cost
// nothing, and a PhysicsHost simulates only what is awake. The harness and
// the game drive this like any other engine, so "lattice + rapier" can be
// benchmarked against plain Rapier on every scenario.
//
// One step, in order (all loops in ascending id or cell order, so results
// do not depend on scheduling):
//  1. read the host state of step k - lag (exactly that step);
//  2. spawn due inputs;
//  3. wake cells: force capacity on proxies (W3, with the absorbed impulse
//     handed back as velocity), predictive impact plugs (W2), then the
//     support closure (W1, exact);
//  4. wake asleep bodies next to woken cells;
//  5. settle quiet cubes back into the lattice (bottom-up, with hysteresis);
//  6. refresh the static proxy shell around dynamic bodies (with hysteresis);
//  7. apply the batch atomically and step the host.
import {
  bodiesAt, type BodyDesc, type CellChange, type EngineInfo, emptySnapshot, type HostState, type InputEvent, massOf, MODE_DYNAMIC, MODE_OFF,
  MODE_STATIC, type ModeChange, type PhysicsEngine, type PhysicsHost, type Quat, type SceneDesc, type Snapshot, type StepReport, type Vec3,
} from '@tb/engine-api';
import { boundingRadius, shapeDepth } from '@tb/geom';
import { latticesFromScene } from './build.ts';
import { type Lattice } from './lattice.ts';
import { detach, looseColumns, type SupportModel } from './support.ts';
import { CUBE_ROTATIONS, nearestCubeRotation } from './symmetry.ts';

export const TIER_UNSPAWNED = 0;
export const TIER_LATTICE = 1;
export const TIER_ACTIVE = 2;

export interface TierParams {
  support: SupportModel;
  /** Lattice cells within this distance of a dynamic body's bounding sphere become static proxies, in edges. */
  proxyMargin: number;
  /** Steps a proxy is kept after it was last needed (hysteresis against churn). */
  proxyKeep: number;
  /** Steps beyond the host's state lag that impact sweeps look ahead. */
  lookahead: number;
  /** A body slower than this (m/s) never wakes cells by prediction. */
  vWake: number;
  /** Safety factor on force capacities (wake at kappa times capacity). */
  kappa: number;
  /** Force floor for capacity wakes, N (above solver noise). */
  forceMin: number;
  /** Absolute cap on the speed handed to a cell woken by force, m/s (it is also capped by the speed of the bodies near it). */
  handoffMax: number;
  /** Longest impact plug, in cells. */
  maxPlugDepth: number;
  /**
   * Wake the cells under an impact plug too. A dormant floor under a moving
   * plug is an anchor with unlimited friction (Rapier reports no friction
   * forces on voxels, so W3 cannot see the drag): on S5 at 1,600 cubes the
   * plug stopped dead and the ball bounced back without it, and moved 193
   * cubes against the all-dynamic reference's 172 with it.
   */
  plugColumns: boolean;
  /** A cube that has been this slow (m/s, and rad/s times half-edge) for restSteps steps may settle back into the lattice. */
  vRest: number;
  restSteps: number;
  /**
   * Steps a body must have been active before it may settle (hysteresis
   * against wake/settle thrash). Doubles each time a settled cube is woken
   * again, so a cube under a restless pile stops trying.
   */
  minActiveSteps: number;
  /** Settle tolerances: distance from the cell centre (edges) and angle from a cube symmetry (radians). */
  settlePos: number;
  settleRot: number;
  /**
   * The most a snap may deepen its overlap with a moving neighbour, in edges.
   * A snap moves a cube up to settlePos edges and turns it up to settleRot
   * (a corner moves edge * sin(settleRot) / sqrt 2); pushed into rubble that
   * rests against it, the solver throws the rubble out at up to a few m/s.
   */
  settlePush: number;
}

export const DEFAULT_TIERS: TierParams = {
  support: looseColumns, proxyMargin: 0.25, proxyKeep: 30, lookahead: 1, vWake: 0.25,
  kappa: 0.8, forceMin: 2, handoffMax: 20, maxPlugDepth: 64, plugColumns: true,
  vRest: 0.05, restSteps: 30, minActiveSteps: 60, settlePos: 0.02, settleRot: (1 * Math.PI) / 180, settlePush: 0.002,
};

export interface TierStats {
  lattice: number;
  active: number;
  proxies: number;
  /** Cells woken this step, by rule. */
  wokenByForce: number;
  wokenByImpact: number;
  wokenBySupport: number;
  proxiesAdded: number;
  proxiesDropped: number;
  /** Cubes that settled back into the lattice this step. */
  settled: number;
  /** Since init. */
  total: { byForce: number; byImpact: number; bySupport: number; settled: number };
}

/** Why a body changed tier: a game hook (sound, score) and a debugging aid. */
export type TransitionCause = 'force' | 'impact' | 'support' | 'command' | 'settle';
export type TransitionListener = (id: number, to: number, cause: TransitionCause, step: number) => void;

interface WakeRequest { li: number; i: number; j: number; k: number; vel: Vec3 | null; command?: boolean }

export class TieredEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  readonly p: TierParams;
  lattices: Lattice[] = [];
  /** Per id: TIER_*. */
  tier = new Uint8Array(0);
  /** Per id: lattice index and flat cell while dormant (else -1). */
  latticeOf = new Int32Array(0);
  cellOf = new Int32Array(0);
  stats: TierStats = { lattice: 0, active: 0, proxies: 0, wokenByForce: 0, wokenByImpact: 0, wokenBySupport: 0, proxiesAdded: 0, proxiesDropped: 0, settled: 0, total: { byForce: 0, byImpact: 0, bySupport: 0, settled: 0 } };
  private scene: SceneDesc | null = null;
  private table: BodyDesc[] = [];
  private mass = new Float64Array(0);
  private radius = new Float64Array(0);
  /** Per id: last step a proxy was needed, or -1 when the cell is not a proxy. */
  private proxyStamp = new Int32Array(0);
  private proxies = new Set<number>();
  /** Per id: speed at the start of the previous step (bounds the speed a pushed cell can be given). */
  private prevSpeed = new Float64Array(0);
  private curSpeed = new Map<number, number>();
  /** Per id: step it became active, and consecutive quiet steps since. */
  private activeSince = new Int32Array(0);
  private quiet = new Int32Array(0);
  /** Per id: reference contact force of a settled cell (3 per id), and whether it is still to be taken. */
  private refForce = new Float64Array(0);
  private refPending = new Uint8Array(0);
  /** Per id: times it settled. */
  private settles = new Uint8Array(0);
  private pending: InputEvent[] = [];
  private queued: WakeRequest[] = [];
  private nextSpawn = 0;
  /** Per lattice: cell -> dynamic bodies near it at the last shell pass. */
  private near: Array<Map<number, number[]>> = [];
  /** Whether the host takes lattice cells natively (no proxies). */
  private native = false;
  private cellChanges: CellChange[] = [];
  /** Called for every tier change, in the order they happen. */
  onTransition: TransitionListener | null = null;

  constructor(readonly host: PhysicsHost, params: Partial<TierParams> = {}) {
    this.p = { ...DEFAULT_TIERS, ...params };
    const variant: Record<string, string | number | boolean> = { host: host.info.name, ...prefix(host.info.variant, 'host.') };
    for (const [k, v] of Object.entries(this.p)) variant[k] = typeof v === 'object' ? v.name : v;
    this.info = { name: 'tiered', variant, backend: host.info.backend };
  }

  async init(scene: SceneDesc): Promise<void> {
    this.scene = scene;
    this.table = bodiesAt(scene, Infinity);
    const n = this.table.length;
    const built = latticesFromScene(scene, this.p.support);
    await this.host.init(scene, this.table, built.lattices.map((l) => {
      let friction = 0;
      l.forEach((_i, _j, _k, id) => { friction = this.table[id]!.friction; });
      return { origin: l.frame.origin, edge: l.frame.edge, dims: [l.nx, l.ny, l.nz] as [number, number, number], friction };
    }));
    if (this.host.caps.capacity < n) throw new Error(`host capacity ${this.host.caps.capacity} < ${n} bodies`);
    this.native = this.host.caps.latticeNative;
    this.mass = Float64Array.from(this.table, massOf);
    this.radius = Float64Array.from(this.table, (b) => boundingRadius(b.shape));
    this.tier = new Uint8Array(n);
    this.latticeOf = new Int32Array(n).fill(-1);
    this.cellOf = new Int32Array(n).fill(-1);
    this.proxyStamp = new Int32Array(n).fill(-1);
    this.proxies = new Set();
    this.prevSpeed = new Float64Array(n);
    this.activeSince = new Int32Array(n);
    this.quiet = new Int32Array(n);
    this.refForce = new Float64Array(3 * n);
    this.refPending = new Uint8Array(n);
    this.settles = new Uint8Array(n);
    this.lattices = built.lattices;
    this.near = this.lattices.map(() => new Map());
    this.latticeOf.set(built.latticeOf);
    this.cellOf.set(built.cellOf);
    const changes: ModeChange[] = [];
    scene.bodies.forEach((b, id) => {
      if (built.cellOf[id]! >= 0) { this.tier[id] = TIER_LATTICE; return; }
      this.tier[id] = TIER_ACTIVE;
      changes.push({ id, mode: MODE_DYNAMIC, pos: b.pos, rot: b.rot, linVel: b.linVel, angVel: b.angVel });
    });
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.nextSpawn = scene.bodies.length;
    this.stepIndex = 0;
    // Native hosts get every dormant cell; others get proxies around the bodies that start active.
    const cells: CellChange[] = [];
    if (this.native) this.lattices.forEach((lat, li) => lat.forEach((i, j, k, id) => cells.push({ lattice: li, i, j, k, id })));
    const dyn = changes.map((c) => ({ id: c.id, pos: c.pos!, vel: c.linVel! }));
    this.host.apply({ changes: this.withShell(changes, dyn), wake: [], cells });
  }

  /** Queue inputs after init (interactive play); same ordering rules as scene.inputs. */
  push(events: InputEvent[]): void {
    for (const ev of events) {
      const id = this.nextSpawn + this.pending.length;
      if (id >= this.table.length) throw new Error('pushed spawn beyond the id table; reserve capacity in the scene');
      this.pending.push(ev);
    }
    this.pending.sort((a, b) => a.step - b.step);
  }

  /** Game command: wake every dormant cell whose centre is within `radius` of `center`, at the next step. */
  wakeSphere(center: Vec3, radius: number): void {
    this.lattices.forEach((lat, li) => {
      const lo: Vec3 = [center[0] - radius, center[1] - radius, center[2] - radius], hi: Vec3 = [center[0] + radius, center[1] + radius, center[2] + radius];
      for (const [i, j, k] of cellsInBox(lat, lo, hi, (i, j, k) => lat.has(i, j, k))) {
        const c = lat.center(i, j, k);
        if (Math.hypot(c[0] - center[0], c[1] - center[1], c[2] - center[2]) <= radius) this.queued.push({ li, i, j, k, vel: null, command: true });
      }
    });
  }

  /** Number of bodies spawned so far (the snapshot count). */
  get spawned(): number { return this.nextSpawn; }

  /** The id table: every body the run can use. */
  get bodies(): readonly BodyDesc[] { return this.table; }

  async step(): Promise<StepReport | void> {
    if (!this.scene) throw new Error('init() first');
    const st = this.stats;
    st.wokenByForce = st.wokenByImpact = st.wokenBySupport = st.settled = 0;
    const state = await this.host.read();
    const changes = new Map<number, ModeChange>();
    const movers: Mover[] = [];
    for (let n = 0; n < state.ids.length; n++) {
      const id = state.ids[n]!, vel = vec(state.linVel, n), half = this.radius[id]! / Math.sqrt(3);
      movers.push({ id, pos: vec(state.pos, n), vel, awake: state.awake[n] === 1 });
      const still = Math.hypot(...vel) < this.p.vRest && Math.hypot(...vec(state.angVel, n)) * half < this.p.vRest;
      this.quiet[id] = still ? this.quiet[id]! + 1 : 0;
    }
    // Spawns.
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) {
      const b = this.pending.shift()!.body;
      const id = this.nextSpawn++;
      this.tier[id] = TIER_ACTIVE;
      this.activeSince[id] = this.stepIndex;
      changes.set(id, { id, mode: MODE_DYNAMIC, pos: b.pos, rot: b.rot, linVel: b.linVel, angVel: b.angVel });
      movers.push({ id, pos: b.pos, vel: b.linVel, awake: true });
    }
    this.curSpeed = new Map(movers.map((m) => [m.id, Math.hypot(...m.vel)]));
    // Wake rules (forces use the speeds from before the step that produced them).
    const requests = [...this.queued.splice(0), ...this.forceWakes(state), ...this.impactWakes(movers)];
    const woken = this.wake(requests, changes);
    // Asleep bodies next to woken cells.
    const wake = new Set<number>();
    for (const { li, cell } of woken) for (const id of this.near[li]!.get(cell) ?? []) if (this.tier[id] === TIER_ACTIVE && !changes.has(id)) wake.add(id);
    // Woken cells are dynamic now: they need proxies around them too.
    for (const { id } of woken) movers.push({ id, pos: changes.get(id)!.pos!, vel: changes.get(id)!.linVel ?? [0, 0, 0], awake: true });
    const settled = this.settle(state, changes);
    const list = this.withShell([...changes.values()].sort((a, b) => a.id - b.id), settled.size ? movers.filter((m) => !settled.has(m.id)) : movers);
    this.host.apply({ changes: list, wake: [...wake].sort((a, b) => a - b), cells: this.cellChanges.splice(0) });
    st.total.byForce += st.wokenByForce; st.total.byImpact += st.wokenByImpact; st.total.bySupport += st.wokenBySupport; st.total.settled += st.settled;
    this.prevSpeed.fill(0);
    for (const m of movers) this.prevSpeed[m.id] = Math.hypot(...m.vel);
    const r = await this.host.step();
    this.stepIndex++;
    return r;
  }

  /** W3: a proxy pushed beyond what friction under its column can hold wakes, and gets the push back as velocity. */
  private forceWakes(state: HostState): WakeRequest[] {
    const c = state.contacts;
    if (!c) return [];
    const out: WakeRequest[] = [];
    const g = gravityMag(this.scene!);
    const dt = this.scene!.dt;
    for (let n = 0; n < c.ids.length; n++) {
      const id = c.ids[n]!;
      if (this.tier[id] !== TIER_LATTICE) continue;
      const li = this.latticeOf[id]!, lat = this.lattices[li]!;
      const [i, j, k] = lat.coords(this.cellOf[id]!);
      const f: Vec3 = [c.force[3 * n]!, c.force[3 * n + 1]!, c.force[3 * n + 2]!];
      // A cube that settled carried its current load while it was active and
      // quiet, so that load is known to hold: the first force after settling
      // becomes its reference, and it wakes only when both the total force and
      // the change since then exceed the capacity. The total alone over-wakes
      // where neighbours hold a cell (its base friction is all the test sees);
      // the change alone over-wakes when a held load reverses (measured: a
      // ground cube under rubble went from -40 to +30 N sideways, 70 N of
      // change against 68 N of capacity while 30 N of total was well held).
      if (this.refPending[id]) {
        this.refPending[id] = 0;
        this.refForce.set(f, 3 * id);
        continue;
      }
      const d: Vec3 = [f[0] - this.refForce[3 * id]!, f[1] - this.refForce[3 * id + 1]!, f[2] - this.refForce[3 * id + 2]!];
      let w = 0;
      for (const jj of lat.occupiedFrom(i, k, j)) w += g * this.mass[lat.idAt(i, jj, k)]!;
      const mu = this.table[id]!.friction;
      // Friction under the column holds kappa * mu * (load from above + column weight).
      const hold = this.p.kappa * mu * (Math.max(0, -f[1]) + w) + this.p.forceMin;
      const slides = Math.hypot(f[0], f[2]) > hold && Math.hypot(d[0], d[2]) > hold;
      const lift = this.p.kappa * w + this.p.forceMin;
      const lifts = f[1] > lift && d[1] > lift;
      if (!slides && !lifts) continue;
      const [fx, fy, fz] = d;
      // Hand back the impulse the cell absorbed while static, at most at the
      // speed of the bodies near it before or after that step: momentum is
      // returned without creating energy (a cell cannot outrun its pusher).
      const m = this.mass[id]!;
      let vel: Vec3 = [fx * dt / m, Math.max(0, fy) * dt / m, fz * dt / m];
      let cap = 0;
      for (const p of this.near[li]!.get(this.cellOf[id]!) ?? []) cap = Math.max(cap, this.prevSpeed[p]!, this.curSpeed.get(p) ?? 0);
      cap = Math.min(cap, this.p.handoffMax);
      const s = Math.hypot(...vel);
      if (s > cap) vel = vel.map((x) => (x * cap) / s) as Vec3;
      out.push({ li, i, j, k, vel });
    }
    return out;
  }

  /**
   * W2: a body about to hit dormant cells wakes them before contact, so it
   * never hits an infinite-mass wall. Momentum travels along lines in a
   * packed lattice, so for each axis the body moves along faster than vWake
   * the woken set is a plug of lines along that axis, as deep as the shared
   * speed m v / (m + M) stays above vWake, plus the cells under it
   * (plugColumns). Straight down is skipped: a column on rigid ground takes
   * that in compression and nothing slides.
   */
  private impactWakes(movers: Mover[]): WakeRequest[] {
    const out: WakeRequest[] = [];
    const scene = this.scene!;
    const T = (this.host.caps.stateLag + this.p.lookahead) * scene.dt;
    for (const m of movers) {
      if (!m.awake || Math.hypot(...m.vel) < this.p.vWake) continue;
      const r = this.radius[m.id]!, mb = this.mass[m.id]!;
      const end: Vec3 = [m.pos[0] + m.vel[0] * T, m.pos[1] + m.vel[1] * T, m.pos[2] + m.vel[2] * T];
      this.lattices.forEach((lat, li) => {
        const pad = r + this.p.proxyMargin * lat.frame.edge;
        const struck = cellsInBox(lat, minOf(m.pos, end, -pad), minOf(m.pos, end, pad, true), (i, j, k) => lat.has(i, j, k));
        if (!struck.length) return;
        for (let ax = 0; ax < 3; ax++) {
          const v = m.vel[ax]!, sgn = Math.sign(v);
          if (Math.abs(v) < this.p.vWake || (ax === 1 && sgn * scene.gravity[1] > 0)) continue;
          const P = mb * Math.abs(v);
          const step: [number, number, number] = [0, 0, 0];
          step[ax] = sgn;
          let front = struck, M = 0;
          const seen = new Set<number>();
          for (let depth = 0; depth < this.p.maxPlugDepth && front.length; depth++) {
            const layer = front.filter(([i, j, k]) => lat.has(i, j, k) && !seen.has(lat.cell(i, j, k)));
            if (!layer.length) break;
            for (const [i, j, k] of layer) {
              seen.add(lat.cell(i, j, k));
              M += this.mass[lat.idAt(i, j, k)]!;
              out.push({ li, i, j, k, vel: null });
              if (this.p.plugColumns) for (let jj = 0; jj < j; jj++) out.push({ li, i, j: jj, k, vel: null });
            }
            if (P / (mb + M) < this.p.vWake) break;
            front = layer.map(([i, j, k]) => [i + step[0], j + step[1], k + step[2]] as [number, number, number]);
          }
        }
      });
    }
    return out;
  }

  /** Detach requested cells with their support closure; record the host changes. */
  private wake(requests: WakeRequest[], changes: Map<number, ModeChange>): Array<{ id: number; li: number; cell: number }> {
    const out: Array<{ id: number; li: number; cell: number }> = [];
    const byLattice = new Map<number, WakeRequest[]>();
    for (const r of requests) {
      const list = byLattice.get(r.li);
      if (list) list.push(r); else byLattice.set(r.li, [r]);
    }
    const g = gravityMag(this.scene!);
    for (const li of [...byLattice.keys()].sort((a, b) => a - b)) {
      const lat = this.lattices[li]!;
      const reqs = byLattice.get(li)!.sort((a, b) => lat.cell(a.i, a.j, a.k) - lat.cell(b.i, b.j, b.k));
      const vel = new Map<number, Vec3>();
      const commanded = new Set<number>();
      for (const r of reqs) {
        if (r.vel && !vel.has(lat.cell(r.i, r.j, r.k))) vel.set(lat.cell(r.i, r.j, r.k), r.vel);
        if (r.command) commanded.add(lat.cell(r.i, r.j, r.k));
      }
      const detached = detach(lat, this.p.support, reqs.map((r) => [r.i, r.j, r.k] as [number, number, number]));
      // Rest load per woken cell: weight of the woken run above it, if the run stands on something.
      const byCol = new Map<number, typeof detached>();
      for (const d of detached) {
        const col = lat.column(d.i, d.k);
        const list = byCol.get(col);
        if (list) list.push(d); else byCol.set(col, [d]);
      }
      const restLoad = new Map<number, number>();
      for (const list of byCol.values()) {
        list.sort((a, b) => a.j - b.j);
        for (let s = 0; s < list.length;) {
          let t = s;
          while (t + 1 < list.length && list[t + 1]!.j === list[t]!.j + 1) t++;
          const base = list[s]!;
          const standing = base.j === 0 || lat.has(base.i, base.j - 1, base.k);
          let w = 0;
          for (let q = t; q >= s; q--) { w += g * this.mass[list[q]!.id]!; restLoad.set(list[q]!.id, standing ? w : 0); }
          s = t + 1;
        }
      }
      for (const d of detached) {
        const cell = lat.cell(d.i, d.j, d.k);
        const cause: TransitionCause = d.cause === 'support' ? 'support' : vel.has(cell) ? 'force' : commanded.has(cell) ? 'command' : 'impact';
        if (cause === 'support') this.stats.wokenBySupport++;
        else if (cause === 'force') this.stats.wokenByForce++;
        else this.stats.wokenByImpact++;
        this.onTransition?.(d.id, TIER_ACTIVE, cause, this.stepIndex);
        if (this.native) this.cellChanges.push({ lattice: li, i: d.i, j: d.j, k: d.k, id: -1 });
        this.tier[d.id] = TIER_ACTIVE;
        this.activeSince[d.id] = this.stepIndex;
        this.quiet[d.id] = 0;
        this.refPending[d.id] = 0;
        this.refForce.fill(0, 3 * d.id, 3 * d.id + 3);
        this.latticeOf[d.id] = -1;
        this.cellOf[d.id] = -1;
        this.proxyStamp[d.id] = -1;
        this.proxies.delete(d.id);
        changes.set(d.id, {
          id: d.id, mode: MODE_DYNAMIC, pos: lat.center(d.i, d.j, d.k), rot: CUBE_ROTATIONS[d.rot]!,
          linVel: vel.get(cell) ?? [0, 0, 0], angVel: [0, 0, 0], restLoad: restLoad.get(d.id) ?? 0,
        });
        out.push({ id: d.id, li, cell });
      }
    }
    return out;
  }

  /**
   * Quiet cubes within tolerance of an empty, supported cell snap back into
   * the lattice, bottom-up so a settled stack goes back in one pass. A snap
   * moves a cube at most settlePos edges, and is refused if that would push
   * it deeper into a moving neighbour by more than settlePush edges.
   */
  private settle(state: HostState, changes: Map<number, ModeChange>): Set<number> {
    const done = new Set<number>();
    if (!this.lattices.length) return done;
    interface Cand { n: number; id: number; li: number; i: number; j: number; k: number; rot: number }
    const cands: Cand[] = [];
    for (let n = 0; n < state.ids.length; n++) {
      const id = state.ids[n]!;
      if (this.tier[id] !== TIER_ACTIVE || changes.has(id) || this.quiet[id]! < this.p.restSteps) continue;
      if (this.stepIndex - this.activeSince[id]! < this.p.minActiveSteps * 2 ** Math.min(this.settles[id]!, 8)) continue;
      const b = this.table[id]!;
      if (b.shape.kind !== 'box') continue;
      const [hx, hy, hz] = b.shape.half;
      const pos = vec(state.pos, n);
      const q: [number, number, number, number] = [state.rot[4 * n]!, state.rot[4 * n + 1]!, state.rot[4 * n + 2]!, state.rot[4 * n + 3]!];
      const sym = nearestCubeRotation(q);
      if (sym.angle > this.p.settleRot) continue;
      for (let li = 0; li < this.lattices.length; li++) {
        const lat = this.lattices[li]!, e = lat.frame.edge;
        if (Math.abs(hx - e / 2) > 1e-9 * e || Math.abs(hy - e / 2) > 1e-9 * e || Math.abs(hz - e / 2) > 1e-9 * e) continue;
        const [i, j, k] = lat.nearest(pos);
        if (!lat.inBounds(i, j, k)) continue;
        const c = lat.center(i, j, k);
        if (Math.hypot(pos[0] - c[0], pos[1] - c[1], pos[2] - c[2]) > this.p.settlePos * e) continue;
        cands.push({ n, id, li, i, j, k, rot: sym.index });
        break;
      }
    }
    if (!cands.length) return done;
    cands.sort((a, b) => a.li - b.li || a.j - b.j || a.k - b.k || a.i - b.i || a.id - b.id);
    // Candidates snap in this same pass, so only the others can be pushed.
    const snapping = new Set(cands.map((c) => c.id));
    for (const c of cands) {
      const lat = this.lattices[c.li]!, e = lat.frame.edge;
      if (!this.p.support.canInsert(lat, c.i, c.j, c.k)) continue;
      // Neighbours that the snap would push into.
      const center = lat.center(c.i, c.j, c.k), cubeRot = CUBE_ROTATIONS[c.rot]!;
      const cube = { kind: 'box' as const, half: [e / 2, e / 2, e / 2] as Vec3 };
      const from = vec(state.pos, c.n), fromRot: Quat = [state.rot[4 * c.n]!, state.rot[4 * c.n + 1]!, state.rot[4 * c.n + 2]!, state.rot[4 * c.n + 3]!];
      let blocked = false;
      for (let n = 0; n < state.ids.length && !blocked; n++) {
        const other = state.ids[n]!;
        if (snapping.has(other)) continue;
        const p = vec(state.pos, n);
        if (Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) > this.radius[other]! + e) continue;
        const q: [number, number, number, number] = [state.rot[4 * n]!, state.rot[4 * n + 1]!, state.rot[4 * n + 2]!, state.rot[4 * n + 3]!];
        const shape = this.table[other]!.shape;
        const deeper = Math.max(0, shapeDepth(shape, p, q, cube, center, cubeRot)) - Math.max(0, shapeDepth(shape, p, q, cube, from, fromRot));
        if (deeper > this.p.settlePush * e) blocked = true;
      }
      if (blocked) continue;
      lat.insert(c.i, c.j, c.k, c.id, c.rot);
      this.tier[c.id] = TIER_LATTICE;
      this.latticeOf[c.id] = c.li;
      this.cellOf[c.id] = lat.cell(c.i, c.j, c.k);
      this.quiet[c.id] = 0;
      this.refPending[c.id] = 1;
      if (this.settles[c.id]! < 255) this.settles[c.id]!++;
      if (this.native) this.cellChanges.push({ lattice: c.li, i: c.i, j: c.j, k: c.k, id: c.id });
      else {
        // It becomes a proxy in place; the shell drops it once nothing is near.
        changes.set(c.id, { id: c.id, mode: MODE_STATIC, pos: center, rot: cubeRot });
        this.proxyStamp[c.id] = this.stepIndex;
        this.proxies.add(c.id);
      }
      done.add(c.id);
      this.stats.settled++;
      this.onTransition?.(c.id, TIER_LATTICE, 'settle', this.stepIndex);
    }
    return done;
  }

  /** Add proxy changes for the shell around `movers` and drop stale proxies. */
  private withShell(changes: ModeChange[], movers: Array<{ id: number; pos: Vec3; vel: Vec3 }>): ModeChange[] {
    const k = this.stepIndex;
    const T = (this.host.caps.stateLag + this.p.lookahead) * this.scene!.dt;
    const added: ModeChange[] = [];
    this.near = this.lattices.map(() => new Map());
    for (const m of movers) {
      const r = this.radius[m.id]!;
      const end: Vec3 = [m.pos[0] + m.vel[0] * T, m.pos[1] + m.vel[1] * T, m.pos[2] + m.vel[2] * T];
      this.lattices.forEach((lat, li) => {
        const pad = r + this.p.proxyMargin * lat.frame.edge;
        const near = this.near[li]!;
        for (const [i, j, kk] of cellsInBox(lat, minOf(m.pos, end, -pad), minOf(m.pos, end, pad, true), (i, j, kk) => lat.has(i, j, kk) && exposed(lat, i, j, kk))) {
          const cell = lat.cell(i, j, kk), id = lat.idAt(i, j, kk);
          const list = near.get(cell);
          if (list) { if (list[list.length - 1] !== m.id) list.push(m.id); } else near.set(cell, [m.id]);
          if (this.native) continue;
          if (this.proxyStamp[id]! < 0) {
            this.proxies.add(id);
            added.push({ id, mode: MODE_STATIC, pos: lat.center(i, j, kk), rot: CUBE_ROTATIONS[lat.rotAt(i, j, kk)]! });
            this.stats.proxiesAdded++;
          }
          this.proxyStamp[id] = k;
        }
      });
    }
    const dropped: ModeChange[] = [];
    for (const id of this.proxies) {
      if (this.proxyStamp[id]! < k - this.p.proxyKeep) { this.proxyStamp[id] = -1; dropped.push({ id, mode: MODE_OFF }); this.stats.proxiesDropped++; }
    }
    for (const c of dropped) this.proxies.delete(c.id);
    const all = new Map<number, ModeChange>();
    for (const c of [...dropped, ...added, ...changes]) all.set(c.id, c); // later entries win: a wake beats a proxy
    this.refreshCounts();
    return [...all.values()].sort((a, b) => a.id - b.id);
  }

  private refreshCounts(): void {
    const lattice = this.lattices.reduce((n, l) => n + l.count, 0);
    Object.assign(this.stats, { lattice, active: this.nextSpawn - lattice, proxies: this.proxies.size });
  }

  async snapshot(): Promise<Snapshot> {
    const count = this.nextSpawn;
    const s = emptySnapshot(count);
    const cur = await this.host.current();
    for (let n = 0; n < cur.ids.length; n++) {
      const id = cur.ids[n]!;
      if (id >= count) continue;
      s.pos.set(cur.pos.subarray(3 * n, 3 * n + 3), 3 * id);
      s.rot.set(cur.rot.subarray(4 * n, 4 * n + 4), 4 * id);
      s.linVel.set(cur.linVel.subarray(3 * n, 3 * n + 3), 3 * id);
      s.angVel.set(cur.angVel.subarray(3 * n, 3 * n + 3), 3 * id);
      s.awake[id] = cur.awake[n]!;
    }
    this.lattices.forEach((lat) => lat.forEach((i, j, k, id) => {
      s.pos.set(lat.center(i, j, k), 3 * id);
      s.rot.set(CUBE_ROTATIONS[lat.rotAt(i, j, k)]!, 4 * id);
    }));
    return s;
  }

  dispose(): void { this.host.dispose(); }
}

interface Mover { id: number; pos: Vec3; vel: Vec3; awake: boolean }

const vec = (a: Float64Array, n: number): Vec3 => [a[3 * n]!, a[3 * n + 1]!, a[3 * n + 2]!];
const gravityMag = (s: SceneDesc) => Math.hypot(...s.gravity);
const dominantAxis = (v: Vec3) => (Math.abs(v[0]) >= Math.abs(v[1]) ? (Math.abs(v[0]) >= Math.abs(v[2]) ? 0 : 2) : Math.abs(v[1]) >= Math.abs(v[2]) ? 1 : 2);

/** Corner of the box spanning a and b, grown by pad (min corner, or max corner when `max`). */
function minOf(a: Vec3, b: Vec3, pad: number, max = false): Vec3 {
  return max
    ? [Math.max(a[0], b[0]) + pad, Math.max(a[1], b[1]) + pad, Math.max(a[2], b[2]) + pad]
    : [Math.min(a[0], b[0]) + pad, Math.min(a[1], b[1]) + pad, Math.min(a[2], b[2]) + pad];
}

/** Cells overlapping a world box that pass `keep`, in ascending cell order. */
export function cellsInBox(lat: Lattice, lo: Vec3, hi: Vec3, keep: (i: number, j: number, k: number) => boolean): Array<[number, number, number]> {
  const { origin: o, edge: e } = lat.frame;
  const r0 = (a: number) => Math.ceil((lo[a]! - o[a]!) / e - 0.5), r1 = (a: number) => Math.floor((hi[a]! - o[a]!) / e + 0.5);
  const i0 = Math.max(0, r0(0)), i1 = Math.min(lat.nx - 1, r1(0));
  const j0 = Math.max(0, r0(1)), j1 = Math.min(lat.ny - 1, r1(1));
  const k0 = Math.max(0, r0(2)), k1 = Math.min(lat.nz - 1, r1(2));
  const out: Array<[number, number, number]> = [];
  for (let k = k0; k <= k1; k++) for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) if (keep(i, j, k)) out.push([i, j, k]);
  return out;
}

/** A cell with a face that something could touch (the ground covers the bottom of row 0). */
export function exposed(lat: Lattice, i: number, j: number, k: number): boolean {
  return !lat.has(i + 1, j, k) || !lat.has(i - 1, j, k) || !lat.has(i, j + 1, k) || (j > 0 && !lat.has(i, j - 1, k))
    || !lat.has(i, j, k + 1) || !lat.has(i, j, k - 1);
}

function prefix(o: Record<string, string | number | boolean>, p: string) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [p + k, v]));
}

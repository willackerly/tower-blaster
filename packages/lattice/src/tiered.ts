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
//     Rubble thaws by the same three rules: force capacity (T3), predicted
//     contact with a fast body (T2), and losing a supporter (T1, closure);
//  4. wake asleep bodies next to woken cells and thawed rubble;
//  5. settle quiet cubes back into the lattice (bottom-up, with hysteresis);
//  6. freeze the other quiet bodies in place as rubble (bottom-up, only on
//     ground, lattice or rubble, recording what each one rests on);
//  7. refresh the static proxy shell around dynamic bodies (with hysteresis);
//  8. apply the batch atomically and step the host.
import {
  bodiesAt, type BodyDesc, type CellChange, type EngineInfo, emptySnapshot, type HostState, type InputEvent, massOf, MODE_DYNAMIC, MODE_OFF,
  MODE_STATIC, type ModeChange, type PhysicsEngine, type PhysicsHost, type Quat, type SceneDesc, type Snapshot, type StepReport, type Vec3,
} from '@tb/engine-api';
import { boundingRadius, shapeDepth, signedDepth, signedGroundDepth } from '@tb/geom';
import { latticesFromScene } from './build.ts';
import { BoxHash } from './hash.ts';
import { type Lattice } from './lattice.ts';
import { detach, looseColumns, type SupportModel } from './support.ts';
import { CUBE_ROTATIONS, nearestCubeRotation } from './symmetry.ts';

export const TIER_UNSPAWNED = 0;
export const TIER_LATTICE = 1;
export const TIER_ACTIVE = 2;
/** Frozen in place (a static host body) after coming to rest off any cell pose. */
export const TIER_RUBBLE = 3;

/** Steps before a body found resting on a moving one tries to freeze again (the pass is the costly part of a step otherwise). */
const FREEZE_RETRY = 8;

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
  /**
   * A dormant cell wakes only for motion someone could see: at least this
   * many edges of slide. W2 wakes an impact plug only when sharing the
   * body's momentum would carry the plug this far against the friction
   * under it; W3 integrates a pushed cell's line as a friction block and
   * wakes it once that virtual block has slid this far. 0: any push over
   * capacity wakes (the rule before slides; on S5 at 10k cubes a ball that
   * bounces off a 1,600-cube tower woke all of it).
   */
  slideMin: number;
  /**
   * W3 wakes the whole line that slides, not only the pushed cell. Off by
   * default: on 8 perturbed S5 shots at one 1,600-cube tower (before
   * unwedge) it left woken slabs wedged in the tower and broke 14 to 789
   * cubes (median 168), against all-dynamic Rapier's 8 to 29.
   */
  slideLine: boolean;
  /**
   * Never leave woken cells wedged between dormant ones along a horizontal
   * row: wake the thinner dormant side out to the tower's surface. Rapier
   * boxes in a static well of zero clearance climb out of it: on S5 at one
   * 1,600-cube tower a dent's column rose 0.4 m and dropped the top, and 8
   * perturbed shots broke 0 to 167 cubes (median 44) without this, 0 to 97
   * (median 0) with it, all-dynamic Rapier 8 to 29.
   */
  unwedge: boolean;
  /**
   * A body is quiet while it stays slower than vRest and within restDrift
   * bounding radii (displacement plus rotation angle times radius) of where
   * it was at most restSteps steps before; after restSteps quiet steps it
   * may settle or freeze. Displacement, not
   * speed, decides because packed Rapier towers jitter at a few cm/s forever
   * (p50 2.7 cm/s, p90 17 cm/s on S5) while going nowhere.
   */
  vRest: number;
  restDrift: number;
  restSteps: number;
  /**
   * Steps a body must have been active before it may settle (hysteresis
   * against wake/settle thrash). Doubles each time a settled cube is woken
   * again, so a cube under a restless pile stops trying.
   */
  minActiveSteps: number;
  /**
   * Settle quiet cubes back into lattice cells. 'auto': only where that is
   * harmless, i.e. hosts without native cells (proxies) and native hosts with
   * caps.localCellChanges. On Rapier's voxels, S5 at 1,024 cubes ended 1,200
   * steps with 594 bodies awake with settling and 1 without (the rest frozen
   * as rubble or never woken), against 1 for all-dynamic Rapier.
   */
  settle: boolean | 'auto';
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
  /**
   * Freeze quiet bodies that cannot settle into a cell in place, as static
   * rubble. Off: they stay active (and in Rapier, packed piles never sleep).
   */
  rubble: boolean;
  /** Bodies closer than this (m) count as touching when rubble records what it rests on. */
  touchTol: number;
  /**
   * Consecutive steps a rubble body must be pushed beyond capacity before it
   * thaws by force (T3). Measured on S5 with sleep off: of 64 to 78 rubble
   * force thaws on the first step over, 1 to 3 moved 5 cm within the next
   * second; the rest stalled the piles above them for nothing.
   */
  rubbleForceSteps: number;
}

export const DEFAULT_TIERS: TierParams = {
  support: looseColumns, proxyMargin: 0.25, proxyKeep: 30, lookahead: 1, vWake: 0.25,
  kappa: 0.8, forceMin: 2, handoffMax: 20, maxPlugDepth: 64, plugColumns: true, slideMin: 0.05, slideLine: false, unwedge: true,
  settle: 'auto', vRest: 0.25, restDrift: 0.02, restSteps: 30, minActiveSteps: 60, settlePos: 0.02, settleRot: (1 * Math.PI) / 180, settlePush: 0.002,
  rubble: true, touchTol: 0.02, rubbleForceSteps: 3,
};

export interface TierStats {
  lattice: number;
  active: number;
  rubble: number;
  proxies: number;
  /** Cells woken this step, by rule. */
  wokenByForce: number;
  wokenByImpact: number;
  wokenBySupport: number;
  proxiesAdded: number;
  proxiesDropped: number;
  /** Cubes that settled back into the lattice this step. */
  settled: number;
  /** Bodies frozen as rubble, and rubble thawed (by any rule), this step. */
  frozen: number;
  thawed: number;
  /** Since init. */
  total: { byForce: number; byImpact: number; bySupport: number; settled: number; frozen: number; thawed: number };
}

/** Why a body changed tier: a game hook (sound, score) and a debugging aid. */
export type TransitionCause = 'force' | 'impact' | 'support' | 'command' | 'settle' | 'freeze';
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
  stats: TierStats = {
    lattice: 0, active: 0, rubble: 0, proxies: 0, wokenByForce: 0, wokenByImpact: 0, wokenBySupport: 0, proxiesAdded: 0, proxiesDropped: 0, settled: 0, frozen: 0, thawed: 0,
    total: { byForce: 0, byImpact: 0, bySupport: 0, settled: 0, frozen: 0, thawed: 0 },
  };
  /** Per rubble id: frozen pose (3 and 4 per id). */
  rubblePos = new Float64Array(0);
  rubbleRot = new Float64Array(0);
  /** Per rubble id: the lattice cells and rubble it rested on when it froze (ground is implicit). */
  supporters = new Map<number, number[]>();
  scene: SceneDesc | null = null;
  private table: BodyDesc[] = [];
  private mass = new Float64Array(0);
  private radius = new Float64Array(0);
  /** Per id: last step a proxy was needed, or -1 when the cell is not a proxy. */
  private proxyStamp = new Int32Array(0);
  private proxies = new Set<number>();
  /** Per id: speed at the start of the previous step (bounds the speed a pushed cell can be given). */
  private prevSpeed = new Float64Array(0);
  private curSpeed = new Map<number, number>();
  /** Per lattice, per cell: held a body when the scene was built (the towers' footprint). */
  private built: Uint8Array[] = [];
  /** Per pushed lattice cell: the virtual slide of its line (W3), speed and distance along dir. */
  private slides = new Map<number, { v: number; x: number; dir: Vec3; hold: number; M: number; line: Array<[number, number, number]> }>();
  /** Per id: step it became active, and consecutive quiet steps since. */
  private activeSince = new Int32Array(0);
  private quiet = new Int32Array(0);
  /** Per id: pose at the start of the current quiet run. */
  private anchorPos = new Float64Array(0);
  private anchorRot = new Float64Array(0);
  /** Per id: reference contact force of a settled cell (3 per id), and whether it is still to be taken. */
  private refForce = new Float64Array(0);
  private refPending = new Uint8Array(0);
  /**
   * Per id: times it settled, which backs off the next settle. Freezing
   * has no backoff, only the minActiveSteps rate limit (so at most
   * 2 T / minActiveSteps + 1 tier changes in T steps): it moves nothing, and
   * a backoff on the ground row (480 steps after three false force thaws)
   * stalled the hundreds of bodies above it, which wait for what is under
   * them.
   */
  private settles = new Uint8Array(0);
  /** Per rubble id: consecutive steps pushed beyond capacity (T3). */
  private pushed = new Int32Array(0);
  private pushedAt = new Int32Array(0);
  /** Per id: first step to try freezing again after it was found on a moving body. */
  private freezeRetry = new Int32Array(0);
  /** Per id: rubble resting on it. */
  private dependants = new Map<number, Set<number>>();
  private rubbleHash = new BoxHash(1);
  private moverRot = new Map<number, Quat>();
  /** Per dynamic id: its row in this step's host state. */
  private row = new Map<number, number>();
  private pending: InputEvent[] = [];
  private queued: WakeRequest[] = [];
  private queuedThaws: Array<{ id: number; vel: null; cause: TransitionCause }> = [];
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
    // Dormant cubes are at their cell pose (the scene's is within posTol of
    // it), so the host's table, the cell changes and the snapshot agree exactly.
    for (const lat of built.lattices) lat.forEach((i, j, k, id) => { this.table[id] = { ...this.table[id]!, pos: lat.center(i, j, k), rot: CUBE_ROTATIONS[lat.rotAt(i, j, k)]! }; });
    await this.host.init(scene, this.table, built.lattices.map((l) => {
      let friction = 0;
      l.forEach((_i, _j, _k, id) => { friction = this.table[id]!.friction; });
      return { origin: l.frame.origin, edge: l.frame.edge, dims: [l.nx, l.ny, l.nz] as [number, number, number], friction };
    }));
    if (this.host.caps.capacity < n) throw new Error(`host capacity ${this.host.caps.capacity} < ${n} bodies`);
    Object.assign(this.info.variant, prefix(this.host.info.variant, 'host.')); // hosts may fill some in at init (Rapier: version)
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
    this.anchorPos = new Float64Array(3 * n);
    this.anchorRot = new Float64Array(4 * n);
    this.refForce = new Float64Array(3 * n);
    this.refPending = new Uint8Array(n);
    this.slides = new Map();
    this.settles = new Uint8Array(n);
    this.freezeRetry = new Int32Array(n);
    this.pushed = new Int32Array(n);
    this.pushedAt = new Int32Array(n).fill(-2);
    this.rubblePos = new Float64Array(3 * n);
    this.rubbleRot = new Float64Array(4 * n);
    this.supporters = new Map();
    this.dependants = new Map();
    this.rubbleHash = new BoxHash(2 * this.radius.reduce((a, b) => Math.max(a, b), 1e-6));
    this.lattices = built.lattices;
    this.built = this.lattices.map((l) => {
      const f = new Uint8Array(l.nx * l.ny * l.nz);
      l.forEach((i, j, k) => { f[l.cell(i, j, k)] = 1; });
      return f;
    });
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
    if (this.native) this.lattices.forEach((lat, li) => lat.forEach((i, j, k, id) => cells.push({ lattice: li, i, j, k, id, rot: CUBE_ROTATIONS[lat.rotAt(i, j, k)]! })));
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

  /** Game command: wake every dormant cell and rubble body whose centre is within `radius` of `center`, at the next step. */
  wakeSphere(center: Vec3, radius: number): void {
    for (const id of this.supporters.keys()) {
      const p = vec(this.rubblePos, id);
      if (Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) <= radius) this.queuedThaws.push({ id, vel: null, cause: 'command' });
    }
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
    st.wokenByForce = st.wokenByImpact = st.wokenBySupport = st.settled = st.frozen = st.thawed = 0;
    const state = await this.host.read();
    const changes = new Map<number, ModeChange>();
    const movers: Mover[] = [];
    for (let n = 0; n < state.ids.length; n++) {
      const id = state.ids[n]!, pos = vec(state.pos, n), vel = vec(state.linVel, n), r = this.radius[id]!;
      movers.push({ id, pos, vel, awake: state.awake[n] === 1 });
      const slow = Math.hypot(...vel) < this.p.vRest && Math.hypot(...vec(state.angVel, n)) * r < this.p.vRest;
      const a = vec(this.anchorPos, id), q = quat(state.rot, n), qa = quat(this.anchorRot, id);
      const turn = 2 * Math.acos(Math.min(1, Math.abs(q[0] * qa[0] + q[1] * qa[1] + q[2] * qa[2] + q[3] * qa[3])));
      const drift = Math.hypot(pos[0] - a[0], pos[1] - a[1], pos[2] - a[2]) + turn * r;
      if (this.quiet[id]! > 0 && slow && drift <= this.p.restDrift * r) {
        // The window slides: drift counts from a pose at most restSteps old, so
        // solver creep (a few mm/s in settled Rapier piles) is rest too.
        if (++this.quiet[id]! % this.p.restSteps === 0) { this.anchorPos.set(pos, 3 * id); this.anchorRot.set(q, 4 * id); }
      } else {
        this.anchorPos.set(pos, 3 * id);
        this.anchorRot.set(q, 4 * id);
        this.quiet[id] = slow ? 1 : 0;
      }
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
    const dyn = this.moverHash(state);
    // Wake rules (forces use the speeds from before the step that produced them).
    const requests = [...this.queued.splice(0), ...this.forceWakes(state), ...this.impactWakes(movers)];
    const woken = this.wake(requests, changes);
    const thawed = this.thaw([...this.queuedThaws.splice(0), ...this.rubbleForceThaws(state, dyn), ...this.rubbleImpactThaws(movers)], woken.map((w) => w.id), changes);
    // Asleep bodies next to woken cells and thawed rubble.
    const wake = new Set<number>();
    for (const { li, cell } of woken) for (const id of this.near[li]!.get(cell) ?? []) if (this.tier[id] === TIER_ACTIVE && !changes.has(id)) wake.add(id);
    for (const id of thawed) {
      for (const o of this.touching(dyn, state, id, this.rubblePose(id))) if (!changes.has(o)) wake.add(o);
    }
    // Woken cells and thawed rubble are dynamic now: they need proxies around them too.
    for (const id of [...woken.map((w) => w.id), ...thawed]) movers.push({ id, pos: changes.get(id)!.pos!, vel: changes.get(id)!.linVel ?? [0, 0, 0], awake: true });
    const settled = this.settle(state, changes, dyn);
    const frozen = this.freeze(state, changes, settled, dyn);
    const resting = settled.size || frozen.size ? movers.filter((m) => !settled.has(m.id) && !frozen.has(m.id)) : movers;
    const list = this.withShell([...changes.values()].sort((a, b) => a.id - b.id), resting);
    this.host.apply({ changes: list, wake: [...wake].sort((a, b) => a - b), cells: this.cellChanges.splice(0) });
    st.total.byForce += st.wokenByForce; st.total.byImpact += st.wokenByImpact; st.total.bySupport += st.wokenBySupport;
    st.total.settled += st.settled; st.total.frozen += st.frozen; st.total.thawed += st.thawed;
    this.prevSpeed.fill(0);
    for (const m of movers) this.prevSpeed[m.id] = Math.hypot(...m.vel);
    const r = await this.host.step();
    this.stepIndex++;
    return r;
  }

  /**
   * W3: a cell pushed sideways beyond what friction can hold slides, and
   * with it every dormant cell ahead of it in its line (a packed lattice
   * cannot move one cell alone). The line is integrated as one friction
   * block: speed v grows by (push - hold) dt / M and friction takes it back
   * to 0 once the push drops, and the cell wakes when the block has slid
   * slideMin edges, with v handed back as velocity. A one-step spike that a
   * real line would absorb in millimetres never wakes anything. A lift over
   * the column's weight wakes at once.
   */
  private forceWakes(state: HostState): WakeRequest[] {
    const c = state.contacts;
    const out: WakeRequest[] = [];
    const g = gravityMag(this.scene!);
    const dt = this.scene!.dt;
    const pushed = new Set<number>();
    for (let n = 0; c && n < c.ids.length; n++) {
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
      const d = this.forceChange(id, f);
      if (!d) continue;
      const w = this.columnLoad(li, i, j, k, g);
      const mu = this.table[id]!.friction;
      // The push comes back as velocity, at most at the speed of the bodies
      // near the cell before or after that step.
      let cap = 0;
      for (const p of this.near[li]!.get(this.cellOf[id]!) ?? []) cap = Math.max(cap, this.prevSpeed[p]!, this.curSpeed.get(p) ?? 0);
      cap = Math.min(cap, this.p.handoffMax);
      const lift = this.p.kappa * w + this.p.forceMin;
      if (f[1] > lift && d[1] > lift) { out.push({ li, i, j, k, vel: handoff(d, dt / this.mass[id]!, cap) }); continue; }
      // Sideways: the smaller of the total and the change since the reference
      // (see above) is the push; friction under each column of the line holds
      // kappa * mu * (its column weight), plus the load from above on this cell.
      const fh = Math.hypot(f[0], f[2]), push = Math.min(fh, Math.hypot(d[0], d[2]));
      if (fh === 0) continue;
      const dir: Vec3 = [f[0] / fh, 0, f[2] / fh];
      const ax = Math.abs(dir[0]) >= Math.abs(dir[2]) ? 0 : 2, sgn = Math.sign(dir[ax]!);
      let hold = this.p.kappa * mu * (Math.max(0, -f[1]) + w) + this.p.forceMin, M = this.mass[id]!;
      const line: Array<[number, number, number]> = [[i, j, k]];
      for (let q = 1; q <= this.p.maxPlugDepth; q++) {
        const ii = ax === 0 ? i + sgn * q : i, kk = ax === 2 ? k + sgn * q : k;
        if (!lat.has(ii, j, kk)) break;
        hold += this.p.kappa * mu * this.columnLoad(li, ii, j, kk, g);
        M += this.mass[lat.idAt(ii, j, kk)]!;
        line.push([ii, j, kk]);
      }
      let s = this.slides.get(id);
      if (s && dotV(s.dir, dir) < 0) s = undefined; // reversed: a new slide
      const v0 = s?.v ?? 0, v = Math.max(0, v0 + ((push - hold) * dt) / M);
      if (v === 0) { this.slides.delete(id); continue; }
      const x = (s?.x ?? 0) + ((v0 + v) / 2) * dt;
      pushed.add(id);
      if (x >= this.p.slideMin * lat.frame.edge) {
        this.slides.delete(id);
        const u = Math.min(v, cap);
        for (const [ii, jj, kk] of this.p.slideLine ? line : [line[0]!]) out.push({ li, i: ii, j: jj, k: kk, vel: [dir[0] * u, 0, dir[2] * u] });
      } else this.slides.set(id, { v, x, dir, hold, M, line });
    }
    // Lines no longer pushed coast to a stop against the hold they last had.
    for (const [id, s] of this.slides) {
      if (pushed.has(id)) continue;
      if (this.tier[id] !== TIER_LATTICE) { this.slides.delete(id); continue; }
      const li = this.latticeOf[id]!, lat = this.lattices[li]!;
      const v = Math.max(0, s.v - (s.hold * dt) / s.M);
      s.x += ((s.v + v) / 2) * dt;
      s.v = v;
      if (s.x >= this.p.slideMin * lat.frame.edge) {
        this.slides.delete(id);
        const u = Math.min(v, this.p.handoffMax);
        for (const [i, j, k] of this.p.slideLine ? s.line : [s.line[0]!]) if (lat.has(i, j, k)) out.push({ li, i, j, k, vel: [s.dir[0] * u, 0, s.dir[2] * u] });
      }
      else if (v === 0) this.slides.delete(id);
    }
    return out;
  }

  /**
   * Dormant cells to wake so that none of `cells` (just woken) sits in a row
   * of the towers' footprint with dormant cells on both sides: for each such
   * row, the thinner dormant side, out to the footprint's edge.
   */
  private wedges(li: number, cells: Array<{ i: number; j: number; k: number }>): Array<[number, number, number]> {
    const lat = this.lattices[li]!, built = this.built[li]!;
    const inside = (i: number, j: number, k: number) => lat.inBounds(i, j, k) && built[lat.cell(i, j, k)] === 1;
    const out: Array<[number, number, number]> = [];
    for (const { i, j, k } of cells) {
      for (const ax of [0, 2]) {
        const at = (q: number): [number, number, number] => (ax === 0 ? [q, j, k] : [i, j, q]);
        const wall = (sgn: number): Array<[number, number, number]> | null => {
          let q = (ax === 0 ? i : k) + sgn;
          while (inside(...at(q)) && !lat.has(...at(q))) q += sgn; // woken cells of the row
          if (!inside(...at(q))) return null; // a free side
          const w: Array<[number, number, number]> = [];
          for (; inside(...at(q)); q += sgn) if (lat.has(...at(q))) w.push(at(q));
          return w;
        };
        const lo = wall(-1), hi = lo && wall(1);
        if (lo && hi) out.push(...(lo.length <= hi.length ? lo : hi));
      }
    }
    return out;
  }

  /** Weight resting on the floor under cell (i, j, k): its column from j up, and the rubble on it. */
  private columnLoad(li: number, i: number, j: number, k: number, g: number): number {
    const lat = this.lattices[li]!;
    let w = 0;
    for (const jj of lat.occupiedFrom(i, k, j)) w += this.restingLoad(lat.idAt(i, jj, k), g);
    return w;
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
    const g = gravityMag(scene);
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
          const seen = new Set<number>(), plug: Array<[number, number, number]> = [];
          for (let depth = 0; depth < this.p.maxPlugDepth && front.length; depth++) {
            const layer = front.filter(([i, j, k]) => lat.has(i, j, k) && !seen.has(lat.cell(i, j, k)));
            if (!layer.length) break;
            for (const [i, j, k] of layer) {
              seen.add(lat.cell(i, j, k));
              M += this.mass[lat.idAt(i, j, k)]!;
              plug.push([i, j, k]);
            }
            if (P / (mb + M) < this.p.vWake) break;
            front = layer.map(([i, j, k]) => [i + step[0], j + step[1], k + step[2]] as [number, number, number]);
          }
          // At shared speed u = P / (mb + M) against a hold H the plug stops
          // after u^2 (mb + M) / (2 H): sideways it slides on the cells under
          // its lowest row, upwards it lifts against its own weight (and
          // the body's). Too short to see: the body meets a wall, and W3
          // decides what its push breaks.
          if (!plug.length) continue;
          let H = (mb + M) * g;
          if (ax !== 1) {
            const low = new Map<number, number>();
            for (const [i, j, k] of plug) { const key = i * lat.nz + k; low.set(key, Math.min(j, low.get(key) ?? j)); }
            H = 0;
            for (const [key, j] of low) H += this.p.kappa * this.table[lat.idAt(Math.floor(key / lat.nz), j, key % lat.nz)]!.friction * this.columnLoad(li, Math.floor(key / lat.nz), j, key % lat.nz, g) + this.p.forceMin;
          }
          if ((P * P) / (2 * (mb + M) * H) < this.p.slideMin * lat.frame.edge) continue;
          for (const [i, j, k] of plug) {
            out.push({ li, i, j, k, vel: null });
            // The floor under a sideways plug (see plugColumns); a lifted plug leaves it behind.
            if (this.p.plugColumns && ax !== 1) for (let jj = 0; jj < j; jj++) out.push({ li, i, j: jj, k, vel: null });
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
      const wedged = new Set<number>();
      for (let from = 0; this.p.unwedge && from < detached.length;) {
        const more = this.wedges(li, detached.slice(from));
        from = detached.length;
        for (const d of detach(lat, this.p.support, more)) { detached.push(d); wedged.add(lat.cell(d.i, d.j, d.k)); }
      }
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
        const cause: TransitionCause = d.cause === 'support' || wedged.has(cell) ? 'support' : vel.has(cell) ? 'force' : commanded.has(cell) ? 'command' : 'impact';
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
        this.slides.delete(d.id);
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
  private settle(state: HostState, changes: Map<number, ModeChange>, dyn: BoxHash): Set<number> {
    const done = new Set<number>();
    const on = this.p.settle === 'auto' ? !this.native || this.host.caps.localCellChanges === true : this.p.settle;
    if (!on || !this.lattices.length) return done;
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
      for (const other of dyn.query(minOf(center, center, -e), minOf(center, center, e, true))) {
        if (blocked) break;
        if (snapping.has(other)) continue;
        const n = this.row.get(other)!;
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
      if (this.native) this.cellChanges.push({ lattice: c.li, i: c.i, j: c.j, k: c.k, id: c.id, rot: cubeRot });
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

  /**
   * Quiet bodies that did not settle freeze in place as static rubble. A body
   * freezes only when everything under it is already at rest (ground,
   * lattice, rubble, or rubble frozen earlier in this bottom-up pass), and
   * records the cells and rubble under it as its supporters: if any of them
   * moves, it thaws (T1). It is never moved.
   */
  private freeze(state: HostState, changes: Map<number, ModeChange>, settled: Set<number>, dyn: BoxHash): Set<number> {
    const done = new Set<number>();
    if (!this.p.rubble) return done;
    const cands: number[] = [];
    for (let n = 0; n < state.ids.length; n++) {
      const id = state.ids[n]!;
      if (this.tier[id] !== TIER_ACTIVE || changes.has(id) || settled.has(id) || this.quiet[id]! < this.p.restSteps) continue;
      if (this.stepIndex - this.activeSince[id]! < this.p.minActiveSteps || this.stepIndex < this.freezeRetry[id]!) continue;
      cands.push(n);
    }
    if (!cands.length) return done;
    const up = this.up();
    const height = (n: number) => -(state.pos[3 * n]! * up[0] + state.pos[3 * n + 1]! * up[1] + state.pos[3 * n + 2]! * up[2]);
    cands.sort((a, b) => height(b) - height(a) || state.ids[a]! - state.ids[b]!);
    const ground = this.scene!.ground;
    for (const n of cands) {
      const id = state.ids[n]!, shape = this.table[id]!.shape;
      const pose = { pos: vec(state.pos, n), rot: quat(state.rot, n) };
      // A moving body clearly under it (centre lower by a quarter of its
      // radius) still carries it: not yet. Neighbours beside it may keep
      // moving, and push it (T3) or hit it (T2) if they do.
      const h = dotV(pose.pos, up), r = this.radius[id]!;
      if (this.touching(dyn, state, id, pose, (p) => dotV(p, up) < h - 0.25 * r).some((o) => !done.has(o))) { // frozen in this pass: found below as rubble
        this.freezeRetry[id] = this.stepIndex + FREEZE_RETRY;
        continue;
      }
      // Supporters are generous (T1 thaws more, never less): everything at
      // rest that it touches lower down, or, wedged level with its
      // neighbours, everything at rest that it touches.
      const near = [...this.touchingRubble(id, pose).map((o) => ({ o, p: this.rubblePose(o).pos })), ...this.touchingCells(id, pose).map((o) => ({ o, p: this.cellCenter(o) }))];
      let sup = near.filter((x) => dotV(x.p, up) < h).map((x) => x.o);
      if (!sup.length) sup = near.map((x) => x.o);
      sup.sort((a, b) => a - b);
      const grounded = ground !== null && signedGroundDepth(shape, pose.pos, pose.rot, ground.y) > -this.p.touchTol;
      if (!grounded && !sup.length) continue; // resting only on moving bodies beside it
      this.tier[id] = TIER_RUBBLE;
      this.rubblePos.set(pose.pos, 3 * id);
      this.rubbleRot.set(pose.rot, 4 * id);
      this.supporters.set(id, sup);
      for (const o of sup) {
        const d = this.dependants.get(o);
        if (d) d.add(id); else this.dependants.set(o, new Set([id]));
      }
      this.rubbleHash.insert(id, pose.pos, this.radius[id]!);
      this.quiet[id] = 0;
      this.refPending[id] = 1;
      // At the pose the tiers record, which the host may have moved past by its state lag.
      changes.set(id, { id, mode: MODE_STATIC, pos: pose.pos, rot: pose.rot });
      done.add(id);
      this.stats.frozen++;
      this.onTransition?.(id, TIER_RUBBLE, 'freeze', this.stepIndex);
    }
    return done;
  }

  /**
   * Thaw rubble: the requested bodies, and by T1 every rubble body resting
   * (transitively) on one of them or on a lattice cell that woke this step.
   */
  private thaw(requests: Array<{ id: number; vel: Vec3 | null; cause: TransitionCause }>, wokenCells: number[], changes: Map<number, ModeChange>): number[] {
    const out: number[] = [];
    const vel = new Map<number, Vec3>();
    const queue: Array<{ id: number; cause: TransitionCause }> = [];
    for (const r of [...requests].sort((a, b) => a.id - b.id)) {
      if (this.tier[r.id] !== TIER_RUBBLE || vel.has(r.id) || queue.some((q) => q.id === r.id)) continue;
      if (r.vel) vel.set(r.id, r.vel);
      queue.push({ id: r.id, cause: r.cause });
    }
    const seeds = [...wokenCells];
    const visit = (id: number) => {
      for (const d of [...(this.dependants.get(id) ?? [])].sort((a, b) => a - b)) if (this.tier[d] === TIER_RUBBLE) queue.push({ id: d, cause: 'support' });
      this.dependants.delete(id);
    };
    for (const id of seeds) visit(id);
    for (let q = 0; q < queue.length; q++) {
      const { id, cause } = queue[q]!;
      if (this.tier[id] !== TIER_RUBBLE) continue;
      this.tier[id] = TIER_ACTIVE;
      for (const o of this.supporters.get(id)!) this.dependants.get(o)?.delete(id);
      this.supporters.delete(id);
      this.rubbleHash.remove(id);
      this.activeSince[id] = this.stepIndex;
      this.quiet[id] = 0;
      this.refPending[id] = 0;
      this.refForce.fill(0, 3 * id, 3 * id + 3);
      const { pos, rot } = this.rubblePose(id);
      changes.set(id, { id, mode: MODE_DYNAMIC, pos, rot, linVel: vel.get(id) ?? [0, 0, 0], angVel: [0, 0, 0] });
      out.push(id);
      this.stats.thawed++;
      this.onTransition?.(id, TIER_ACTIVE, cause, this.stepIndex);
      visit(id);
    }
    return out;
  }

  /** T3 for rubble: the lattice rule with the body's own weight for the column. */
  private rubbleForceThaws(state: HostState, dyn: BoxHash): Array<{ id: number; vel: Vec3; cause: TransitionCause }> {
    const c = state.contacts;
    const out: Array<{ id: number; vel: Vec3; cause: TransitionCause }> = [];
    if (!c || !this.supporters.size) return out;
    const g = gravityMag(this.scene!), dt = this.scene!.dt;
    for (let n = 0; n < c.ids.length; n++) {
      const id = c.ids[n]!;
      if (this.tier[id] !== TIER_RUBBLE) continue;
      const f: Vec3 = [c.force[3 * n]!, c.force[3 * n + 1]!, c.force[3 * n + 2]!];
      const d = this.forceChange(id, f);
      if (!d) continue;
      const m = this.mass[id]!, w = this.restingLoad(id, g), mu = this.table[id]!.friction;
      const hold = this.p.kappa * mu * (Math.max(0, -f[1]) + w) + this.p.forceMin;
      const lift = this.p.kappa * w + this.p.forceMin;
      const fh = Math.hypot(f[0], f[2]);
      // A push into something at rest that it touches cannot slide it alone
      // (static pairs report no forces, so the hold of what backs it is
      // invisible here): measured, ground cubes squeezed by a leaning pile
      // were force-thawed again and again without moving.
      const backed = fh > 0 && this.backedToward(id, [f[0] / fh, 0, f[2] / fh]);
      const slides = !backed && fh > hold && Math.hypot(d[0], d[2]) > hold;
      const lifts = f[1] > lift && d[1] > lift;
      if (!slides && !lifts) continue;
      // Consecutive steps over (a step without contact breaks the run).
      this.pushed[id] = this.pushedAt[id] === this.stepIndex - 1 ? this.pushed[id]! + 1 : 1;
      this.pushedAt[id] = this.stepIndex;
      if (this.pushed[id]! < this.p.rubbleForceSteps) continue;
      let cap = 0;
      for (const o of this.touching(dyn, state, id, this.rubblePose(id))) cap = Math.max(cap, this.prevSpeed[o]!, this.curSpeed.get(o) ?? 0);
      out.push({ id, vel: handoff(d, dt / m, Math.min(cap, this.p.handoffMax)), cause: 'force' });
    }
    return out;
  }

  /**
   * T2 for rubble: a body that will touch a rubble body within the look-ahead
   * thaws it if it closes in fast enough to set it moving: the shared speed
   * m v / (m + M) along the line between their centres is at least vWake (the
   * W2 rule for a plug one body deep). Neighbours jittering against it in
   * Rapier (up to 0.65 m/s) would thaw it every step otherwise. As in W2,
   * motion straight down does not count: what the rubble rests on takes it.
   * (Measured: a thawed stack sags at about 0.6 m/s for a few steps, with
   * its warm starts gone; counting that, every thaw thawed the next pile.)
   */
  private rubbleImpactThaws(movers: Mover[]): Array<{ id: number; vel: null; cause: TransitionCause }> {
    const out: Array<{ id: number; vel: null; cause: TransitionCause }> = [];
    if (!this.supporters.size) return out;
    const T = (this.host.caps.stateLag + this.p.lookahead) * this.scene!.dt;
    for (const m of movers) {
      if (!m.awake || Math.hypot(...m.vel) < this.p.vWake) continue;
      const end: Vec3 = [m.pos[0] + m.vel[0] * T, m.pos[1] + m.vel[1] * T, m.pos[2] + m.vel[2] * T];
      const r = this.radius[m.id]! + this.p.touchTol;
      const q = this.moverRot.get(m.id) ?? [0, 0, 0, 1];
      const mb = this.mass[m.id]!, up = this.up(), down = Math.min(0, dotV(m.vel, up));
      const v: Vec3 = [m.vel[0] - down * up[0], m.vel[1] - down * up[1], m.vel[2] - down * up[2]];
      for (const o of this.rubbleHash.query(minOf(m.pos, end, -r), minOf(m.pos, end, r, true))) {
        const pose = this.rubblePose(o);
        const dx = pose.pos[0] - m.pos[0], dy = pose.pos[1] - m.pos[1], dz = pose.pos[2] - m.pos[2], len = Math.hypot(dx, dy, dz) || 1;
        const closing = (v[0] * dx + v[1] * dy + v[2] * dz) / len;
        if ((mb * closing) / (mb + this.mass[o]!) < this.p.vWake) continue;
        if (signedDepth(this.table[m.id]!.shape, end, q, this.table[o]!.shape, pose.pos, pose.rot) > -this.p.touchTol) out.push({ id: o, vel: null, cause: 'impact' });
      }
    }
    return out;
  }

  /**
   * The change in contact force since the body came to rest, or null on the
   * step that takes the reference (see forceWakes).
   */
  private forceChange(id: number, f: Vec3): Vec3 | null {
    if (this.refPending[id]) {
      this.refPending[id] = 0;
      this.refForce.set(f, 3 * id);
      return null;
    }
    return [f[0] - this.refForce[3 * id]!, f[1] - this.refForce[3 * id + 1]!, f[2] - this.refForce[3 * id + 2]!];
  }

  /** Hash of the dynamic bodies in `state` (also records their rotations for T2). */
  private moverHash(state: HostState): BoxHash {
    const h = new BoxHash(this.rubbleHash.size);
    this.moverRot = new Map();
    this.row = new Map();
    for (let n = 0; n < state.ids.length; n++) {
      const id = state.ids[n]!;
      this.row.set(id, n);
      h.insert(id, vec(state.pos, n), this.radius[id]!);
      this.moverRot.set(id, quat(state.rot, n));
    }
    return h;
  }

  /** Dynamic bodies within touchTol of body `id` at `pose` (only those passing `keep`, checked first). */
  private touching(dyn: BoxHash, state: HostState, id: number, pose: { pos: Vec3; rot: Quat }, keep?: (pos: Vec3) => boolean): number[] {
    const r = this.radius[id]! + this.p.touchTol, shape = this.table[id]!.shape;
    const out: number[] = [];
    for (const o of dyn.query(minOf(pose.pos, pose.pos, -r), minOf(pose.pos, pose.pos, r, true))) {
      if (o === id) continue;
      const n = this.row.get(o);
      if (n === undefined) continue;
      const p = vec(state.pos, n);
      if (keep && !keep(p)) continue;
      if (Math.hypot(p[0] - pose.pos[0], p[1] - pose.pos[1], p[2] - pose.pos[2]) > r + this.radius[o]!) continue;
      if (signedDepth(shape, pose.pos, pose.rot, this.table[o]!.shape, p, quat(state.rot, n)) > -this.p.touchTol) out.push(o);
    }
    return out;
  }

  private touchingRubble(id: number, pose: { pos: Vec3; rot: Quat }): number[] {
    const r = this.radius[id]! + this.p.touchTol, shape = this.table[id]!.shape;
    return this.rubbleHash.query(minOf(pose.pos, pose.pos, -r), minOf(pose.pos, pose.pos, r, true)).filter((o) => {
      if (o === id) return false;
      const p = this.rubblePose(o);
      return signedDepth(shape, pose.pos, pose.rot, this.table[o]!.shape, p.pos, p.rot) > -this.p.touchTol;
    });
  }

  /** Body ids of dormant cells within touchTol of body `id` at `pose`. */
  private touchingCells(id: number, pose: { pos: Vec3; rot: Quat }): number[] {
    const r = this.radius[id]! + this.p.touchTol, shape = this.table[id]!.shape;
    const out: number[] = [];
    for (const lat of this.lattices) {
      const h = lat.frame.edge / 2, cube = { kind: 'box' as const, half: [h, h, h] as Vec3 };
      for (const [i, j, k] of cellsInBox(lat, minOf(pose.pos, pose.pos, -r), minOf(pose.pos, pose.pos, r, true), (i, j, k) => lat.has(i, j, k))) {
        if (signedDepth(shape, pose.pos, pose.rot, cube, lat.center(i, j, k), CUBE_ROTATIONS[lat.rotAt(i, j, k)]!) > -this.p.touchTol) out.push(lat.idAt(i, j, k));
      }
    }
    return out;
  }

  /**
   * Weight a body at rest carries, N: its own plus its share of the rubble
   * resting on it (each rubble body's load split evenly over its supporters).
   * Static pairs report no contact forces, so this is the only way the
   * capacity tests see rubble lying on a cell or on other rubble; without it
   * a cube under a frozen pile held only its own weight (measured: a 60 N
   * sideways squeeze thawed one under 125 bodies, which then all thawed by
   * support, refroze, and did it again every 64 steps).
   */
  private restingLoad(id: number, g: number, seen = new Set<number>()): number {
    let w = g * this.mass[id]!;
    if (seen.has(id)) return w;
    seen.add(id);
    for (const d of this.dependants.get(id) ?? []) {
      const n = this.supporters.get(d)?.length ?? 1;
      w += this.restingLoad(d, g, seen) / n;
    }
    return w;
  }

  /** Whether rubble `id` touches something at rest (rubble or a cell) in direction u (within 60 degrees). */
  private backedToward(id: number, u: Vec3): boolean {
    const pose = this.rubblePose(id);
    const at = (c: Vec3) => {
      const d: Vec3 = [c[0] - pose.pos[0], c[1] - pose.pos[1], c[2] - pose.pos[2]], len = Math.hypot(...d);
      return len > 0 && dotV(d, u) > 0.5 * len;
    };
    return this.touchingRubble(id, pose).some((o) => at(this.rubblePose(o).pos)) || this.touchingCells(id, pose).some((o) => at(this.cellCenter(o)));
  }

  rubblePose(id: number): { pos: Vec3; rot: Quat } {
    return { pos: vec(this.rubblePos, id), rot: quat(this.rubbleRot, id) };
  }

  private cellCenter(id: number): Vec3 {
    const lat = this.lattices[this.latticeOf[id]!]!;
    return lat.center(...lat.coords(this.cellOf[id]!));
  }

  /** Unit vector against gravity (up when there is none). */
  private up(): Vec3 {
    const g = this.scene!.gravity, m = Math.hypot(...g);
    return m > 0 ? [-g[0] / m, -g[1] / m, -g[2] / m] : [0, 1, 0];
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
    const rubble = this.rubbleHash.count;
    Object.assign(this.stats, { lattice, rubble, active: this.nextSpawn - lattice - rubble, proxies: this.proxies.size });
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
    for (const id of this.supporters.keys()) {
      s.pos.set(this.rubblePos.subarray(3 * id, 3 * id + 3), 3 * id);
      s.rot.set(this.rubbleRot.subarray(4 * id, 4 * id + 4), 4 * id);
    }
    return s;
  }

  dispose(): void { this.host.dispose(); }
}

interface Mover { id: number; pos: Vec3; vel: Vec3; awake: boolean }

const vec = (a: Float64Array, n: number): Vec3 => [a[3 * n]!, a[3 * n + 1]!, a[3 * n + 2]!];
const quat = (a: Float64Array, n: number): Quat => [a[4 * n]!, a[4 * n + 1]!, a[4 * n + 2]!, a[4 * n + 3]!];
const dotV = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Hand back the impulse a static body absorbed (force change d over a step,
 * scaled by dt / m) as velocity, at most `cap`: momentum is returned without
 * creating energy (a body cannot outrun its pusher). Never downwards.
 */
function handoff(d: Vec3, dtOverM: number, cap: number): Vec3 {
  let v: Vec3 = [d[0] * dtOverM, Math.max(0, d[1]) * dtOverM, d[2] * dtOverM];
  const s = Math.hypot(...v);
  if (s > cap) v = v.map((x) => (x * cap) / s) as Vec3;
  return v;
}
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

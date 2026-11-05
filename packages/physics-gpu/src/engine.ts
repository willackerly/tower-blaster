// The GPU AVBD pipeline behind the engine contract: prepare (sweeps) ->
// broadphase -> match (pair history) -> narrowphase -> colouring -> solve,
// one command buffer per step. Parameters are the reference solver's (physics-ref AvbdParams), so
// the two engines can be run side by side on the same settings. With AvbdParams.restitution on,
// the solve ends with the restitution pass (restitution.ts).
import { type BodyDesc, checkBlast, checkInputQueue, DEFAULT_RESTITUTION_COMBINE, emptySnapshot, type EngineHealth, type EngineInfo, inertiaOf, type InputEvent, massOf, type PhysicsEngine, type SceneDesc, type Snapshot, queueInputs, spawnedBodies, TIER_FREE, type Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { assertStorageFits, createDevice, isSoftwareAdapter, Readback } from '@tb/gpu';
import { type AvbdParams, avbdVariant, checkColoring, checkGapSlop, checkRecords, checkRemoved, checkRestitution, DEFAULT_AVBD, RESTITUTION_DEFAULTS } from '@tb/physics-ref';
import { Body, BodyProps, field, RestSlot, Shape, SolverBody, writeStruct } from '@tb/schema';
import { BlastPass, type DueBlast } from './blast.ts';
import { assertPairDispatch, Broadphase } from './broadphase.ts';
import { Coloring } from './coloring.ts';
import { DEFAULT_PAIRS_PER_BODY, gpuHealth } from './health.ts';
import { Narrowphase } from './narrowphase.ts';
import { restitutionWord } from './restitution.ts';
import { decodeBodies } from './snapshot.ts';
import { checkSleepRule, DEFAULT_SLEEP, SleepPass, type SleepRule } from './sleep.ts';
import { AvbdSolver, DEFAULT_DISPATCH, defaultTailThreads, HESSIAN_FORMS, type HessianForm, type RecordMode, type SolverDispatch } from './solver.ts';

export interface GpuEngineOptions {
  /** Use this device instead of creating one (it is then not destroyed by dispose()). */
  device?: GPUDevice;
  /**
   * Pair buffer size per body (default DEFAULT_PAIRS_PER_BODY, 16): the buffer holds pairsPerBody x
   * capacity broadphase pairs, and a step that finds more drops the rest (GpuDiagnostics.pairsOverflowSteps,
   * health()). init() refuses more than one indirect dispatch covers, 64 x maxComputeWorkgroupsPerDimension
   * (4,194,240 at the default limit; assertPairDispatch). The viewer adds 256 spare bodies to the capacity,
   * S15 sets 32 with the box test.
   */
  pairsPerBody?: number;
  /**
   * Room for push(): bodies the engine can hold (default: the scene's bodies
   * and inputs) and the largest bounding radius a pushed body may have
   * (default: the scene's largest). Buffers, the broadphase table and the
   * cell size are fixed at init from these, so push() throws beyond them,
   * and a replay with the pushed events in scene.inputs is bit-identical
   * only when it is created with the same options.
   */
  capacity?: number;
  maxRadius?: number;
  /** Without capacity: room for this many pushed bodies beyond the scene's bodies and inputs (default 0). */
  spare?: number;
  /**
   * How the primal sweep is dispatched (SolverDispatch in solver.ts): colours
   * below colorTail (default 8) get a dispatch each, the rest one workgroup of
   * tailThreads threads (1-256; default 256 on a hardware GPU, 64 on a software
   * adapter such as SwiftShader; see dispatch). indirectColors restores
   * the earlier indirect dispatch of colours 0-62, to time against; colour 63
   * always goes to the tail. None of them changes the result.
   */
  colorTail?: number;
  indirectColors?: boolean;
  /** Colours below colorTail by indirect dispatch sized to each colour (SolverDispatch.sizedColors); default on with sleep, off without. The same result either way. */
  sizedColors?: boolean;
  tailThreads?: number;
  /**
   * How the primal holds and solves each body's 6x6 system (SolverDispatch.hessian):
   * 'registers' (default), named scalars, unrolled (plan step 2b); 'array', the
   * earlier private arrays and loops. The same operations in the same order.
   */
  hessian?: HessianForm;
  /** Jones-Plassmann rounds (even, default 64). Fewer leave bodies uncoloured; for tests of that path. */
  colorRounds?: number;
  /**
   * The broadphase's box test (broadphase.ts; default false): box pairs that
   * the narrowphase's separating axes keep further apart than its margin are
   * dropped before they take a pair slot. It changes no contact, only how
   * many slots a step needs: 2.1-2.3x fewer for Kapla planks, standing or in
   * a pile (their bounding spheres are 42x their volume); 2% fewer for cubes.
   */
  boxBroadphase?: boolean;
  /**
   * Per-body sleep (sleep.ts; roadmap E2), opt-in: off when absent or false, and EngineInfo.variant lists it and
   * its thresholds only when they are given. It acts only on a scene with SceneDesc.sleep set. A body that has been
   * quiet long enough sleeps: it stops moving and is no longer solved, and the bodies touching it solve against it
   * as an anchor (Snapshot.awake 0). An awake body moving into it, a contact pressing deeper than wakeDepth, a blast,
   * or the removal of a body it may touch wakes it with every sleeper it touches, transitively. sleepSpeed (v_sleep, scene units/s, default 0.05), sleepSteps (T, default
   * 30), sleepDrift (the window displacement as a fraction of the bounding radius, default 0.02), wakeSpeed (default
   * 0.1 units/s) and wakeDepth (default 0.01 units) set the rule (DEFAULT_SLEEP). Not with AvbdParams.restitution yet.
   */
  sleep?: boolean;
  sleepSpeed?: number;
  sleepSteps?: number;
  sleepDrift?: number;
  wakeSpeed?: number;
  wakeDepth?: number;
  /**
   * Settle (roadmap E2 step 2b): the first settleSteps steps after init() solve with settleIterations instead of
   * AvbdParams.iterations, then the rest with AvbdParams.iterations. For a structure that holds only at more
   * iterations than its collapse needs, such as the real-size Kapla tower (120 to stand, 40 to fall): with sleep it
   * settles at the high count and falls asleep, and what wakes it later runs at the low one. Both or neither; off
   * when absent, and EngineInfo.variant lists them only when given. Steps before settleSteps are bit-identical to an
   * engine at AvbdParams.iterations = settleIterations.
   */
  settleSteps?: number;
  settleIterations?: number;
  /**
   * With sleep: skip a step that starts with no body awake and no input due (default true). Such a step changes
   * nothing (every body is an anchor, every contact frozen; sleep.ts), so skipping it is exact; step() then only
   * counts it (GpuDiagnostics.sleepSkippedSteps). The engine learns that nothing is awake from a 4-byte read of the
   * sleep pass's awake count, which lands a step or two late, so a scene that falls asleep is skipped from a step or
   * two after. false runs every step, to time or compare against. Writing body buffers behind the engine's back (a
   * test's kick) is not an input: a skipped step does not see it.
   */
  sleepSkip?: boolean;
}

/** The sleep rule these options set (DEFAULT_SLEEP where they leave a threshold out). */
export function sleepRuleOf(opts: Pick<GpuEngineOptions, 'sleepSpeed' | 'sleepSteps' | 'sleepDrift' | 'wakeSpeed' | 'wakeDepth'>): SleepRule {
  const d = DEFAULT_SLEEP;
  return { speed: opts.sleepSpeed ?? d.speed, steps: opts.sleepSteps ?? d.steps, drift: opts.sleepDrift ?? d.drift, wakeSpeed: opts.wakeSpeed ?? d.wakeSpeed, wakeDepth: opts.wakeDepth ?? d.wakeDepth };
}

/**
 * The contact layout (AvbdParams.records) a GpuAvbdEngine with these params and options solves with: params.records
 * when given (0 points, 1 the exact record, 2 centre friction); unset, 1, the GPU default since the M5 sweep of
 * 2026-10-27 (the point form's physics, bit for bit on SwiftShader; 26-38% faster per step on the M5), except 0
 * where only points are implemented: the array Hessian (GpuEngineOptions.hessian 'array'). An explicit records 1
 * or 2 with the array Hessian still throws in the engine. Restitution (AvbdParams.restitution) runs on records 1
 * as on points, the same floats.
 */
export function gpuRecordsLayout(params: Pick<Partial<AvbdParams>, 'records'>, opts: Pick<GpuEngineOptions, 'hessian'> = {}): RecordMode {
  if (params.records !== undefined) return params.records as RecordMode;
  return opts.hessian === 'array' ? 0 : 1;
}

/**
 * The lattice colouring (AvbdParams.colorMode) a GpuAvbdEngine with these params colours with: params.colorMode when
 * given (0 the hash priority's greedy colouring alone, 1-4 the lattice preferences, physics-ref coloring.ts); unset,
 * 3, the GPU default since 2026-10-28. On the M5 sweep (S4 10k at I = 20, with records 1) it cuts the colours of a
 * resting city from 10 to 4 and the step from 9.6 to 5.2 ms (steps 60-240) and from 5.0 to 3.1 ms (steps 300-480),
 * and against colorMode 0 it held every quality gate at the game's
 * setting (40 iterations, gapSlop 3e-5) and at 20 iterations, within colorMode 0's own spread over body orders and
 * 1e-6 m start jitters (f64 reference and SwiftShader), with every Keystone par line clearing as before
 * (perf-competition r3-colormode). A scene with no cubes on the world lattice colours as with 0. The reference engine
 * is unchanged: unset is 0 there.
 */
export const GPU_DEFAULT_COLOR_MODE = 3;
export function gpuColorMode(params: Pick<Partial<AvbdParams>, 'colorMode'>): number {
  return params.colorMode ?? GPU_DEFAULT_COLOR_MODE;
}

export interface GpuDiagnostics {
  /** The last step's broadphase pairs: how many it found, and how many fit the pair buffer (the rest were dropped). */
  pairsRequired: number;
  pairsWritten: number;
  /** The pair buffer's size (GpuEngineOptions.pairsPerBody x the engine's capacity). */
  maxPairs: number;
  /**
   * Every step since init(), from the broadphase's sticky counters (broadphase.ts): the most
   * pairs one required, and how many required more than maxPairs. A step that overflows drops
   * the pairs between the bodies latest in index order, which then pass through each other.
   */
  pairsRequiredPeak: number;
  pairsOverflowSteps: number;
  /** Steps submitted since init(), which the counters cover unless the GPU rejected one (finish() reports that). */
  steps: number;
  colors: number;
  uncolored: number;
  colorOverflow: number;
  /** Steps step() skipped because nothing was awake and no input was due (GpuEngineOptions.sleepSkip); 0 without sleep. */
  sleepSkippedSteps: number;
}

/**
 * What the last step's restitution pass did, as the reference's
 * StepStats.restitution: the points it bounced (P > 0), the normal impulse it
 * applied in all (N s, supports included), and the impulse it took from the
 * ground (ground normals are +y). Read back from the pass's state, summed in
 * f64. The reference's momentum (the bodies' total linear momentum change)
 * is not kept here: it equals groundImpulse to rounding.
 */
export interface GpuRestitutionStats {
  contacts: number;
  impulse: number;
  groundImpulse: Vec3;
}

/**
 * GpuRestitutionStats from a copy of the pass's state (AvbdSolver.restSlots)
 * after a step that wrote `pairsWritten` pair slots for n bodies.
 */
export function restitutionStatsOf(slots: ArrayBuffer, pairsWritten: number, maxPairs: number, n: number): GpuRestitutionStats {
  const f = new Float32Array(slots), u = new Uint32Array(slots), stride = RestSlot.size / 4;
  const at = (name: string) => RestSlot.fields.find((x) => x.name === name)!.offset / 4;
  const P = at('P'), flags = at('flags');
  const out: GpuRestitutionStats = { contacts: 0, impulse: 0, groundImpulse: [0, 0, 0] };
  const add = (k: number, ground: boolean) => {
    const fl = u[k * stride + flags]!;
    for (let q = 0; q < 4; q++) {
      // Bit q: the point bounces; bit q + 4: it is a support.
      if (!((fl >> q) & 0x11)) continue;
      const pq = f[k * stride + P + q]!;
      out.impulse += pq;
      if (ground) out.groundImpulse[1] += pq;
      if ((fl >> q) & 1 && pq > 0) out.contacts++;
    }
  };
  for (let k = 0; k < pairsWritten; k++) add(k, false);
  for (let i = 0; i < n; i++) add(maxPairs + i, true);
  return out;
}

/**
 * A step's stages in the order encodeStep() runs them (GpuAvbdEngine.probeStages): blasts and prepare (sweeps and
 * inflated spheres), the broadphase (grid sort and pair lists), match and the narrowphase, the colouring, and the
 * solve (contact setup, every sweep and dual update, finalize, the restitution pass).
 */
export const STEP_STAGES = ['prepare', 'broadphase', 'narrowphase', 'coloring', 'solve'] as const;
export type StepStage = (typeof STEP_STAGES)[number];

export class GpuAvbdEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  // GpuEngineOptions.sleepSkip: the last step that ended with no body awake (-1: none known), the step after the last
  // one that applied an input (a skip needs quietStep >= eventStep), whether an awake count is being read, and how
  // many steps step() skipped.
  private quietStep = -1;
  private eventStep = 0;
  private counting = false;
  private skipped = 0;
  private readonly params: AvbdParams;
  private device: GPUDevice | null = null;
  private ownsDevice = false;
  /** Set when the device can't be trusted to have run what was submitted. */
  private failure: string | null = null;
  private readonly onGpuError = (ev: Event) => { this.failure ??= `GPU error: ${(ev as GPUUncapturedErrorEvent).error.message}`; };
  private scene: SceneDesc | null = null;
  private pending: InputEvent[] = [];
  /** Removed bodies (engine-api remove.ts): their slots are tombstones (tier free), which every stage skips. */
  private gone = new Set<number>();
  private n = 0;
  private capacity = 0;
  private rmax = 0;
  private cellSize = 1;
  /** The primal dispatch init() chose, with the adapter's default tail width filled in; null before init. */
  dispatch: SolverDispatch | null = null;
  /** The solver's contact layout (gpuRecordsLayout(): AvbdParams.records, unset 1): 0 points, 1 exact records, 2 centre-friction records. */
  readonly records: RecordMode;
  /** The colouring's lattice preference (gpuColorMode(): AvbdParams.colorMode, unset 3). */
  readonly colorMode: number;
  private parts: { bodies: GPUBuffer; shapes: GPUBuffer; props: GPUBuffer; spheres: GPUBuffer; sweep: GPUBuffer; prev: GPUBuffer; bp: Broadphase; np: Narrowphase; col: Coloring; solver: AvbdSolver; blast: BlastPass; readback: Readback; sleep: SleepPass | null } | null = null;
  /** Counts dispose() calls (init() makes one), so an init() that awaited across another knows it was overtaken. */
  private generation = 0;

  constructor(params: Partial<AvbdParams> = {}, private readonly opts: GpuEngineOptions = {}) {
    this.params = { ...DEFAULT_AVBD, ...params };
    if (!this.params.postStabilize) throw new Error('GpuAvbdEngine: only postStabilize = true is implemented');
    // The same AvbdParams as the reference, switch on or off.
    checkRestitution(this.params);
    checkGapSlop(this.params);
    checkRemoved(this.params);
    checkRemoved(opts);
    checkRecords(this.params);
    checkColoring(this.params);
    const check = (k: 'capacity' | 'spare' | 'pairsPerBody' | 'maxRadius' | 'colorTail' | 'tailThreads' | 'colorRounds' | 'settleSteps' | 'settleIterations', ok: (v: number) => boolean, what: string) => {
      const v = opts[k];
      if (v !== undefined && !(typeof v === 'number' && ok(v))) throw new Error(`GpuAvbdEngine: GpuEngineOptions.${k} must be ${what}, got ${v}`);
    };
    check('capacity', (v) => Number.isInteger(v) && v >= 1, 'a positive integer');
    check('spare', (v) => Number.isInteger(v) && v >= 0, 'a non-negative integer');
    check('pairsPerBody', (v) => Number.isInteger(v) && v >= 1, 'a positive integer');
    check('maxRadius', (v) => Number.isFinite(v) && v >= 0, 'a finite number >= 0');
    check('colorTail', (v) => Number.isInteger(v) && v >= 0 && v <= 63, 'an integer from 0 to 63');
    check('tailThreads', (v) => Number.isInteger(v) && v >= 1 && v <= 256, 'an integer from 1 to 256');
    check('colorRounds', (v) => Number.isInteger(v) && v >= 2 && v % 2 === 0, 'an even integer >= 2');
    check('settleSteps', (v) => Number.isInteger(v) && v >= 0, 'a non-negative integer');
    check('settleIterations', (v) => Number.isInteger(v) && v >= 1, 'a positive integer');
    if ((opts.settleSteps === undefined) !== (opts.settleIterations === undefined)) throw new Error('GpuAvbdEngine: GpuEngineOptions.settleSteps and settleIterations go together');
    for (const k of ['indirectColors', 'sizedColors', 'boxBroadphase', 'sleep', 'sleepSkip'] as const) if (opts[k] !== undefined && typeof opts[k] !== 'boolean') throw new Error(`GpuAvbdEngine: GpuEngineOptions.${k} must be a boolean, got ${opts[k]}`);
    try { checkSleepRule(sleepRuleOf(opts)); } catch (e) { throw new Error(`GpuAvbdEngine: GpuEngineOptions.${(e as Error).message}`); }
    if (opts.sleep && this.params.restitution) throw new Error('GpuAvbdEngine: GpuEngineOptions.sleep is not implemented with AvbdParams.restitution yet');
    if (opts.hessian !== undefined && !HESSIAN_FORMS.includes(opts.hessian)) throw new Error(`GpuAvbdEngine: GpuEngineOptions.hessian must be one of ${HESSIAN_FORMS.join(', ')}, got ${opts.hessian}`);
    // Manifold records (AvbdParams.records, checked above): the solver's contact layout, in the register form only;
    // unset, records 1, or points where only they are implemented (gpuRecordsLayout).
    const records = gpuRecordsLayout(this.params, opts);
    if (records !== 0 && (opts.hessian ?? DEFAULT_DISPATCH.hessian) !== 'registers') throw new Error(`GpuAvbdEngine: AvbdParams.records ${records} needs GpuEngineOptions.hessian registers, got ${opts.hessian}`);
    // The restitution pass reads and resets points or exact records (restitution.ts), not centre-friction records.
    if (records === 2 && this.params.restitution) throw new Error('GpuAvbdEngine: AvbdParams.restitution is not implemented with AvbdParams.records 2 on the GPU yet');
    this.records = records;
    // Every param, but an opt-in switch and its params only while it is on (avbdVariant): result keys do not change.
    const variant: Record<string, number | boolean | string> = avbdVariant(this.params);
    // records as given, 0 included (avbdVariant drops it as off): on the GPU unset is not 0 but gpuRecordsLayout()'s
    // layout, so avbd-gpu (unset) and avbd-gpu:records=0 (points) are different engines. Results named avbd-gpu
    // before records 1 became the default were points, and so were those with restitution on until restitution
    // ran on records 1 (gpuRecordsLayout gave it points): the same floats, other timings.
    if (this.params.records !== undefined) variant.records = this.params.records;
    // colorMode the same way (avbdVariant drops 0 as off): unset is gpuColorMode()'s 3 on the GPU, so avbd-gpu (unset)
    // and avbd-gpu:colorMode=0 (the hash colouring alone) are different engines, and avbd-gpu:colorMode=3 keeps the
    // key it had. Results named avbd-gpu before colorMode 3 became the default were colorMode 0.
    this.colorMode = gpuColorMode(this.params);
    if (this.params.colorMode !== undefined) variant.colorMode = this.params.colorMode;
    // Options that size the buffers or shape the dispatch change the work per step (e.g. the broadphase's key bits), so they are part of the variant.
    for (const k of ['capacity', 'spare', 'pairsPerBody', 'maxRadius', 'colorTail', 'indirectColors', 'tailThreads', 'colorRounds', 'hessian', 'boxBroadphase', 'sleep', 'sleepSpeed', 'sleepSteps', 'sleepDrift', 'wakeSpeed', 'wakeDepth', 'settleSteps', 'settleIterations', 'sleepSkip', 'sizedColors'] as const) if (opts[k] !== undefined) variant[k] = opts[k];
    this.info = { name: 'avbd-gpu', variant, backend: 'webgpu', integrator: { substeps: 1 } };
  }

  async init(scene: SceneDesc): Promise<void> {
    // As the reference, switch on or off; checked before anything changes.
    const groundE = scene.ground?.restitution;
    if (groundE !== undefined && !(groundE >= 0 && groundE <= 1)) throw new Error(`GpuAvbdEngine: SceneDesc.ground.restitution must be in [0, 1], got ${groundE}`);
    checkInputQueue(scene.bodies.length, [...scene.inputs].sort((a, b) => a.step - b.step));
    this.failure = null;
    this.dispose();
    const generation = this.generation;
    if (this.opts.device) this.device = this.opts.device;
    else { this.device = (await createDevice()).device; this.ownsDevice = true; }
    const device = this.device;
    // A rejected command buffer or a lost device makes submit a silent no-op that
    // onSubmittedWorkDone() still reports as done, which would time nothing at all.
    // Record either, so step() and finish() fail instead.
    device.addEventListener('uncapturederror', this.onGpuError);
    void device.lost.then((info) => { if (this.device === device) this.failure ??= `GPU device lost (${info.reason}): ${info.message}`; });
    const adapter = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
    if (adapter) this.info.backend = `webgpu:${adapter.vendor}/${adapter.architecture}`;
    // Unknown adapters count as hardware: the width only sets the speed, never the result.
    this.dispatch = {
      colorTail: this.opts.colorTail ?? DEFAULT_DISPATCH.colorTail, indirectColors: this.opts.indirectColors ?? DEFAULT_DISPATCH.indirectColors,
      // Sized colour dispatches by default with sleep (its sleepers have no colour); as before without.
      sizedColors: this.opts.sizedColors ?? (!!this.opts.sleep || DEFAULT_DISPATCH.sizedColors),
      tailThreads: this.opts.tailThreads ?? defaultTailThreads(adapter ? isSoftwareAdapter(adapter) : false),
      hessian: this.opts.hessian ?? DEFAULT_DISPATCH.hessian,
    };
    this.scene = scene;
    const all = [...scene.bodies, ...spawnedBodies(scene.inputs)];
    if (this.opts.capacity !== undefined && this.opts.capacity < all.length) throw new Error(`GpuAvbdEngine: capacity ${this.opts.capacity} is below the scene's ${all.length} bodies and inputs`);
    this.capacity = Math.max(1, this.opts.capacity ?? all.length + (this.opts.spare ?? 0));
    const maxPairs = (this.opts.pairsPerBody ?? DEFAULT_PAIRS_PER_BODY) * this.capacity;
    const p = this.params;
    this.rmax = all.reduce((m, b) => Math.max(m, boundingRadius(b.shape)), this.opts.maxRadius ?? 0);
    // Every overlapping (inflated) pair must lie in adjacent cells.
    this.cellSize = Math.max(1e-3, 2 * (this.rmax + (p.sweep ? p.maxSweep : 0)) + p.margin);
    // The per-pair kernels run as one indirect dispatch over the pairs written (Broadphase.total), and a
    // dispatch past the device's workgroup limit does nothing at all: refuse a pair buffer it cannot cover.
    assertPairDispatch(device, maxPairs, 'GpuAvbdEngine', 'lower pairsPerBody or capacity');
    // The contact buffer is the largest (1 KB per pair slot, 768 B with
    // records; a manifold is 96 B), so checking it first means no stage throws
    // halfway through allocating, which would leak what it had made.
    assertStorageFits(device, AvbdSolver.contactBytes(this.capacity, maxPairs, this.records), 'avbd contacts');
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label }));
    // A pipeline that fails to build (e.g. on Metal, a kernel whose register use
    // lowers maxTotalThreadsPerThreadgroup below its workgroup size) is an error
    // reported later, not a throw, and step() would then fail on the first
    // submit. Catch it here instead, with what was being built.
    //
    // The stages are built into a local and published as this.parts only after
    // the error scopes resolve, in the same synchronous run that writes the
    // scene's bodies: step(), push() and snapshot() during init() must keep
    // failing with 'init() first', never run on buffers that hold no bodies yet
    // with the previous scene's n, pending inputs and step index. A dispose()
    // or another init() in that window wins: this one frees what it built and
    // rejects, instead of installing it over (and leaking) the other's.
    device.pushErrorScope('internal');
    device.pushErrorScope('validation');
    let parts: GpuAvbdEngine['parts'] = null;
    let thrown: unknown = null;
    try {
      const bodies = buf(this.capacity * Body.size, 'bodies');
      const shapes = buf(this.capacity * Shape.size, 'shapes');
      const props = buf(this.capacity * BodyProps.size, 'body props');
      const spheres = buf(this.capacity * 16, 'inflated spheres');
      const sweep = buf(this.capacity * 4, 'sweep');
      const prev = buf(maxPairs * 8, 'pair history lookup');
      const bp = new Broadphase(device, spheres, this.capacity, maxPairs, undefined, this.opts.boxBroadphase ? { bodies, shapes, sweep } : undefined);
      const np = new Narrowphase(device, bodies, shapes, bp.pairs, bp.total, this.capacity, maxPairs, sweep, prev);
      // Sleep only where both the engine and the scene allow it.
      const sleeps = !!this.opts.sleep && scene.sleep;
      const col = new Coloring(device, np.manifolds, bp.total, this.capacity, maxPairs, this.opts.colorRounds, { colorMode: this.colorMode, colorPriority: p.colorPriority ?? 0, bodies, shapes });
      const solver = new AvbdSolver(device, this.capacity, maxPairs, {
        bodies, props, spheres, sweep, prev, manifolds: np.manifolds, groundManifolds: np.groundManifolds,
        pairs: bp.pairs, total: bp.total, offsets: bp.offsets,
        order: col.order, colorStart: col.colorStart, dispatch: col.dispatch, rowStart: col.rowStart, rowLength: col.rowLength, adjSlot: col.adjSlot,
      }, this.dispatch, this.records, p.gapSlop ?? 0, p.restitution ? {
        threshold: p.restitutionThreshold ?? RESTITUTION_DEFAULTS.restitutionThreshold, rounds: p.restitutionRounds ?? RESTITUTION_DEFAULTS.restitutionRounds,
        groundRestitution: scene.ground?.restitution ?? 0, combine: scene.restitutionCombine ?? DEFAULT_RESTITUTION_COMBINE,
      } : null, sleeps);
      const sleep = sleeps ? new SleepPass(device, sleepRuleOf(this.opts), this.capacity, bodies, props, np.manifolds, bp.total) : null;
      parts = { bodies, shapes, props, spheres, sweep, prev, bp, np, col, solver, blast: new BlastPass(device, bodies, props, shapes, solver.solver), readback: new Readback(device), sleep };
    } catch (e) {
      thrown = e;
    }
    // Both popped before awaiting either, so neither scope stays pushed across an
    // await (on a shared device, it would capture errors of the caller's work).
    const [validation, internal] = await Promise.all([device.popErrorScope(), device.popErrorScope()]);
    if (this.generation !== generation) {
      if (parts) GpuAvbdEngine.free(parts);
      if (!this.opts.device && this.device !== device) device.destroy(); // its own device, which nothing holds now
      throw new Error('GpuAvbdEngine: init() was overtaken by dispose() or another init() before it finished');
    }
    if (thrown) throw thrown;
    const failed = validation ?? internal;
    if (failed) {
      const d = this.dispatch;
      if (parts) GpuAvbdEngine.free(parts);
      this.dispose();
      throw new Error(`GpuAvbdEngine: init() could not build the GPU pipelines (hessian ${d.hessian}, tailThreads ${d.tailThreads}${this.records ? `, records ${this.records}` : ''}): ${failed.message}`);
    }
    this.parts = parts;
    this.n = 0;
    this.gone = new Set();
    for (const b of scene.bodies) this.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
    this.quietStep = -1;
    this.eventStep = 0;
    this.counting = false;
    this.skipped = 0;
  }

  /** Write body i (= n) into every per-body buffer; one shape per body. */
  private add(b: BodyDesc): void {
    const { device, parts } = this;
    const i = this.n++;
    const one = (layout: typeof Body, value: Parameters<typeof writeStruct>[3], target: GPUBuffer) => {
      const v = new DataView(new ArrayBuffer(layout.size));
      writeStruct(v, layout, 0, value);
      device!.queue.writeBuffer(target, i * layout.size, v.buffer);
    };
    const m = massOf(b);
    one(Body, { pos: b.pos, invMass: 1 / m, rot: b.rot, linVel: b.linVel, flags: 1, angVel: b.angVel, shape: i }, parts!.bodies);
    one(Shape, b.shape.kind === 'box' ? { half: b.shape.half, kind: 0 } : { half: [b.shape.radius, 0, 0], kind: 1 }, parts!.shapes);
    one(BodyProps, { inertia: inertiaOf(b), mass: m, friction: b.friction, radius: boundingRadius(b.shape), sphere: b.shape.kind === 'sphere' ? 1 : 0, restitution: restitutionWord(b.restitution) }, parts!.props);
    // prevVel = initial velocity, as the reference (no adaptive warm-start kick on the first step).
    one(SolverBody, { prevVel: b.linVel }, parts!.solver.solver);
    parts!.sleep?.add(i, b.pos, b.rot);
  }

  /**
   * Make body i a tombstone (engine-api remove.ts): at rest, tier free and asleep, in Body[] before the step's
   * work runs. The kernels skip it from then on (prepare, broadphase, ground contacts, solver start, blasts); a
   * blast due before the removal in the same step pushes it, then this stops it, as the reference does.
   */
  private remove(i: number): void {
    const { device, parts } = this;
    const at = (name: string) => i * Body.size + field(Body, name).offset;
    device!.queue.writeBuffer(parts!.bodies, at('linVel'), new Float32Array(3));
    device!.queue.writeBuffer(parts!.bodies, at('angVel'), new Float32Array(3));
    device!.queue.writeBuffer(parts!.bodies, at('flags'), new Uint32Array([TIER_FREE << 8]));
    this.gone.add(i);
  }

  push(events: InputEvent[]): void {
    if (!this.parts) throw new Error('init() first');
    // Checked before queueing any, so a rejected batch changes nothing.
    const room = this.n + spawnedBodies(this.pending).length + spawnedBodies(events).length;
    if (room > this.capacity) throw new Error(`GpuAvbdEngine: push() needs room for ${room} bodies, capacity is ${this.capacity} (GpuEngineOptions.capacity or spare)`);
    for (const ev of events) {
      if (ev.kind !== 'spawn') continue;
      const r = boundingRadius(ev.body.shape);
      if (r > this.rmax) throw new Error(`GpuAvbdEngine: pushed body radius ${r} exceeds ${this.rmax}, the largest the broadphase cells were sized for (GpuEngineOptions.maxRadius)`);
    }
    // Stable insertion keeps push order among events due at the same step.
    const pending = queueInputs(this.pending, events);
    checkInputQueue(this.n, pending, this.gone);
    this.pending = pending;
  }

  step(): void {
    const { parts } = this;
    // Nothing awake at the end of step quietStep, nothing has happened since, and nothing is due now: this step would
    // change nothing (GpuEngineOptions.sleepSkip).
    if (parts?.sleep && this.opts.sleepSkip !== false && !this.failure && this.quietStep >= this.eventStep && !(this.pending.length && this.pending[0]!.step <= this.stepIndex)) {
      this.stepIndex++;
      this.skipped++;
      return;
    }
    this.encodeStep();
    if (parts?.sleep && this.opts.sleepSkip !== false && !this.counting) this.countAwake(this.stepIndex - 1);
  }

  /** Reads the awake count the sleep pass left after step k (one read at a time; the next step() asks again). */
  private countAwake(k: number): void {
    const parts = this.parts!, generation = this.generation;
    this.counting = true;
    parts.readback.read(parts.sleep!.scratch, 4, parts.sleep!.countOffset).then((buf) => {
      if (this.generation !== generation || this.parts !== parts) return;
      this.counting = false;
      if (new Uint32Array(buf)[0] === 0) this.quietStep = Math.max(this.quietStep, k);
    }, () => { if (this.generation === generation) this.counting = false; });
  }

  /**
   * Bench only (the solver probe, probe.ts): step() with the solve pass
   * timestamped. The work submitted is step()'s.
   */
  probeStep(solveTimestamps: GPUComputePassTimestampWrites): void {
    this.encodeStep(solveTimestamps);
  }

  /**
   * Bench only (the sleep probe, probe-sleep.ts): step() with `mark` called in the step's command encoder
   * at the start and after each of STEP_STAGES, between passes, so the probe can put a timestamped pass
   * there. The work submitted is step()'s, plus whatever `mark` encodes.
   */
  probeStages(mark: (enc: GPUCommandEncoder, at: 'start' | StepStage) => void): void {
    this.encodeStep(undefined, mark);
  }

  /**
   * Bench only (the solver probe): the device and the stages of the last
   * step, to read its colour structure and time pieces of its sweep
   * (AvbdSolver.encodeProbe), and the buffers each stage ends by writing
   * (the sleep probe's markers read them, so they wait for the stage). step() does not use this.
   */
  probeParts(): {
    device: GPUDevice; n: number; iterations: number; dispatch: SolverDispatch; solver: AvbdSolver; col: Coloring; total: GPUBuffer; maxPairs: number; capacity: number;
    pairs: GPUBuffer; bodies: GPUBuffer; spheres: GPUBuffer; manifolds: GPUBuffer;
  } {
    const { device, parts } = this;
    if (!device || !parts) throw new Error('init() first');
    return {
      device, n: this.n, iterations: this.params.iterations, solver: parts.solver, col: parts.col, total: parts.bp.total,
      maxPairs: parts.solver.maxPairs, capacity: this.capacity, dispatch: this.dispatch!,
      pairs: parts.bp.pairs, bodies: parts.bodies, spheres: parts.spheres, manifolds: parts.np.manifolds,
    };
  }

  private encodeStep(solveTimestamps?: GPUComputePassTimestampWrites, mark?: (enc: GPUCommandEncoder, at: 'start' | StepStage) => void): void {
    const { device, parts, scene } = this;
    if (!device || !parts || !scene) throw new Error('init() first');
    if (this.failure) throw new Error(`GpuAvbdEngine: ${this.failure}`);
    // Spawns are written now; a blast acts on the bodies that exist when it is due (ids below its count).
    const blasts: DueBlast[] = [];
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) {
      const ev = this.pending.shift()!;
      this.eventStep = this.stepIndex + 1;
      if (ev.kind === 'spawn') this.add(ev.body);
      else if (ev.kind === 'remove') {
        this.remove(ev.id);
        // With sleep, everything that could touch the removed body wakes (sleep.ts): a blast of no impulse and no speed
        // cap around it, which changes no velocity but sets the awake bit of every body in reach. The reach is two of
        // the largest bounding radii plus both bodies' margins, so it covers every body that can have touched it.
        if (parts.sleep) blasts.push({ blast: checkBlast({ centre: { body: ev.id }, radius: 2 * this.rmax + 2 * this.params.margin, impulse: 0, maxSpeed: Infinity }), count: this.n });
      }
      else blasts.push({ blast: checkBlast(ev.blast), count: this.n });
    }
    const n = this.n, settling = this.stepIndex < (this.opts.settleSteps ?? 0);
    const p = settling ? { ...this.params, iterations: this.opts.settleIterations! } : this.params;
    parts.solver.writeParams(n, scene.dt, scene.gravity, scene.ground, p, scene.frictionCombine);
    parts.sleep?.writeParams(n);
    const enc = device.createCommandEncoder();
    mark?.(enc, 'start');
    let pass = enc.beginComputePass();
    parts.blast.encode(pass, blasts);
    parts.solver.prepare(pass, n);
    pass.end();
    mark?.(enc, 'prepare');
    parts.bp.encode(enc, n, { cellSize: this.cellSize, margin: p.margin });
    mark?.(enc, 'broadphase');
    pass = enc.beginComputePass();
    parts.solver.match(pass);
    parts.np.encode(pass, n, { margin: p.margin, ground: scene.ground ? { y: scene.ground.y } : null });
    pass.end();
    parts.sleep?.encodeWake(enc, n);
    mark?.(enc, 'narrowphase');
    parts.col.encode(enc, n, scene.ground?.y ?? 0, parts.sleep?.seed);
    mark?.(enc, 'coloring');
    parts.solver.solve(enc, n, p.iterations, solveTimestamps);
    parts.sleep?.encodeSleep(enc, n);
    mark?.(enc, 'solve');
    device.queue.submit([enc.finish()]);
    this.stepIndex++;
  }

  /**
   * Resolves when every submitted step has finished on the GPU (step() only
   * submits). Rejects if the device reported an error or was lost, since the
   * work it says is done may never have run.
   */
  async finish(): Promise<void> {
    if (this.device) await this.device.queue.onSubmittedWorkDone();
    if (this.failure) throw new Error(`GpuAvbdEngine: ${this.failure}`);
  }

  /** Reads the n bodies only (not the capacity), through the engine's staging pool. */
  async snapshot(): Promise<Snapshot> {
    const n = this.n;
    if (!this.device || !this.parts || n === 0) return emptySnapshot(n);
    const buf = await this.parts.readback.read(this.parts.bodies, n * Body.size);
    // Awake is flags bit 0 (bits 8-15 are the tier's). Tiers only once a body is removed (Snapshot.tier: absent, every body is active).
    return decodeBodies(buf, n, this.gone.size > 0);
  }

  /** Pipeline health: the pair buffer and colouring limits after the last step, and the pair buffer over every step since init(). */
  async diagnostics(): Promise<GpuDiagnostics> {
    const { device, parts } = this;
    if (!device || !parts) throw new Error('init() first');
    const steps = this.stepIndex;
    const [t, c] = await Promise.all([parts.readback.read(parts.bp.total), parts.readback.read(parts.col.info)]);
    const total = new Uint32Array(t), info = new Uint32Array(c);
    return {
      pairsRequired: total[5]!, pairsWritten: total[3]!, maxPairs: parts.bp.maxPairs, pairsRequiredPeak: total[6]!, pairsOverflowSteps: total[7]!, steps,
      colors: info[0]!, uncolored: info[1]!, colorOverflow: info[2]!, sleepSkippedSteps: this.skipped,
    };
  }

  /**
   * The engine's limits over every step since init() (engine-api EngineHealth, gpuHealth): the pair
   * buffer, from diagnostics(). Two small reads; not for a timed region.
   */
  async health(): Promise<EngineHealth> {
    const d = await this.diagnostics();
    const { limits } = this.device!;
    return gpuHealth(d, {
      capacity: this.capacity, records: this.records, storageLimit: Math.min(limits.maxStorageBufferBindingSize, limits.maxBufferSize),
      maxComputeWorkgroupsPerDimension: limits.maxComputeWorkgroupsPerDimension, boxBroadphase: !!this.opts.boxBroadphase,
    });
  }

  /**
   * The last step's restitution pass (GpuRestitutionStats), or null while
   * AvbdParams.restitution is off. Reads the pass's whole state back: for
   * tests and tools, not every step.
   */
  async restitutionStats(): Promise<GpuRestitutionStats | null> {
    const { device, parts } = this;
    if (!device || !parts) throw new Error('init() first');
    const slots = parts.solver.restSlots;
    if (!slots) return null;
    const [t, r] = await Promise.all([parts.readback.read(parts.bp.total), parts.readback.read(slots)]);
    return restitutionStatsOf(r, new Uint32Array(t)[3]!, parts.solver.maxPairs, this.n);
  }

  private static free(p: NonNullable<GpuAvbdEngine['parts']>): void {
    p.solver.destroy(); p.blast.destroy(); p.sleep?.destroy(); p.col.destroy(); p.np.destroy(); p.bp.destroy(); p.readback.destroy();
    for (const b of [p.bodies, p.shapes, p.props, p.spheres, p.sweep, p.prev]) b.destroy();
  }

  dispose(): void {
    this.generation++;
    if (this.parts) GpuAvbdEngine.free(this.parts);
    this.parts = null;
    const device = this.device;
    device?.removeEventListener('uncapturederror', this.onGpuError);
    if (this.ownsDevice) device?.destroy();
    this.device = null; // its 'lost' now resolves for a device this engine no longer uses, which is not a failure
    this.ownsDevice = false;
  }
}

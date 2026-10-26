// The GPU AVBD pipeline behind the engine contract: prepare (sweeps) ->
// broadphase -> match (pair history) -> narrowphase -> colouring -> solve,
// one command buffer per step. Parameters are the reference solver's (physics-ref AvbdParams), so
// the two engines can be run side by side on the same settings.
import { type BodyDesc, emptySnapshot, type EngineInfo, inertiaOf, type InputEvent, massOf, type PhysicsEngine, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { assertStorageFits, createDevice, Readback } from '@tb/gpu';
import { type AvbdParams, DEFAULT_AVBD } from '@tb/physics-ref';
import { Body, BodyProps, readField, Shape, SolverBody, writeStruct } from '@tb/schema';
import { Broadphase } from './broadphase.ts';
import { Coloring } from './coloring.ts';
import { Narrowphase } from './narrowphase.ts';
import { AvbdSolver, DEFAULT_DISPATCH } from './solver.ts';

export interface GpuEngineOptions {
  /** Use this device instead of creating one (it is then not destroyed by dispose()). */
  device?: GPUDevice;
  /** Pair buffer size per body. */
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
   * tailThreads threads (1-256, default 64). indirectColors restores
   * the earlier indirect dispatch of colours 0-62, to time against; colour 63
   * always goes to the tail. None of them changes the result.
   */
  colorTail?: number;
  indirectColors?: boolean;
  tailThreads?: number;
  /** Jones-Plassmann rounds (even, default 64). Fewer leave bodies uncoloured; for tests of that path. */
  colorRounds?: number;
}

export interface GpuDiagnostics {
  pairsRequired: number;
  pairsWritten: number;
  colors: number;
  uncolored: number;
  colorOverflow: number;
}

export class GpuAvbdEngine implements PhysicsEngine {
  readonly info: EngineInfo;
  stepIndex = 0;
  private readonly params: AvbdParams;
  private device: GPUDevice | null = null;
  private ownsDevice = false;
  /** Set when the device can't be trusted to have run what was submitted. */
  private failure: string | null = null;
  private readonly onGpuError = (ev: Event) => { this.failure ??= `GPU error: ${(ev as GPUUncapturedErrorEvent).error.message}`; };
  private scene: SceneDesc | null = null;
  private pending: InputEvent[] = [];
  private n = 0;
  private capacity = 0;
  private rmax = 0;
  private cellSize = 1;
  private parts: { bodies: GPUBuffer; shapes: GPUBuffer; props: GPUBuffer; spheres: GPUBuffer; sweep: GPUBuffer; prev: GPUBuffer; bp: Broadphase; np: Narrowphase; col: Coloring; solver: AvbdSolver; readback: Readback } | null = null;

  constructor(params: Partial<AvbdParams> = {}, private readonly opts: GpuEngineOptions = {}) {
    this.params = { ...DEFAULT_AVBD, ...params };
    if (!this.params.postStabilize) throw new Error('GpuAvbdEngine: only postStabilize = true is implemented');
    const check = (k: 'capacity' | 'spare' | 'pairsPerBody' | 'maxRadius' | 'colorTail' | 'tailThreads' | 'colorRounds', ok: (v: number) => boolean, what: string) => {
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
    if (opts.indirectColors !== undefined && typeof opts.indirectColors !== 'boolean') throw new Error(`GpuAvbdEngine: GpuEngineOptions.indirectColors must be a boolean, got ${opts.indirectColors}`);
    const variant: Record<string, number | boolean> = {};
    for (const [k, v] of Object.entries(this.params)) variant[k] = v;
    // Options that size the buffers or shape the dispatch change the work per step (e.g. the broadphase's key bits), so they are part of the variant.
    for (const k of ['capacity', 'spare', 'pairsPerBody', 'maxRadius', 'colorTail', 'indirectColors', 'tailThreads', 'colorRounds'] as const) if (opts[k] !== undefined) variant[k] = opts[k];
    this.info = { name: 'avbd-gpu', variant, backend: 'webgpu', integrator: { substeps: 1 } };
  }

  async init(scene: SceneDesc): Promise<void> {
    this.failure = null;
    this.dispose();
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
    this.scene = scene;
    const all = [...scene.bodies, ...scene.inputs.map((e) => e.body)];
    if (this.opts.capacity !== undefined && this.opts.capacity < all.length) throw new Error(`GpuAvbdEngine: capacity ${this.opts.capacity} is below the scene's ${all.length} bodies and inputs`);
    this.capacity = Math.max(1, this.opts.capacity ?? all.length + (this.opts.spare ?? 0));
    const maxPairs = (this.opts.pairsPerBody ?? 16) * this.capacity;
    const p = this.params;
    this.rmax = all.reduce((m, b) => Math.max(m, boundingRadius(b.shape)), this.opts.maxRadius ?? 0);
    // Every overlapping (inflated) pair must lie in adjacent cells.
    this.cellSize = Math.max(1e-3, 2 * (this.rmax + (p.sweep ? p.maxSweep : 0)) + p.margin);
    // The contact buffer is the largest (1 KB per pair slot; a manifold is
    // 96 B), so checking it first means no stage throws halfway through
    // allocating, which would leak what it had made.
    assertStorageFits(device, AvbdSolver.contactBytes(this.capacity, maxPairs), 'avbd contacts');
    const buf = (bytes: number, label: string) => (assertStorageFits(device, bytes, label), device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC, label }));
    const bodies = buf(this.capacity * Body.size, 'bodies');
    const shapes = buf(this.capacity * Shape.size, 'shapes');
    const props = buf(this.capacity * BodyProps.size, 'body props');
    const spheres = buf(this.capacity * 16, 'inflated spheres');
    const sweep = buf(this.capacity * 4, 'sweep');
    const prev = buf(maxPairs * 8, 'pair history lookup');
    const bp = new Broadphase(device, spheres, this.capacity, maxPairs);
    const np = new Narrowphase(device, bodies, shapes, bp.pairs, bp.total, this.capacity, maxPairs, sweep, prev);
    const col = new Coloring(device, np.manifolds, bp.total, this.capacity, maxPairs, this.opts.colorRounds);
    const solver = new AvbdSolver(device, this.capacity, maxPairs, {
      bodies, props, spheres, sweep, prev, manifolds: np.manifolds, groundManifolds: np.groundManifolds,
      pairs: bp.pairs, total: bp.total, offsets: bp.offsets,
      order: col.order, colorStart: col.colorStart, dispatch: col.dispatch, rowStart: col.rowStart, rowLength: col.rowLength, adjSlot: col.adjSlot,
    }, { colorTail: this.opts.colorTail ?? DEFAULT_DISPATCH.colorTail, indirectColors: this.opts.indirectColors ?? DEFAULT_DISPATCH.indirectColors,
      tailThreads: this.opts.tailThreads ?? DEFAULT_DISPATCH.tailThreads });
    this.parts = { bodies, shapes, props, spheres, sweep, prev, bp, np, col, solver, readback: new Readback(device) };
    this.n = 0;
    for (const b of scene.bodies) this.add(b);
    this.pending = [...scene.inputs].sort((a, b) => a.step - b.step);
    this.stepIndex = 0;
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
    one(BodyProps, { inertia: inertiaOf(b), mass: m, friction: b.friction, radius: boundingRadius(b.shape), sphere: b.shape.kind === 'sphere' ? 1 : 0 }, parts!.props);
    // prevVel = initial velocity, as the reference (no adaptive warm-start kick on the first step).
    one(SolverBody, { prevVel: b.linVel }, parts!.solver.solver);
  }

  push(events: InputEvent[]): void {
    if (!this.parts) throw new Error('init() first');
    // Checked before queueing any, so a rejected batch changes nothing.
    if (this.n + this.pending.length + events.length > this.capacity) throw new Error(`GpuAvbdEngine: push() needs room for ${this.n + this.pending.length + events.length} bodies, capacity is ${this.capacity} (GpuEngineOptions.capacity or spare)`);
    for (const ev of events) {
      const r = boundingRadius(ev.body.shape);
      if (r > this.rmax) throw new Error(`GpuAvbdEngine: pushed body radius ${r} exceeds ${this.rmax}, the largest the broadphase cells were sized for (GpuEngineOptions.maxRadius)`);
    }
    // Stable insertion keeps push order among events due at the same step.
    for (const ev of events) {
      let i = this.pending.length;
      while (i > 0 && this.pending[i - 1]!.step > ev.step) i--;
      this.pending.splice(i, 0, ev);
    }
  }

  step(): void {
    const { device, parts, scene } = this;
    if (!device || !parts || !scene) throw new Error('init() first');
    if (this.failure) throw new Error(`GpuAvbdEngine: ${this.failure}`);
    while (this.pending.length && this.pending[0]!.step <= this.stepIndex) this.add(this.pending.shift()!.body);
    const n = this.n, p = this.params;
    parts.solver.writeParams(n, scene.dt, scene.gravity, scene.ground, p, scene.frictionCombine);
    const enc = device.createCommandEncoder();
    let pass = enc.beginComputePass();
    parts.solver.prepare(pass, n);
    pass.end();
    parts.bp.encode(enc, n, { cellSize: this.cellSize, margin: p.margin });
    pass = enc.beginComputePass();
    parts.solver.match(pass);
    parts.np.encode(pass, n, { margin: p.margin, ground: scene.ground ? { y: scene.ground.y } : null });
    pass.end();
    parts.col.encode(enc, n);
    parts.solver.solve(enc, n, p.iterations);
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
    const s = emptySnapshot(n);
    if (!this.device || !this.parts || n === 0) return s;
    const buf = await this.parts.readback.read(this.parts.bodies, n * Body.size);
    readField(buf, Body, 'pos', n, s.pos);
    readField(buf, Body, 'rot', n, s.rot);
    readField(buf, Body, 'linVel', n, s.linVel);
    readField(buf, Body, 'angVel', n, s.angVel);
    // Bit 0 only: bits 8-15 are the tier's.
    const flags = readField(buf, Body, 'flags', n, new Uint32Array(n));
    for (let i = 0; i < n; i++) s.awake[i] = flags[i]! & 1;
    return s;
  }

  /** Pipeline health after the last step: pair buffer and colouring limits. */
  async diagnostics(): Promise<GpuDiagnostics> {
    const { device, parts } = this;
    if (!device || !parts) throw new Error('init() first');
    const [t, c] = await Promise.all([parts.readback.read(parts.bp.total), parts.readback.read(parts.col.info)]);
    const total = new Uint32Array(t), info = new Uint32Array(c);
    return { pairsRequired: total[5]!, pairsWritten: total[3]!, colors: info[0]!, uncolored: info[1]!, colorOverflow: info[2]! };
  }

  dispose(): void {
    const p = this.parts;
    if (p) {
      p.solver.destroy(); p.col.destroy(); p.np.destroy(); p.bp.destroy(); p.readback.destroy();
      for (const b of [p.bodies, p.shapes, p.props, p.spheres, p.sweep, p.prev]) b.destroy();
    }
    this.parts = null;
    const device = this.device;
    device?.removeEventListener('uncapturederror', this.onGpuError);
    if (this.ownsDevice) device?.destroy();
    this.device = null; // its 'lost' now resolves for a device this engine no longer uses, which is not a failure
    this.ownsDevice = false;
  }
}

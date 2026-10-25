// Sparks from impacts (design step 15). All on the GPU, no readback:
//
//   detect    one thread per slot: the speed change since the detector
//             last saw the slot (FxState.prevLinVel). Above dvMin it
//             appends an ImpactEvent at the body's support point opposite
//             the change, which is where the push came from. Guards: no
//             event for a slot the detector has not seen before, a tier
//             change, a shape change or a teleport (new, activated or
//             reused slots). Running every frame, not every step, needs no
//             step counter: without a new step the change is exactly 0,
//             and several steps in one frame add up.
//   spawn     SPAWN_BUDGET threads, dealt round-robin over the frame's
//             events (thread t: event t % E, spark t / E), so a flood of
//             events shares the budget evenly without a scan. Each spark
//             takes the next slot of a POOL ring (oldest overwritten).
//   simulate  every pool slot: gravity, quadratic drag, ground bounce.
//
// Drawn as screen-space streaks in the scene pass (shaders.ts). Every
// pool slot is drawn and dead ones collapse in the vertex shader, so the
// cost is constant. spawnReference and stepReference are the CPU twins.
// Alternatives: atomic-free compaction of live sparks (a scan per frame)
// saves vertex work only when few sparks live; contact events from the
// solver (tier 3) replace the detector's guesses when they exist.
import { Body, FxState, ImpactEvent, Shape, Spark, TIER, wgslStruct } from '@tb/schema';
import { MAX_STEP_JUMP } from './cull.ts';
import { MATERIAL } from './looks.ts';
import type { BodySource } from './source.ts';
import type { V3 } from './math.ts';

export const SPARK_POOL = 65536;
export const MAX_EVENTS = 1024;
export const SPAWN_BUDGET = 8192;
export const MAX_PER_EVENT = 512;
export const MAX_INJECT = 64;
const WG = 64;

export interface SparkParams {
  /** Speed change that starts sparking, m/s (gravity adds 0.16 per 60 Hz step). */
  dvMin: number;
  /** Sparks per m/s above dvMin. */
  perDv: number;
  speedMin: number;
  speedMax: number;
  /** Quadratic drag, 1/m: dv/dt = -drag |v| v. */
  drag: number;
  /** Ground restitution (normal), and the tangential speed kept on a bounce. */
  bounce: number;
  friction: number;
  gravity: number;
  /** Heat glow: speed change (m/s) where heat starts, and the further change for full heat. */
  heatDv: number;
  heatRange: number;
  /** Heat decay time constant, s. */
  heatTau: number;
  /** A body this close to a ball's surface (m) is fully hot. */
  contact: number;
}

export const DEFAULT_SPARKS: SparkParams = { dvMin: 2.5, perDv: 24, speedMin: 6, speedMax: 22, drag: 0.08, bounce: 0.38, friction: 0.7, gravity: 9.81, heatDv: 6, heatRange: 6, heatTau: 0.25, contact: 0.3 };

/** Control words: event count, pool head, events dropped, sparks spawned, hot bodies (this frame). */
export const CTL = { events: 0, head: 1, dropped: 2, spawned: 3, hot: 4 } as const;
const CTL_WORDS = 8;

const PARAM_WORDS = 24;

/** Hash and spark life: shared by the simulation and the draw shader. */
export const SPARK_COMMON = /* wgsl */ `
fn pcg(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn unit(h: u32) -> f32 { return f32(h >> 8u) * (1.0 / 16777216.0); }
fn sparkLife(packed: u32) -> f32 { return 0.4 + 0.8 * f32(packed & 0xffu) / 255.0; }
`;

const NEW_SPARK = /* wgsl */ `
fn newSpark(e: ImpactEvent, j: u32, frame: u32, speedMin: f32, speedMax: f32) -> Spark {
  let h0 = pcg(bitcast<u32>(e.pos.x) ^ pcg(bitcast<u32>(e.pos.z) ^ pcg(j ^ (frame << 16u))));
  let h1 = pcg(h0);
  let h2 = pcg(h1);
  let h3 = pcg(h2);
  let z = 2.0 * unit(h0) - 1.0;
  let phi = 6.2831853 * unit(h1);
  let rr = sqrt(max(0.0, 1.0 - z * z));
  var u = vec3f(rr * cos(phi), rr * sin(phi), z);
  if (dot(u, e.dir) < 0.0) { u = -u; }
  let d = normalize(u + 0.8 * e.dir);
  let speed = mix(speedMin, speedMax, unit(h2)) * min(1.0, 0.3 + e.strength / 12.0);
  return Spark(e.pos, 0.0, d * speed, (h3 >> 24u) | (h0 & 0xffffff00u));
}
`;

export const SPARK_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
${wgslStruct(ImpactEvent)}
${wgslStruct(Spark)}
${wgslStruct(FxState)}

struct SparkParams {
  dt: f32, groundY: f32, dvMin: f32, perDv: f32,
  speedMin: f32, speedMax: f32, drag: f32, bounce: f32,
  friction: f32, gravity: f32, count: u32, frame: u32,
  capacity: u32, pool: u32, pad1: u32, pad2: u32,
  balls: vec4u, heatDv: f32, heatRange: f32, heatTau: f32, contact: f32,
}

@group(0) @binding(0) var<uniform> p: SparkParams;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> prev: array<Body>;
@group(0) @binding(3) var<storage, read> shapes: array<Shape>;
@group(0) @binding(4) var<storage, read> looks: array<u32>;
@group(0) @binding(5) var<storage, read_write> state: array<FxState>;
@group(0) @binding(6) var<storage, read_write> events: array<ImpactEvent>;
@group(0) @binding(7) var<storage, read_write> ctl: array<atomic<u32>, ${CTL_WORDS}>;
@group(0) @binding(8) var<storage, read_write> sparks: array<Spark>;

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

${SPARK_COMMON}
${NEW_SPARK}

@compute @workgroup_size(${WG})
fn detect(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.count || i >= p.capacity) { return; }
  let b = bodies[i];
  let st = state[i];
  let tier = (b.flags >> 8u) & 0xffu;
  let live = tier != ${TIER.lattice}u && tier != ${TIER.free}u && b.invMass > 0.0;
  let q = prev[i];
  let continuous = q.shape == b.shape && dot(q.rot, q.rot) > 0.5 && distance(q.pos, b.pos) < ${MAX_STEP_JUMP}.0;
  let seen = (st.bits >> 24u) == 1u && ((st.bits >> 16u) & 0xffu) == tier;
  if (live && seen && continuous) {
    let dv = b.linVel - st.prevLinVel;
    let s = length(dv);
    if (s > p.dvMin) {
      let k = atomicAdd(&ctl[${CTL.events}], 1u);
      if (k < ${MAX_EVENTS}u) {
        let d = dv / s;
        let sh = shapes[b.shape];
        // Support distance along -d: where the push came from.
        let dl = qrot(vec4f(-b.rot.xyz, b.rot.w), d);
        let r = select(dot(abs(dl), sh.half), sh.half.x, sh.kind == 1u);
        events[k] = ImpactEvent(b.pos - d * r, s, d, i | (((looks[i] >> 12u) & 0xfu) << 28u));
      } else {
        atomicAdd(&ctl[${CTL.dropped}], 1u);
      }
    }
  }
  // Heat (design step 17): only from a hard hit or from touching a ball,
  // max-combined and saturating at 1, decaying with heatTau.
  var heat = 0.0;
  if (live) {
    heat = unpack2x16float(st.bits).x * exp(-p.dt / p.heatTau);
    if (seen && continuous) {
      heat = max(heat, clamp((length(b.linVel - st.prevLinVel) - p.heatDv) / p.heatRange, 0.0, 1.0));
    }
    if (((looks[i] >> 12u) & 0xfu) != ${MATERIAL.ball}u) { heat = max(heat, ballContact(i, b)); }
    if (heat > 0.05) { atomicAdd(&ctl[${CTL.hot}], 1u); }
  }
  state[i] = FxState(b.linVel, (pack2x16float(vec2f(heat, 0.0)) & 0xffffu) | (tier << 16u) | select(0u, 1u << 24u, live));
}

// 1 when a ball's surface is within p.contact of the body's box (exact
// point-box distance in the body's frame), else 0.
fn ballContact(i: u32, b: Body) -> f32 {
  let sh = shapes[b.shape];
  var hot = 0.0;
  for (var k = 0u; k < 4u; k++) {
    let j = p.balls[k];
    if (j >= p.count || j == i) { continue; }
    let ball = bodies[j];
    let r = shapes[ball.shape].half.x;
    let local = qrot(vec4f(-b.rot.xyz, b.rot.w), ball.pos - b.pos);
    let half = select(sh.half, vec3f(sh.half.x), sh.kind == 1u);
    let d = select(length(max(abs(local) - half, vec3f(0.0))), max(length(local) - sh.half.x, 0.0), sh.kind == 1u);
    if (d < r + p.contact) { hot = 1.0; }
  }
  return hot;
}

fn sparkCount(e: ImpactEvent) -> u32 {
  return min(${MAX_PER_EVENT}u, u32(max(e.strength - p.dvMin, 0.0) * p.perDv));
}

@compute @workgroup_size(${WG})
fn spawn(@builtin(global_invocation_id) id: vec3u) {
  let t = id.x;
  let n = min(atomicLoad(&ctl[${CTL.events}]), ${MAX_EVENTS}u);
  if (n == 0u || t >= ${SPAWN_BUDGET}u) { return; }
  let e = events[t % n];
  let j = t / n;
  if (j >= sparkCount(e)) { return; }
  let slot = atomicAdd(&ctl[${CTL.head}], 1u) % p.pool;
  atomicAdd(&ctl[${CTL.spawned}], 1u);
  sparks[slot] = newSpark(e, j, p.frame, p.speedMin, p.speedMax);
}

@compute @workgroup_size(${WG})
fn simulate(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.pool) { return; }
  var s = sparks[i];
  if (s.age < 0.0) { return; }
  s.age += p.dt;
  if (s.age >= sparkLife(s.packed)) {
    s.age = -1.0;
    sparks[i] = s;
    return;
  }
  s.vel.y -= p.gravity * p.dt;
  s.vel /= 1.0 + p.drag * length(s.vel) * p.dt;
  s.pos += s.vel * p.dt;
  if (s.pos.y < p.groundY) {
    s.pos.y = p.groundY + (p.groundY - s.pos.y) * p.bounce;
    s.vel = vec3f(s.vel.x * p.friction, -s.vel.y * p.bounce, s.vel.z * p.friction);
  }
  sparks[i] = s;
}
`;

// ---------------------------------------------------------------- CPU twins

const fr = Math.fround;
const u32 = (x: number) => x >>> 0;
const f32buf = new Float32Array(1), u32buf = new Uint32Array(f32buf.buffer);
const bitsOf = (x: number) => { f32buf[0] = x; return u32buf[0]!; };

export function pcg(v: number): number {
  const s = u32(Math.imul(u32(v), 747796405) + 2891336453);
  const w = u32(Math.imul(u32((s >>> ((s >>> 28) + 4)) ^ s), 277803737));
  return u32((w >>> 22) ^ w);
}
const unit = (h: number) => fr((h >>> 8) / 16777216);

export interface SparkState { pos: V3; age: number; vel: V3; packed: number }
export interface Impact { pos: V3; strength: number; dir: V3; packed: number }

export const sparkLife = (packed: number) => fr(0.4 + fr(fr(0.8 * (packed & 0xff)) / 255));

export function sparkCount(e: Impact, p: SparkParams): number {
  return Math.min(MAX_PER_EVENT, Math.floor(fr(Math.max(fr(e.strength - p.dvMin), 0) * p.perDv)));
}

/** CPU twin of newSpark (f32 rounding at each step; trig may differ from the GPU by an ulp or so). */
export function newSparkReference(e: Impact, j: number, frame: number, p: SparkParams): SparkState {
  const h0 = pcg(bitsOf(e.pos[0]) ^ pcg(bitsOf(e.pos[2]) ^ pcg(u32(j ^ u32(frame << 16)))));
  const h1 = pcg(h0), h2 = pcg(h1), h3 = pcg(h2);
  const z = fr(2 * unit(h0) - 1), phi = fr(6.2831853 * unit(h1)), rr = fr(Math.sqrt(Math.max(0, fr(1 - fr(z * z)))));
  let u: V3 = [fr(rr * fr(Math.cos(phi))), fr(rr * fr(Math.sin(phi))), z];
  if (u[0] * e.dir[0] + u[1] * e.dir[1] + u[2] * e.dir[2] < 0) u = [-u[0], -u[1], -u[2]];
  const v = u.map((x, k) => fr(x + fr(0.8 * e.dir[k]!))) as V3;
  const l = fr(Math.hypot(...v));
  const t = unit(h2), speed = fr(fr(fr(p.speedMin * fr(1 - t)) + fr(p.speedMax * t)) * Math.min(1, fr(0.3 + fr(e.strength / 12))));
  return { pos: [...e.pos] as V3, age: 0, vel: v.map((x) => fr(fr(x / l) * speed)) as V3, packed: u32((h3 >>> 24) | (h0 & 0xffffff00)) };
}

/** The sparks one frame's events spawn, in thread order (the GPU's slot order may differ). */
export function spawnReference(events: Impact[], frame: number, p: SparkParams): SparkState[] {
  const n = Math.min(events.length, MAX_EVENTS), out: SparkState[] = [];
  if (!n) return out;
  for (let t = 0; t < SPAWN_BUDGET; t++) {
    const e = events[t % n]!, j = Math.floor(t / n);
    if (j < sparkCount(e, p)) out.push(newSparkReference(e, j, frame, p));
  }
  return out;
}

/** CPU twin of simulate for one spark and one frame. */
export function stepReference(s: SparkState, dt: number, groundY: number, p: SparkParams): SparkState {
  if (s.age < 0) return s;
  const age = fr(s.age + dt);
  if (age >= sparkLife(s.packed)) return { ...s, age: -1 };
  const vel = [...s.vel] as V3;
  vel[1] = fr(vel[1] - fr(p.gravity * dt));
  const k = fr(1 + fr(fr(p.drag * fr(Math.hypot(...vel))) * dt));
  for (let i = 0; i < 3; i++) vel[i] = fr(vel[i]! / k);
  const pos = s.pos.map((x, i) => fr(x + fr(vel[i]! * dt))) as V3;
  if (pos[1] < groundY) {
    pos[1] = fr(groundY + fr(fr(groundY - pos[1]) * p.bounce));
    vel[0] = fr(vel[0] * p.friction); vel[1] = fr(-vel[1] * p.bounce); vel[2] = fr(vel[2] * p.friction);
  }
  return { pos, age, vel, packed: s.packed };
}

// ---------------------------------------------------------------- GPU side

export class Sparks {
  readonly sparks: GPUBuffer;
  readonly events: GPUBuffer;
  readonly ctl: GPUBuffer;
  private state: GPUBuffer | null = null;
  private readonly params: GPUBuffer;
  private readonly pipes: { detect: GPUComputePipeline; spawn: GPUComputePipeline; simulate: GPUComputePipeline };
  private binds: { detect: GPUBindGroup; spawn: GPUBindGroup; simulate: GPUBindGroup } | null = null;
  private source: BodySource | null = null;
  private bound = '';
  private injected: Impact[] = [];
  private frame = 0;
  /** Tunables, read every frame. */
  config: SparkParams = { ...DEFAULT_SPARKS };

  /** pool: spark slots (default SPARK_POOL); fewer for tests on software adapters. */
  constructor(private readonly device: GPUDevice, readonly pool = SPARK_POOL) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.sparks = device.createBuffer({ size: pool * Spark.size, usage, label: 'sparks' });
    // All sparks start dead (age -1).
    const init = new Float32Array(pool * (Spark.size / 4));
    for (let i = 0; i < pool; i++) init[i * 8 + 3] = -1;
    device.queue.writeBuffer(this.sparks, 0, init);
    this.events = device.createBuffer({ size: MAX_EVENTS * ImpactEvent.size, usage, label: 'impact events' });
    this.ctl = device.createBuffer({ size: CTL_WORDS * 4, usage, label: 'spark control' });
    this.params = device.createBuffer({ size: PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'spark params' });
    const module = device.createShaderModule({ code: SPARK_WGSL, label: 'sparks' });
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.pipes = { detect: pipe('detect'), spawn: pipe('spawn'), simulate: pipe('simulate') };
  }

  /** CPU-authored impacts (game events, tests), spawned on the next frame. */
  inject(pos: V3, dir: V3, strength: number): void {
    if (this.injected.length >= MAX_INJECT) return;
    const l = Math.hypot(...dir) || 1;
    this.injected.push({ pos, dir: [dir[0] / l, dir[1] / l, dir[2] / l], strength, packed: 0xffffff | (1 << 24) });
  }

  /**
   * The per-slot FX state buffer (previous velocity, heat) sized for a
   * source, for the scene shader to read heat from. Growing it zeroes every
   * slot (unseen, cold) and rebinds the kernels on the next encode.
   */
  stateFor(source: BodySource): GPUBuffer {
    if (!this.state || this.state.size < source.capacity * FxState.size) {
      this.state?.destroy();
      this.state = this.device.createBuffer({ size: Math.max(16, source.capacity * FxState.size), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC, label: 'fx state' });
      this.binds = null;
    }
    return this.state;
  }

  private bind(source: BodySource): void {
    const key = `${source.version}:${source.capacity}`;
    if (this.source === source && this.bound === key && this.binds) return;
    const all = [this.params, source.bodies, source.prev, source.shapes, source.looks, this.stateFor(source), this.events, this.ctl, this.sparks];
    const bind = (p: GPUComputePipeline, bindings: number[]) => this.device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: bindings.map((binding) => ({ binding, resource: { buffer: all[binding]! } })),
    });
    this.binds = { detect: bind(this.pipes.detect, [0, 1, 2, 3, 4, 5, 6, 7]), spawn: bind(this.pipes.spawn, [0, 6, 7, 8]), simulate: bind(this.pipes.simulate, [0, 8]) };
    this.source = source;
    this.bound = key;
  }

  /** Record detect, spawn and simulate into an open compute pass. detect: false skips the detector (injected events only). */
  encode(pass: GPUComputePassEncoder, source: BodySource, f: { dt: number; groundY: number; detect?: boolean }): void {
    this.bind(source);
    const q = this.device.queue, pr = this.config;
    const buf = new ArrayBuffer(PARAM_WORDS * 4), fl = new Float32Array(buf), u = new Uint32Array(buf);
    fl.set([f.dt, f.groundY, pr.dvMin, pr.perDv, pr.speedMin, pr.speedMax, pr.drag, pr.bounce, pr.friction, pr.gravity]);
    u[10] = Math.min(source.count, source.capacity);
    u[11] = this.frame++;
    u[12] = source.capacity;
    u[13] = this.pool;
    const balls = source.balls ?? [];
    for (let k = 0; k < 4; k++) u[16 + k] = balls[k] ?? 0xffffffff;
    fl.set([pr.heatDv, pr.heatRange, pr.heatTau, pr.contact], 20);
    q.writeBuffer(this.params, 0, buf);
    // Injected events first; the detector appends after them.
    const inj = this.injected.splice(0);
    if (inj.length) q.writeBuffer(this.events, 0, packImpacts(inj));
    q.writeBuffer(this.ctl, 0, new Uint32Array([inj.length]));
    q.writeBuffer(this.ctl, 8, new Uint32Array([0, 0, 0]));
    if (f.detect !== false && source.count > 0) {
      pass.setBindGroup(0, this.binds!.detect);
      pass.setPipeline(this.pipes.detect);
      pass.dispatchWorkgroups(Math.ceil(Math.min(source.count, source.capacity) / WG));
    }
    pass.setBindGroup(0, this.binds!.spawn);
    pass.setPipeline(this.pipes.spawn);
    pass.dispatchWorkgroups(SPAWN_BUDGET / WG);
    pass.setBindGroup(0, this.binds!.simulate);
    pass.setPipeline(this.pipes.simulate);
    pass.dispatchWorkgroups(Math.ceil(this.pool / WG));
  }

  /** Frame counter the next encode will use (spark seeds depend on it). */
  get nextFrame(): number { return this.frame; }

  destroy(): void {
    for (const b of [this.sparks, this.events, this.ctl, this.params, this.state]) b?.destroy();
  }
}

export function packImpacts(es: Impact[]): ArrayBuffer {
  const out = new ArrayBuffer(es.length * ImpactEvent.size), f = new Float32Array(out), u = new Uint32Array(out);
  es.forEach((e, i) => { f.set(e.pos, i * 8); f[i * 8 + 3] = e.strength; f.set(e.dir, i * 8 + 4); u[i * 8 + 7] = e.packed; });
  return out;
}

export function unpackSparks(data: ArrayBuffer): SparkState[] {
  const f = new Float32Array(data), u = new Uint32Array(data), out: SparkState[] = [];
  for (let i = 0; i < f.length / 8; i++) out.push({ pos: [f[i * 8]!, f[i * 8 + 1]!, f[i * 8 + 2]!], age: f[i * 8 + 3]!, vel: [f[i * 8 + 4]!, f[i * 8 + 5]!, f[i * 8 + 6]!], packed: u[i * 8 + 7]! });
  return out;
}

export function unpackImpacts(data: ArrayBuffer, n: number): Impact[] {
  const f = new Float32Array(data), u = new Uint32Array(data), out: Impact[] = [];
  for (let i = 0; i < n; i++) out.push({ pos: [f[i * 8]!, f[i * 8 + 1]!, f[i * 8 + 2]!], strength: f[i * 8 + 3]!, dir: [f[i * 8 + 4]!, f[i * 8 + 5]!, f[i * 8 + 6]!], packed: u[i * 8 + 7]! });
  return out;
}

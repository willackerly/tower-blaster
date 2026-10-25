// Point lights and the ball trail (design step 16), all on the GPU:
//
//   balls     up to MAX_BALLS lights, one per ball slot, at the ball's
//             drawn (interpolated) position. The ball slots come from the
//             CPU-side looks (BodySource.balls), so a light keeps its index
//             and its trail from frame to frame; a slot whose tier is no
//             longer drawable gives no light. Each ball also writes its
//             position into a TRAIL-long ring for the ribbon.
//   flashPick each impact event bids for one of FLASHES light slots,
//             chosen by a hash of its 4 m cell: atomicMax of
//             (strength << 20 | event index), so the strongest impact per
//             slot wins and nearby impacts share a light.
//   flashTake per slot: the winner replaces the slot's light if it is
//             brighter than what is left of the old one; lights decay with
//             time constant tau.
//
// The scene shader loops over the packed light list (2 vec4 per light:
// camera-relative position and radius; colour times intensity). Lights
// do not cast shadows. flashSlot is the CPU twin of the slot rule.
import { Body, ImpactEvent, RenderRecord, TIER, wgslStruct } from '@tb/schema';
import { CTL, MAX_EVENTS, type Sparks } from './sparks.ts';
import type { BodySource } from './source.ts';
import type { V3 } from './math.ts';

export const MAX_BALLS = 4;
export const FLASHES = 8;
export const LIGHTS = MAX_BALLS + FLASHES;
export const TRAIL = 32;
/**
 * The light buffer, in vec4: the LIGHTS raw slots (2 vec4 each: position
 * and radius, colour times intensity; zero when off), then LIGHT_META
 * (x: heat glow gain, y: lit count), then the lit lights packed from
 * LIGHT_PACKED in slot order. The scene shader reads it as a uniform and
 * loops over the packed lights only, so with none lit it costs nothing.
 */
export const LIGHT_META = LIGHTS * 2;
export const LIGHT_PACKED = LIGHT_META + 1;
export const LIGHT_VEC4 = LIGHT_PACKED + LIGHTS * 2;
export const LIGHT_WORDS = LIGHT_VEC4 * 4;
/** Hot bodies that glow at full strength; more share it (no white washout in a collapse). */
export const HOT_FULL = 2000;

export interface LightParams {
  /** Ball light: radius (m) and intensity (multiple of the look's ball colour). */
  ballRadius: number;
  ballIntensity: number;
  /** Flash lights: radius (m), intensity at full strength, decay time constant (s), strength (m/s) for full. */
  flashRadius: number;
  flashIntensity: number;
  flashTau: number;
  flashFull: number;
  flashColour: V3;
}

export const DEFAULT_LIGHTS: LightParams = { ballRadius: 12, ballIntensity: 6, flashRadius: 8, flashIntensity: 14, flashTau: 0.12, flashFull: 15, flashColour: [1, 0.62, 0.3] };

const PARAM_WORDS = 32;
const NONE = 0xffffffff;

export const LIGHT_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(RenderRecord)}
${wgslStruct(ImpactEvent)}

struct LightParams {
  eye: vec3f, time: f32,
  ballColour: vec3f, ballRadius: f32,
  flashColour: vec3f, flashRadius: f32,
  balls: vec4u,
  count: u32, frame: u32, flashTau: f32, flashGain: f32,
  flashFull: f32, pad0: f32, pad1: f32, pad2: f32,
}

// A flash slot: world position, start time, initial intensity.
struct Flash { pos: vec3f, t0: f32, i0: f32, pad0: f32, pad1: f32, pad2: f32 }

@group(0) @binding(0) var<uniform> p: LightParams;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> records: array<RenderRecord>;
@group(0) @binding(3) var<storage, read> events: array<ImpactEvent>;
@group(0) @binding(4) var<storage, read> eventCount: array<u32>;   // the spark control words; [0] = events this frame
@group(0) @binding(5) var<storage, read_write> keys: array<atomic<u32>, ${FLASHES}>;
@group(0) @binding(6) var<storage, read_write> flashes: array<Flash, ${FLASHES}>;
@group(0) @binding(7) var<storage, read_write> lights: array<vec4f, ${LIGHT_VEC4}>;
@group(0) @binding(8) var<storage, read_write> trail: array<vec4f>;  // MAX_BALLS x TRAIL: world xyz, time (w < 0: empty)

${FLASH_SLOT_WGSL()}

@compute @workgroup_size(${MAX_BALLS})
fn balls(@builtin(local_invocation_index) k: u32) {
  let i = p.balls[k];
  var on = false;
  if (i != ${NONE}u && i < p.count) {
    let tier = (bodies[i].flags >> 8u) & 0xffu;
    on = tier != ${TIER.lattice}u && tier != ${TIER.free}u;
  }
  if (!on) {
    lights[2u * k] = vec4f(0.0);
    lights[2u * k + 1u] = vec4f(0.0);
    trail[k * ${TRAIL}u + p.frame % ${TRAIL}u] = vec4f(0.0, 0.0, 0.0, -1.0);
    return;
  }
  let rel = records[i].pos;
  lights[2u * k] = vec4f(rel, p.ballRadius);
  lights[2u * k + 1u] = vec4f(p.ballColour, 1.0);
  trail[k * ${TRAIL}u + p.frame % ${TRAIL}u] = vec4f(rel + p.eye, p.time);
}

@compute @workgroup_size(64)
fn flashPick(@builtin(global_invocation_id) id: vec3u) {
  let e = id.x;
  if (e >= min(eventCount[0], ${MAX_EVENTS}u)) { return; }
  let ev = events[e];
  let q = u32(clamp(ev.strength / p.flashFull, 0.0, 1.0) * 4095.0);
  if (q == 0u) { return; }
  atomicMax(&keys[flashSlot(ev.pos)], (q << 20u) | e);
}

@compute @workgroup_size(${FLASHES})
fn flashTake(@builtin(local_invocation_index) k: u32) {
  let key = atomicExchange(&keys[k], 0u);
  var f = flashes[k];
  let left = f.i0 * exp(-(p.time - f.t0) / p.flashTau);
  if (key != 0u) {
    let ev = events[key & 0xfffffu];
    let i0 = f32(key >> 20u) / 4095.0 * p.flashGain;
    if (i0 > left) {
      f = Flash(ev.pos + ev.dir * 0.5, p.time, i0, 0.0, 0.0, 0.0);
      flashes[k] = f;
    }
  }
  let now = f.i0 * exp(-(p.time - f.t0) / p.flashTau);
  let lit = now > 0.01;
  lights[2u * (${MAX_BALLS}u + k)] = select(vec4f(0.0), vec4f(f.pos - p.eye, p.flashRadius), lit);
  lights[2u * (${MAX_BALLS}u + k) + 1u] = select(vec4f(0.0), vec4f(p.flashColour, now), lit);
}

@compute @workgroup_size(1)
fn pack() {
  var n = 0u;
  for (var k = 0u; k < ${LIGHTS}u; k++) {
    let pl = lights[2u * k];
    let col = lights[2u * k + 1u];
    if (pl.w > 0.0 && col.w > 0.0) {
      lights[${LIGHT_PACKED}u + 2u * n] = pl;
      lights[${LIGHT_PACKED}u + 2u * n + 1u] = col;
      n++;
    }
  }
  lights[${LIGHT_META}u] = vec4f(1.0 / max(1.0, f32(eventCount[${CTL.hot}]) / ${HOT_FULL}.0), f32(n), 0.0, 0.0);
}
`;

/** Which flash slot an impact at pos bids for: a hash of its 4 m cell. */
export function FLASH_SLOT_WGSL(): string {
  return /* wgsl */ `
fn flashSlot(pos: vec3f) -> u32 {
  let c = vec3<i32>(floor(pos / 4.0));
  let h = (bitcast<u32>(c.x) * 73856093u) ^ (bitcast<u32>(c.y) * 19349663u) ^ (bitcast<u32>(c.z) * 83492791u);
  return h % ${FLASHES}u;
}
`;
}

/** CPU twin of flashSlot. */
export function flashSlot(pos: V3): number {
  const c = pos.map((v) => Math.floor(Math.fround(Math.fround(v) / 4)) >>> 0);
  const h = (Math.imul(c[0]!, 73856093) ^ Math.imul(c[1]!, 19349663) ^ Math.imul(c[2]!, 83492791)) >>> 0;
  return h % FLASHES;
}

export class Lights {
  readonly lights: GPUBuffer;
  readonly trail: GPUBuffer;
  readonly flashes: GPUBuffer;
  private readonly keys: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly pipes: { balls: GPUComputePipeline; flashPick: GPUComputePipeline; flashTake: GPUComputePipeline; pack: GPUComputePipeline };
  private binds: { balls: GPUBindGroup; flashPick: GPUBindGroup; flashTake: GPUBindGroup; pack: GPUBindGroup } | null = null;
  private bound: unknown[] = [];
  private frame = 0;
  /** Tunables, read every frame. */
  config: LightParams = { ...DEFAULT_LIGHTS };

  constructor(private readonly device: GPUDevice) {
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST;
    this.lights = device.createBuffer({ size: LIGHT_WORDS * 4, usage: usage | GPUBufferUsage.UNIFORM, label: 'lights' });
    this.trail = device.createBuffer({ size: MAX_BALLS * TRAIL * 16, usage, label: 'ball trail' });
    device.queue.writeBuffer(this.trail, 0, new Float32Array(MAX_BALLS * TRAIL * 4).map((_, i) => (i % 4 === 3 ? -1 : 0)));
    this.flashes = device.createBuffer({ size: FLASHES * 32, usage, label: 'flash lights' });
    this.keys = device.createBuffer({ size: FLASHES * 4, usage, label: 'flash keys' });
    this.params = device.createBuffer({ size: PARAM_WORDS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'light params' });
    const module = device.createShaderModule({ code: LIGHT_WGSL, label: 'lights' });
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.pipes = { balls: pipe('balls'), flashPick: pipe('flashPick'), flashTake: pipe('flashTake'), pack: pipe('pack') };
  }

  /**
   * Record into an open compute pass, after the cull (records) and the
   * sparks (events) of this frame. ball: the look's ball colour, linear.
   */
  encode(pass: GPUComputePassEncoder, source: BodySource, records: GPUBuffer, sparks: Sparks, f: { eye: V3; time: number; ball: V3 }): void {
    const want = [source.bodies, records, sparks.events, sparks.ctl];
    if (!this.binds || want.some((b, i) => b !== this.bound[i])) {
      const all = [this.params, source.bodies, records, sparks.events, sparks.ctl, this.keys, this.flashes, this.lights, this.trail];
      const bind = (p: GPUComputePipeline, bindings: number[]) => this.device.createBindGroup({
        layout: p.getBindGroupLayout(0),
        entries: bindings.map((binding) => ({ binding, resource: { buffer: all[binding]! } })),
      });
      this.binds = { balls: bind(this.pipes.balls, [0, 1, 2, 7, 8]), flashPick: bind(this.pipes.flashPick, [0, 3, 4, 5]), flashTake: bind(this.pipes.flashTake, [0, 3, 5, 6, 7]), pack: bind(this.pipes.pack, [4, 7]) };
      this.bound = want;
    }
    const c = this.config;
    const buf = new ArrayBuffer(PARAM_WORDS * 4), fl = new Float32Array(buf), u = new Uint32Array(buf);
    fl.set(f.eye, 0); fl[3] = f.time;
    fl.set(f.ball.map((v) => v * c.ballIntensity), 4); fl[7] = c.ballRadius;
    fl.set(c.flashColour, 8); fl[11] = c.flashRadius;
    const balls = source.balls ?? [];
    for (let k = 0; k < MAX_BALLS; k++) u[12 + k] = balls[k] ?? NONE;
    u[16] = Math.min(source.count, source.capacity);
    u[17] = this.frame++;
    fl[18] = c.flashTau; fl[19] = c.flashIntensity; fl[20] = c.flashFull;
    this.device.queue.writeBuffer(this.params, 0, buf);
    pass.setBindGroup(0, this.binds.balls);
    pass.setPipeline(this.pipes.balls);
    pass.dispatchWorkgroups(1);
    pass.setBindGroup(0, this.binds.flashPick);
    pass.setPipeline(this.pipes.flashPick);
    pass.dispatchWorkgroups(Math.ceil(MAX_EVENTS / 64));
    pass.setBindGroup(0, this.binds.flashTake);
    pass.setPipeline(this.pipes.flashTake);
    pass.dispatchWorkgroups(1);
    pass.setBindGroup(0, this.binds.pack);
    pass.setPipeline(this.pipes.pack);
    pass.dispatchWorkgroups(1);
  }

  /** Frame counter the next encode uses (the trail head is frame % TRAIL). */
  get nextFrame(): number { return this.frame; }

  destroy(): void {
    for (const b of [this.lights, this.trail, this.flashes, this.keys, this.params]) b.destroy();
  }
}

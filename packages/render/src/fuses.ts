// Lit fuses (the bomb visuals, step 2): a flickering spark on top of each
// marked body, so a bomb in flight reads as a bomb, not as another ball.
// Renderer.fuse(slot) marks one (the game marks a weapon's shells); a
// marked body that is removed (tier free, a spent shell) or not drawn
// shows nothing, so the mark needs no clearing when the bomb goes off.
//
// Drawn from the cull pass's records (the body's drawn, interpolated pose),
// so the spark rides the ball without a frame of lag: one screen-facing quad
// per fuse holding the classic cartoon-bomb silhouette: a dark cap on the
// ball's top, a short bowed cord glowing at its burning end, and at the end a
// spark (a four-point star that turns and flickers, a steady 4 Hz blink,
// three embers drifting up). The spark is at least MIN_PX across and the cord
// at least MIN_CORD_PX long however far the ball is (a marble-sized shell
// stays readable at the back of a level). Premultiplied blend: the cord
// covers, the fire adds.
//
// Cost: nothing with no fuse (no draw, nothing compiled); with some, at
// most MAX_FUSES small quads.
//
// Alternatives considered: the FX record's emissive flash (fx.ts) glows in
// the body's own colour, which for a dark iron shell is dark; an overlay
// sphere (setOverlay) is replaced wholesale by the aim preview and follows
// the snapshot, not the drawn pose; a point light per fuse costs every
// lit fragment a loop iteration for a cue a sprite already gives.
import { Body, RenderRecord, TIER, wgslStruct } from '@tb/schema';
import { HDR_FORMAT } from './post.ts';
import type { Mat4 } from './math.ts';

export const MAX_FUSES = 8;
/** Smallest spark on screen, pixels across. */
export const MIN_PX = 16;
/** Shortest fuse cord on screen, pixels. */
export const MIN_CORD_PX = 7;
const SAMPLES = 4;
const UNIFORM_FLOATS = 24;

export const FUSE_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(RenderRecord)}
struct FuseFrame { viewProj: mat4x4f, viewport: vec2f, time: f32, gain: f32, focalPx: f32, count: u32, capacity: u32, pad: u32 }
@group(0) @binding(0) var<uniform> ff: FuseFrame;
@group(0) @binding(1) var<storage, read> records: array<RenderRecord>;
@group(0) @binding(2) var<storage, read> bodies: array<Body>;
@group(0) @binding(3) var<storage, read> slots: array<u32, ${MAX_FUSES}>;

struct FOut {
  @builtin(position) clip: vec4f,
  @location(0) p: vec2f,                         // pixels from the spark, y up
  @location(1) @interpolate(flat) base: vec4f,   // xy: the cord's base (the ball's top), pixels from the spark; z: ball radius, px; w: spark radius, px
  @location(2) @interpolate(flat) k: u32,
}

@vertex fn vsFuse(@builtin(vertex_index) vi: u32, @builtin(instance_index) k: u32) -> FOut {
  var o: FOut;
  o.clip = vec4f(0.0, 0.0, 2.0, 1.0);
  o.k = k;
  let i = slots[k];
  if (k >= ff.count || i >= ff.capacity) { return o; }
  let tier = (bodies[i].flags >> 8u) & 0xffu;
  if (tier == ${TIER.free}u || tier == ${TIER.lattice}u) { return o; }
  let r = records[i];
  let h = r.half.x;
  // The cord rises from the top of the ball; drawn in screen space (screen up = world up for a level camera).
  let top = ff.viewProj * vec4f(r.pos + vec3f(0.0, h, 0.0), 1.0);
  if (top.w < 0.05) { return o; }
  let hp = h * ff.focalPx / top.w;                 // ball radius, px
  let cord = max(0.8 * hp, ${MIN_CORD_PX}.0);       // cord length, px
  let spark = max(0.45 * hp, ${MIN_PX / 2}.0);       // spark radius, px
  let tipPx = vec2f(0.3, 0.95) * cord;              // the burning end, leaning a little
  let half = length(tipPx) + spark + 2.0;
  // Centred on the spark; nudged toward the eye by the ball's radius so the ball's own top does not hide the cord's base.
  let toward = ff.viewProj * vec4f(r.pos + vec3f(0.0, h, 0.0) - normalize(r.pos) * h, 1.0);
  let z = toward.z / toward.w;
  let corner = vec2f(array<f32, 6>(-1.0, 1.0, 1.0, -1.0, 1.0, -1.0)[vi], array<f32, 6>(-1.0, -1.0, 1.0, -1.0, 1.0, 1.0)[vi]);
  let centre = top.xy / top.w + tipPx / ff.viewport * 2.0;
  o.clip = vec4f(centre + corner * half / ff.viewport * 2.0, clamp(z, 0.0, 1.0), 1.0);
  o.p = corner * half;
  o.base = vec4f(-tipPx, hp, spark);
  return o;
}

@fragment fn fsFuse(o: FOut) -> @location(0) vec4f {
  let t = ff.time + f32(o.k) * 1.37;
  let flicker = 0.75 + 0.25 * sin(t * 53.0) * sin(t * 31.0 + 1.0);
  let blink = select(0.55, 1.0, fract(t * 4.0) < 0.5);
  // The cord: a bowed line from the spark (0) to the ball's top (base.xy), dark, glowing at the burning end.
  let ab = o.base.xy;
  let u = clamp(dot(o.p, ab) / dot(ab, ab), 0.0, 1.0);
  let perp = normalize(vec2f(-ab.y, ab.x));
  let curve = ab * u + perp * sin(3.14159 * u) * 0.18 * length(ab);
  let cw = max(0.09 * o.base.z, 1.2);              // cord half width, px
  let dc = length(o.p - curve);
  let cordA = (1.0 - smoothstep(cw - 0.7, cw + 0.7, dc)) * step(0.0, u);
  // A dark cap where the cord meets the ball.
  let capR = max(0.22 * o.base.z, 2.0);
  let capA = 1.0 - smoothstep(capR - 0.7, capR + 0.7, length(o.p - ab));
  let dark = max(cordA, capA);
  let ember = (1.0 - smoothstep(0.0, 0.3, u)) * cordA;
  // The spark: a turning four-point star around a white-hot core, orange-red outside.
  let d = length(o.p) / o.base.w;
  let a = atan2(o.p.y, o.p.x) + t * 2.5;
  let core = exp(-d * d * 28.0);
  let star = pow(abs(cos(2.0 * a)), 24.0) * exp(-d * 3.2) * (1.0 - smoothstep(0.7, 1.0, d));
  let glow = exp(-d * d * 5.0) * 0.3;
  // Three embers drifting up off the spark.
  var embers = 0.0;
  for (var j = 0; j < 3; j++) {
    let ph = fract(t * 1.3 + f32(j) / 3.0);
    let c = vec2f(sin(f32(j) * 2.4 + t) * 0.5, 0.6 + ph * 2.2) * o.base.w;
    let de = length(o.p - c) / max(0.12 * o.base.w, 0.9);
    embers += exp(-de * de) * (1.0 - ph);
  }
  let i = (core * 3.0 + star * 1.6 + glow + embers * 0.8) * flicker * blink * ff.gain;
  let emit = vec3f(1.0, 0.45, 0.12) * (i + ember * 2.0 * ff.gain * blink) + vec3f(1.0, 0.92, 0.8) * core * ff.gain;
  // Premultiplied: the cord and cap cover what is behind them, the fire adds on top.
  return vec4f(vec3f(0.012, 0.011, 0.01) * ff.gain * dark * (1.0 - ember) + emit, dark);
}
`;

/** CPU side: the marked slots, the pipeline (made at the first fuse) and the draw. */
export class Fuses {
  private marked: number[] = [];
  private gpu: { pipe: GPURenderPipeline; uniform: GPUBuffer; slots: GPUBuffer; bind: GPUBindGroup | null; bound: unknown[] } | null = null;
  private drawCount = 0;

  constructor(private readonly device: GPUDevice) {}

  /** Mark (or unmark) a body slot's fuse; at most MAX_FUSES, the oldest dropped. */
  set(slot: number, on: boolean): void {
    this.marked = this.marked.filter((s) => s !== slot);
    if (!on) return;
    this.marked.push(slot);
    if (this.marked.length > MAX_FUSES) this.marked.shift();
  }

  /** Marked slots, oldest first. */
  get slots(): readonly number[] { return this.marked; }

  clear(): void { this.marked = []; }

  /** Upload this frame's uniforms; returns whether draw() has anything to record. viewProj is camera-relative. */
  prepare(f: { viewProj: Mat4; viewport: [number, number]; time: number; gain: number; records: GPUBuffer; bodies: GPUBuffer; capacity: number }): boolean {
    this.drawCount = this.marked.length;
    if (!this.drawCount) return false;
    const g = (this.gpu ??= this.make());
    if (!g.bind || g.bound[0] !== f.records || g.bound[1] !== f.bodies) {
      g.bind = this.device.createBindGroup({
        layout: g.pipe.getBindGroupLayout(0),
        entries: [{ binding: 0, resource: { buffer: g.uniform } }, { binding: 1, resource: { buffer: f.records } }, { binding: 2, resource: { buffer: f.bodies } }, { binding: 3, resource: { buffer: g.slots } }],
      });
      g.bound = [f.records, f.bodies];
    }
    const buf = new ArrayBuffer(UNIFORM_FLOATS * 4), fl = new Float32Array(buf), u = new Uint32Array(buf);
    fl.set(f.viewProj, 0);
    fl[16] = f.viewport[0]; fl[17] = f.viewport[1]; fl[18] = f.time; fl[19] = f.gain;
    // Pixels per unit of size at view depth 1: the projection's y scale times half the height.
    fl[20] = Math.hypot(f.viewProj[1]!, f.viewProj[5]!, f.viewProj[9]!) * f.viewport[1] / 2;
    u[21] = this.drawCount; u[22] = f.capacity;
    this.device.queue.writeBuffer(g.uniform, 0, buf);
    const slots = new Uint32Array(MAX_FUSES).fill(0xffffffff);
    slots.set(this.marked);
    this.device.queue.writeBuffer(g.slots, 0, slots);
    return true;
  }

  draw(pass: GPURenderPassEncoder): void {
    if (!this.drawCount || !this.gpu?.bind) return;
    pass.setPipeline(this.gpu.pipe);
    pass.setBindGroup(0, this.gpu.bind);
    pass.draw(6, this.drawCount);
  }

  private make(): NonNullable<Fuses['gpu']> {
    const d = this.device, module = d.createShaderModule({ code: FUSE_WGSL, label: 'fuses' });
    const pipe = d.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFuse' },
      fragment: {
        module, entryPoint: 'fsFuse',
        targets: [{ format: HDR_FORMAT, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE, blend: { color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
      },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    const uniform = d.createBuffer({ size: UNIFORM_FLOATS * 4, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'fuse frame' });
    const slots = d.createBuffer({ size: MAX_FUSES * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'fuse slots' });
    return { pipe, uniform, slots, bind: null, bound: [] };
  }

  destroy(): void {
    this.gpu?.uniform.destroy();
    this.gpu?.slots.destroy();
  }
}

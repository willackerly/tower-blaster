// HDR post: a bloom pyramid and the final composite (bloom mix, exposure,
// grain, a tone map (AgX by default; tonemap.ts), the frozen grade, vignette,
// dither) into the display target.
//
// Frozen grade (Bullet Time, playtest PT8): the game's frozen world must not
// look like the running one. In display space after the tone map, by
// `grade` (0 none, 1 full; the game eases it in and out): most of the colour
// drained toward luma (FROZEN_DESAT), what is left cooled (FROZEN_TINT), and
// a soft ice-blue frost at the frame's rounded edge (FROZEN_RIM). Alternatives: a CSS
// filter on the canvas (no GPU work, but not in readback captures, so neither
// tests nor the agent playtests would see it); a grade in the scene pass (it
// would have to be in every look's shading, and miss the sky and bloom).
//
// Bloom (Jimenez 2014, as in CoD: AW): downsample from half resolution with
// a 13-tap filter (optionally Karis-weighted on the first level, which tames
// single-pixel fireflies at the cost of energy), then upsample with a 3x3
// tent, adding each level onto the one above. Every filter preserves the
// mean, so the pyramid's top level divided by the level count has the same
// mean as the input: mixing it in redistributes light without adding any.
import { AGX_WGSL, TONE_MAPS, type ToneMap } from './look.ts';
import { PCG_WGSL } from './noise.ts';
import { GRAIN_WGSL, grainPixels, TONE_GAIN, TONE_WGSL } from './tonemap.ts';

/** The frozen grade: the share of colour drained, the tint left on it, and the rim's colour, width (uv) and strength. */
export const FROZEN_DESAT = 0.85;
export const FROZEN_TINT = [0.92, 0.97, 1.08] as const;
export const FROZEN_RIM = [0.45, 0.72, 1.0] as const;
export const FROZEN_RIM_WIDTH = 0.045;
/** The frost's corner radius, as a share of the frame's short side. */
export const FROZEN_RIM_ROUND = 0.08;
export const FROZEN_RIM_MIX = 0.42;

export const BLOOM_FORMAT: GPUTextureFormat = 'rgba16float';
export const HDR_FORMAT: GPUTextureFormat = 'rgba16float';

const FULLSCREEN = /* wgsl */ `
struct FsOut { @builtin(position) clip: vec4f, @location(0) uv: vec2f }
@vertex fn vsFull(@builtin(vertex_index) vi: u32) -> FsOut {
  let t = vec2f(f32((vi << 1u) & 2u), f32(vi & 2u));
  var o: FsOut;
  o.clip = vec4f(t * 2.0 - 1.0, 0.0, 1.0);
  o.uv = vec2f(t.x, 1.0 - t.y);
  return o;
}
`;

export const BLOOM_WGSL = /* wgsl */ `
${FULLSCREEN}
@group(0) @binding(0) var src: texture_2d<f32>;
@group(0) @binding(1) var samp: sampler;
override KARIS: bool = false;

fn tap(uv: vec2f, o: vec2f) -> vec3f {
  return textureSampleLevel(src, samp, uv + o / vec2f(textureDimensions(src)), 0.0).rgb;
}

fn boxWeight(c: vec3f) -> f32 {
  return select(1.0, 1.0 / (1.0 + dot(c, vec3f(0.2126, 0.7152, 0.0722))), KARIS);
}

@fragment fn fsDown(i: FsOut) -> @location(0) vec4f {
  let a = tap(i.uv, vec2f(-2, -2)); let b = tap(i.uv, vec2f(0, -2)); let c = tap(i.uv, vec2f(2, -2));
  let d = tap(i.uv, vec2f(-1, -1)); let e = tap(i.uv, vec2f(1, -1));
  let f = tap(i.uv, vec2f(-2, 0)); let g = tap(i.uv, vec2f(0, 0)); let h = tap(i.uv, vec2f(2, 0));
  let j = tap(i.uv, vec2f(-1, 1)); let k = tap(i.uv, vec2f(1, 1));
  let l = tap(i.uv, vec2f(-2, 2)); let m = tap(i.uv, vec2f(0, 2)); let n = tap(i.uv, vec2f(2, 2));
  // Five overlapping 2x2 boxes: the centre one weighs 0.5, the corners 0.125 each.
  let boxes = array<vec3f, 5>((d + e + j + k) * 0.25, (a + b + f + g) * 0.25, (b + c + g + h) * 0.25, (f + g + l + m) * 0.25, (g + h + m + n) * 0.25);
  let w = array<f32, 5>(0.5, 0.125, 0.125, 0.125, 0.125);
  var sum = vec3f(0.0);
  var wsum = 0.0;
  for (var q = 0; q < 5; q++) {
    let ww = w[q] * boxWeight(boxes[q]);
    sum += boxes[q] * ww;
    wsum += ww;
  }
  return vec4f(sum / wsum, 1.0);
}

@fragment fn fsUp(i: FsOut) -> @location(0) vec4f {
  var s = tap(i.uv, vec2f(0, 0)) * 4.0;
  s += (tap(i.uv, vec2f(-1, 0)) + tap(i.uv, vec2f(1, 0)) + tap(i.uv, vec2f(0, -1)) + tap(i.uv, vec2f(0, 1))) * 2.0;
  s += tap(i.uv, vec2f(-1, -1)) + tap(i.uv, vec2f(1, -1)) + tap(i.uv, vec2f(-1, 1)) + tap(i.uv, vec2f(1, 1));
  return vec4f(s / 16.0, 1.0);
}
`;

export const COMPOSITE_WGSL = /* wgsl */ `
${FULLSCREEN}
// tone: TONE_MAPS index (0: agx), its mid-grey gain; grain: amount (0: none), size (px), frame seed; grade: the frozen grade (Bullet Time), 0 to 1;
// keep: 1 leaves what the scene marked (alpha over 1, fx.ts KEEP_ALPHA) out of the grade's drain and tint, 0 grades it too.
struct Post { bloomMix: f32, exposure: f32, vignette: f32, levels: f32, tone: u32, toneGain: f32, grain: f32, grainSize: f32, seed: u32, grade: f32, keep: f32, pad2: u32 }
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;
${AGX_WGSL}
${TONE_WGSL}
${PCG_WGSL}
${GRAIN_WGSL}

// The frozen grade (FROZEN_* above): drained, cooled, an ice-blue rim. d: uv from the centre. keep: 0 to 1, how much
// of this pixel stays out of the drain and the tint (PT33: what the player aims at keeps its colour); the rim is the frame's.
fn frozenGrade(c: vec3f, d: vec2f, g: f32, size: vec2f, keep: f32) -> vec3f {
  let l = dot(c, vec3f(0.2126, 0.7152, 0.0722));
  let gk = g * (1.0 - keep);
  var x = mix(c, vec3f(l), ${FROZEN_DESAT} * gk);
  x *= mix(vec3f(1.0), vec3f(${FROZEN_TINT.join(', ')}), gk);
  // A rounded rectangle inset from the frame's edge, in units of the short side so the frost is
  // as wide on every side and its corners round (an uv-space shape looks lopsided off-square),
  // faded in quadratically over FROZEN_RIM_WIDTH so it frosts in rather than drawing a hard border.
  let s = size / min(size.x, size.y);
  let r = ${FROZEN_RIM_ROUND};
  let q = abs(d) * s - (0.5 * s - vec2f(r));
  let sd = length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0) - r;
  let t = smoothstep(${-FROZEN_RIM_WIDTH}, 0.0, sd);
  return mix(x, vec3f(${FROZEN_RIM.join(', ')}), ${FROZEN_RIM_MIX} * g * t * t);
}

// Interleaved gradient noise (Jimenez 2014): cheap, well-spread dither.
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@fragment fn fsComposite(i: FsOut) -> @location(0) vec4f {
  let px = vec2i(i.clip.xy);
  let h4 = textureLoad(hdr, px, 0);
  let h = h4.rgb;
  let b = textureSampleLevel(bloom, samp, i.uv, 0.0).rgb / max(post.levels, 1.0);
  var x = mix(h, b, post.bloomMix) * post.exposure;
  // Grain (realism step 7): in linear light, before the tone map compresses it.
  if (post.grain > 0.0) { x = grained(x, post.grain, grainNoise(i.clip.xy, post.seed, post.grainSize)); }
  // AgX stays the default (and the stylized looks' only); the others are the real look's A/B (tonemap.ts).
  var c: vec3f;
  if (post.tone == 0u) { c = agx(x); } else { c = toneMapAlt(post.tone, x * post.toneGain); }
  let d = i.uv - 0.5;
  if (post.grade > 0.0) { c = frozenGrade(c, d, post.grade, vec2f(textureDimensions(hdr)), post.keep * clamp(h4.a - 1.0, 0.0, 1.0)); }
  c *= 1.0 - post.vignette * dot(d, d) * 2.0;
  c += (ign(i.clip.xy) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

/** toneMap: default agx; grain: film grain amount (0 or left out: none) and size in pixels (tonemap.ts); grade: the frozen grade's amount, 0 (none, the default) to 1; keep: whether what the scene marked stays in colour under it (true by default). */
export interface PostParams { bloomMix: number; exposure: number; vignette: number; toneMap?: ToneMap; grain?: { amount: number; size: number }; grade?: number; keep?: boolean }

/** The composite's uniform block (Post in COMPOSITE_WGSL): 48 bytes. seed: the grain's frame seed; height: the frame's, which scales the grain (grainPixels). */
export function postUniforms(p: PostParams, levels: number, seed: number, height = 1080): ArrayBuffer {
  const b = new ArrayBuffer(48), f = new Float32Array(b), u = new Uint32Array(b);
  const op = p.toneMap ?? 'agx';
  f.set([p.bloomMix, p.exposure, p.vignette, levels]);
  u[4] = TONE_MAPS.indexOf(op);
  f[5] = TONE_GAIN[op];
  f[6] = p.grain?.amount ?? 0;
  f[7] = grainPixels(p.grain?.size ?? 1, height);
  u[8] = seed >>> 0;
  f[9] = Math.min(1, Math.max(0, p.grade ?? 0));
  f[10] = p.keep === false ? 0 : 1;
  return b;
}

/** Timestamp writes for a labelled pass (from a GpuProfiler), or none. */
export type Stamp = (label: string) => { timestampWrites?: GPURenderPassTimestampWrites };
export const noStamp: Stamp = () => ({});

/** Bloom pyramid and composite for one output size. */
export class Post {
  readonly levels: GPUTexture[] = [];
  private readonly sampler: GPUSampler;
  private readonly down: GPURenderPipeline;
  private readonly downKaris: GPURenderPipeline;
  private readonly up: GPURenderPipeline;
  private readonly composite: GPURenderPipeline;
  private readonly uniform: GPUBuffer;
  private width = 0;
  private height = 0;

  constructor(private readonly device: GPUDevice, readonly outFormat: GPUTextureFormat, readonly maxLevels = 6) {
    this.sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });
    const bloom = device.createShaderModule({ code: BLOOM_WGSL, label: 'bloom' });
    const comp = device.createShaderModule({ code: COMPOSITE_WGSL, label: 'composite' });
    const pipe = (module: GPUShaderModule, fs: string, format: GPUTextureFormat, opts: { karis?: boolean; add?: boolean } = {}) => device.createRenderPipeline({
      layout: 'auto',
      vertex: { module, entryPoint: 'vsFull' },
      fragment: {
        module, entryPoint: fs, ...(opts.karis !== undefined ? { constants: { KARIS: opts.karis ? 1 : 0 } } : {}),
        targets: [{ format, ...(opts.add ? { blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' } } } : {}) }],
      },
      primitive: { topology: 'triangle-list' },
    });
    this.down = pipe(bloom, 'fsDown', BLOOM_FORMAT, { karis: false });
    this.downKaris = pipe(bloom, 'fsDown', BLOOM_FORMAT, { karis: true });
    this.up = pipe(bloom, 'fsUp', BLOOM_FORMAT, { add: true });
    this.composite = pipe(comp, 'fsComposite', outFormat);
    this.uniform = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'post params' });
  }

  private resize(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    for (const t of this.levels) t.destroy();
    this.levels.length = 0;
    let lw = Math.max(1, w >> 1), lh = Math.max(1, h >> 1);
    // At least one level, however small the target (a hidden or tiny canvas), so the composite always has a bloom input.
    while (this.levels.length < this.maxLevels && (this.levels.length === 0 || (lw >= 4 && lh >= 4))) {
      this.levels.push(this.device.createTexture({ size: [lw, lh], format: BLOOM_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label: `bloom ${this.levels.length}` }));
      lw = Math.max(1, lw >> 1);
      lh = Math.max(1, lh >> 1);
    }
    this.width = w;
    this.height = h;
  }

  private draw(enc: GPUCommandEncoder, pipe: GPURenderPipeline, src: GPUTextureView, dst: GPUTextureView, load: boolean, stamp: Stamp): void {
    const p = enc.beginRenderPass({ ...stamp('bloom'), colorAttachments: [{ view: dst, loadOp: load ? 'load' : 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
    p.setPipeline(pipe);
    p.setBindGroup(0, this.device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: src }, { binding: 1, resource: this.sampler }] }));
    p.draw(3);
    p.end();
  }

  /** Build the bloom pyramid from an HDR texture; levels[0] then holds the sum of all levels. */
  encodeBloom(enc: GPUCommandEncoder, hdr: GPUTexture, karis = true, stamp: Stamp = noStamp): void {
    this.resize(hdr.width, hdr.height);
    const views = this.levels.map((t) => t.createView());
    views.forEach((v, i) => this.draw(enc, i === 0 && karis ? this.downKaris : this.down, i === 0 ? hdr.createView() : views[i - 1]!, v, false, stamp));
    for (let i = views.length - 2; i >= 0; i--) this.draw(enc, this.up, views[i + 1]!, views[i]!, true, stamp);
  }

  /**
   * Bloom, then composite into out. exposureFrom: a GPU-computed exposure
   * (an f32 at offset in buffer, which needs COPY_SRC) that replaces
   * p.exposure, copied in on the GPU timeline. seed: the grain's frame seed
   * (a new one each frame, so the grain moves as film's does).
   */
  encode(enc: GPUCommandEncoder, hdr: GPUTexture, out: GPUTextureView, p: PostParams, stamp: Stamp = noStamp, exposureFrom?: { buffer: GPUBuffer; offset: number }, seed = 0): void {
    this.encodeBloom(enc, hdr, true, stamp);
    this.device.queue.writeBuffer(this.uniform, 0, postUniforms(p, this.levels.length, seed, hdr.height));
    if (exposureFrom) enc.copyBufferToBuffer(exposureFrom.buffer, exposureFrom.offset, this.uniform, 4, 4);
    const pass = enc.beginRenderPass({ ...stamp('composite'), colorAttachments: [{ view: out, loadOp: 'clear', clearValue: { r: 0, g: 0, b: 0, a: 1 }, storeOp: 'store' }] });
    pass.setPipeline(this.composite);
    pass.setBindGroup(0, this.device.createBindGroup({
      layout: this.composite.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: hdr.createView() }, { binding: 1, resource: this.levels[0]!.createView() }, { binding: 2, resource: this.sampler }, { binding: 3, resource: { buffer: this.uniform } }],
    }));
    pass.draw(3);
    pass.end();
  }

  destroy(): void {
    for (const t of this.levels) t.destroy();
    this.uniform.destroy();
  }
}

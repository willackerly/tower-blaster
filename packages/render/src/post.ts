// HDR post: a bloom pyramid and the final composite (bloom mix, exposure,
// AgX, vignette, dither) into the display target.
//
// Bloom (Jimenez 2014, as in CoD: AW): downsample from half resolution with
// a 13-tap filter (optionally Karis-weighted on the first level, which tames
// single-pixel fireflies at the cost of energy), then upsample with a 3x3
// tent, adding each level onto the one above. Every filter preserves the
// mean, so the pyramid's top level divided by the level count has the same
// mean as the input: mixing it in redistributes light without adding any.
import { AGX_WGSL } from './look.ts';

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
struct Post { bloomMix: f32, exposure: f32, vignette: f32, levels: f32 }
@group(0) @binding(0) var hdr: texture_2d<f32>;
@group(0) @binding(1) var bloom: texture_2d<f32>;
@group(0) @binding(2) var samp: sampler;
@group(0) @binding(3) var<uniform> post: Post;
${AGX_WGSL}

// Interleaved gradient noise (Jimenez 2014): cheap, well-spread dither.
fn ign(p: vec2f) -> f32 {
  return fract(52.9829189 * fract(dot(p, vec2f(0.06711056, 0.00583715))));
}

@fragment fn fsComposite(i: FsOut) -> @location(0) vec4f {
  let px = vec2i(i.clip.xy);
  let h = textureLoad(hdr, px, 0).rgb;
  let b = textureSampleLevel(bloom, samp, i.uv, 0.0).rgb / max(post.levels, 1.0);
  var c = agx(mix(h, b, post.bloomMix) * post.exposure);
  let d = i.uv - 0.5;
  c *= 1.0 - post.vignette * dot(d, d) * 2.0;
  c += (ign(i.clip.xy) - 0.5) / 255.0;
  return vec4f(c, 1.0);
}
`;

export interface PostParams { bloomMix: number; exposure: number; vignette: number }

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
    this.uniform = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'post params' });
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

  /** Bloom, then composite into out. */
  encode(enc: GPUCommandEncoder, hdr: GPUTexture, out: GPUTextureView, p: PostParams, stamp: Stamp = noStamp): void {
    this.encodeBloom(enc, hdr, true, stamp);
    this.device.queue.writeBuffer(this.uniform, 0, new Float32Array([p.bloomMix, p.exposure, p.vignette, this.levels.length]));
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

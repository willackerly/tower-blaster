// WebGPU renderer for boxes and spheres, drawn from a BodySource with GPU
// culling and indirect draws (cull.ts). Geometry is built from vertex_index
// (no vertex buffers); positions are camera-relative. Sun shadow map with
// 3x3 PCF, hemisphere ambient, bevel-style edge darkening, contact darkening
// near the ground, distance fog, 4x MSAA.
import { RenderRecord, wgslStruct } from '@tb/schema';
import { Culler, SEG, type CullFrame } from './cull.ts';
import { lookAt, multiply, normalize, type Mat4, type V3 } from './math.ts';
import { SnapshotSource, type BodySource } from './source.ts';

const SHADOW_SIZE = 2048;
const SAMPLES = 4;
const SPHERE_SEG = 24;
const SPHERE_RINGS = 14;
export const SPHERE_VERTS = SPHERE_SEG * SPHERE_RINGS * 6;
export const BOX_VERTS = 36;
// From the camera's right, slightly behind the scene: one lit face, one in
// shade, and shadows falling toward the viewer.
export const SUN: V3 = normalize([0.55, 0.75, -0.3]);

const SHADER = /* wgsl */ `
${wgslStruct(RenderRecord)}

struct Frame {
  viewProj: mat4x4f,       // camera-relative
  lightViewProj: mat4x4f,  // camera-relative
  eye: vec3f,
  fogDist: f32,
  sun: vec3f,
  groundY: f32,
  capacity: u32,
}
@group(0) @binding(0) var<uniform> fr: Frame;
@group(0) @binding(1) var<storage, read> records: array<RenderRecord>;
@group(0) @binding(2) var<storage, read> lists: array<u32>;
@group(0) @binding(3) var shadowMap: texture_depth_2d;
@group(0) @binding(4) var shadowSampler: sampler_comparison;

// Which list a pipeline draws: SEG * capacity is its first entry.
override SEG: u32 = 0u;

const PI = 3.14159265;
const SKY = vec3f(0.80, 0.86, 0.94);
const PALETTE = array<vec3f, 8>(
  vec3f(0.91, 0.40, 0.32), vec3f(0.97, 0.72, 0.33), vec3f(0.42, 0.72, 0.60),
  vec3f(0.35, 0.57, 0.86), vec3f(0.62, 0.49, 0.82), vec3f(0.93, 0.89, 0.82),
  vec3f(0.16, 0.18, 0.22), vec3f(0.62, 0.62, 0.62));

fn qrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn hash(x: u32) -> f32 {
  var h = x * 747796405u + 2891336453u;
  h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
  return f32((h >> 22u) ^ h) / 4294967295.0;
}

// Unit-cube corner and normal for vertex vi of 36: face vi/6, two CCW triangles.
fn cubeCorner(vi: u32) -> array<vec3f, 2> {
  let f = vi / 6u;
  let axis = f / 2u;
  let s = select(-1.0, 1.0, f % 2u == 0u);
  let uv = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, -1), vec2f(1, 1), vec2f(-1, -1), vec2f(1, 1), vec2f(-1, 1))[vi % 6u];
  var p = vec3f(0.0);
  var n = vec3f(0.0);
  p[axis] = s;
  n[axis] = s;
  p[(axis + 1u) % 3u] = uv.x;
  p[(axis + 2u) % 3u] = uv.y * s;
  return array<vec3f, 2>(p, n);
}

fn sphereCorner(vi: u32) -> vec3f {
  let q = vi / 6u;
  // Counter-clockwise seen from outside: +phi then +theta.
  let d = array<vec2u, 6>(vec2u(0, 0), vec2u(1, 1), vec2u(0, 1), vec2u(0, 0), vec2u(1, 0), vec2u(1, 1))[vi % 6u];
  let i = q % ${SPHERE_SEG}u + d.x;
  let j = q / ${SPHERE_SEG}u + d.y;
  let theta = f32(j) / ${SPHERE_RINGS}.0 * PI;
  let phi = f32(i) / ${SPHERE_SEG}.0 * 2.0 * PI;
  return vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
}

fn record(ii: u32) -> RenderRecord {
  return records[lists[SEG * fr.capacity + ii]];
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) rel: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) look: u32,
  @location(4) @interpolate(flat) slot: u32,
  @location(5) @interpolate(flat) shape: u32,
}

fn place(r: RenderRecord, corner: vec3f, normal: vec3f, shape: u32) -> VOut {
  let rel = r.pos + qrot(r.rot, corner * r.half);
  var o: VOut;
  o.clip = fr.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  o.normal = qrot(r.rot, normal);
  o.local = corner;
  o.look = r.look;
  o.slot = r.slot;
  o.shape = shape;
  return o;
}

@vertex fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let c = cubeCorner(vi);
  return place(record(ii), c[0], c[1], 0u);
}

@vertex fn vsSphere(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = sphereCorner(vi);
  return place(record(ii), p, p, 1u);
}

@vertex fn vsBoxShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let r = record(ii);
  return fr.lightViewProj * vec4f(r.pos + qrot(r.rot, cubeCorner(vi)[0] * r.half), 1.0);
}

@vertex fn vsSphereShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let r = record(ii);
  return fr.lightViewProj * vec4f(r.pos + qrot(r.rot, sphereCorner(vi) * r.half), 1.0);
}

fn shadow(rel: vec3f, n: vec3f) -> f32 {
  let lc = fr.lightViewProj * vec4f(rel + n * 0.04, 1.0);
  let uv = lc.xy * vec2f(0.5, -0.5) + 0.5;
  let depth = lc.z - 0.0015;
  let texel = 1.0 / ${SHADOW_SIZE}.0;
  var sum = 0.0;
  for (var y = -1; y <= 1; y++) {
    for (var x = -1; x <= 1; x++) {
      sum += textureSampleCompareLevel(shadowMap, shadowSampler, uv + vec2f(f32(x), f32(y)) * texel, depth);
    }
  }
  let inside = all(uv > vec2f(0.0)) && all(uv < vec2f(1.0)) && depth < 1.0;
  return select(1.0, sum / 9.0, inside);
}

fn shade(base: vec3f, rel: vec3f, n: vec3f) -> vec3f {
  let sun = max(dot(n, fr.sun), 0.0) * shadow(rel, n);
  let hemi = mix(vec3f(0.42, 0.38, 0.34), SKY, n.y * 0.5 + 0.5);
  let contact = 0.6 + 0.4 * smoothstep(0.0, 1.5, rel.y + fr.eye.y - fr.groundY);
  var c = base * (hemi * 0.55 * contact + vec3f(1.0, 0.96, 0.88) * sun * 0.85);
  let fog = 1.0 - exp(-pow(length(rel) / fr.fogDist, 2.0));
  return mix(c, SKY, fog);
}

fn tonemap(c: vec3f) -> vec4f {
  return vec4f(pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}

@fragment fn fsBody(v: VOut) -> @location(0) vec4f {
  let n = normalize(v.normal);
  var base = PALETTE[(v.look >> 8u) & 7u] * (0.88 + 0.24 * hash(v.slot));
  if (v.shape == 0u) {
    // Darken toward cube edges: the second-largest |local| component reaches
    // 1 only on an edge.
    let a = abs(v.local);
    let second = max(min(a.x, a.y), min(max(a.x, a.y), a.z));
    base *= 1.0 - 0.28 * smoothstep(0.88, 0.985, second);
  }
  return tonemap(shade(base, v.rel, n));
}

// Test target: body slot + 1 per pixel, 0 for background.
@fragment fn fsId(v: VOut) -> @location(0) u32 {
  return v.slot + 1u;
}

struct GOut { @builtin(position) clip: vec4f, @location(0) rel: vec3f }

@vertex fn vsGround(@builtin(vertex_index) vi: u32) -> GOut {
  let uv = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, 1), vec2f(1, -1), vec2f(-1, -1), vec2f(-1, 1), vec2f(1, 1))[vi];
  let rel = vec3f(uv.x * 600.0, fr.groundY - fr.eye.y, uv.y * 600.0);
  var o: GOut;
  o.clip = fr.viewProj * vec4f(rel, 1.0);
  o.rel = rel;
  return o;
}

@fragment fn fsGround(g: GOut) -> @location(0) vec4f {
  // 1 m grid with screen-space antialiased lines.
  let p = g.rel.xz + fr.eye.xz;
  let w = fwidth(p);
  let line = abs(fract(p - 0.5) - 0.5) / max(w, vec2f(1e-4));
  let grid = 1.0 - min(min(line.x, line.y), 1.0);
  let base = mix(vec3f(0.86, 0.85, 0.82), vec3f(0.74, 0.73, 0.70), grid * 0.6);
  return tonemap(shade(base, g.rel, vec3f(0.0, 1.0, 0.0)));
}
`;

export function ortho(l: number, r: number, b: number, t: number, n: number, f: number): Mat4 {
  const m = new Float32Array(16);
  m[0] = 2 / (r - l);
  m[5] = 2 / (t - b);
  m[10] = 1 / (n - f);
  m[12] = -(r + l) / (r - l);
  m[13] = -(t + b) / (t - b);
  m[14] = n / (n - f);
  m[15] = 1;
  return m;
}

export function translation(t: V3): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

/** Sun view-projection covering a sphere around the scene. */
export function lightMatrix(center: V3, radius: number, sun: V3 = SUN): Mat4 {
  const r = Math.max(radius, 4);
  const eye: V3 = [center[0] + sun[0] * 2 * r, center[1] + sun[1] * 2 * r, center[2] + sun[2] * 2 * r];
  return multiply(ortho(-r, r, -r, r, 0.1, 4 * r), lookAt(eye, center, Math.abs(sun[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
}

export interface FrameParams {
  /** World-space view-projection; made camera-relative internally. */
  viewProj: Mat4;
  eye: V3;
  groundY: number;
  fogDist: number;
  /** Interpolation between the previous step (0) and the latest (1). */
  alpha?: number;
  /** Draw every body regardless of frusta (tests compare against this). */
  noCull?: boolean;
}

export type RenderTarget = { canvas: HTMLCanvasElement } | { size: [number, number] };

type PipeName = 'box' | 'sphere' | 'ground' | 'boxShadow' | 'sphereShadow' | 'boxId' | 'sphereId';

export class Renderer {
  readonly format: GPUTextureFormat;
  private readonly frameBuf: GPUBuffer;
  private readonly layout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly pipes: Record<PipeName, GPURenderPipeline>;
  private readonly shadowTex: GPUTexture;
  private readonly shadowSampler: GPUSampler;
  private readonly context: GPUCanvasContext | null;
  private readonly offscreen: GPUTexture | null;
  private msaa: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private light: Mat4 = lightMatrix([0, 0, 0], 50);
  private source: BodySource;
  private culler: Culler | null = null;
  private cullKey = '';
  private bind: GPUBindGroup | null = null;
  private shadowBind: GPUBindGroup | null = null;

  constructor(readonly device: GPUDevice, target: RenderTarget) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    if ('canvas' in target) {
      const ctx = target.canvas.getContext('webgpu');
      if (!ctx) throw new Error('could not get a webgpu canvas context');
      ctx.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.context = ctx;
      this.offscreen = null;
    } else {
      this.context = null;
      this.offscreen = device.createTexture({ size: target.size, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    }
    this.frameBuf = device.createBuffer({ size: 176, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const ro = { type: 'read-only-storage' } as const;
    const common: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: ro },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: ro },
    ];
    this.layout = device.createBindGroupLayout({
      entries: [
        ...common,
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    // The shadow pass cannot bind the shadow map it writes.
    this.shadowLayout = device.createBindGroupLayout({ entries: common });
    const module = device.createShaderModule({ code: SHADER, label: 'render' });
    const main = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const shadowPl = device.createPipelineLayout({ bindGroupLayouts: [this.shadowLayout] });
    const color = (vs: string, fs: string, cull: GPUCullMode, seg: number, format: GPUTextureFormat = this.format, samples = SAMPLES): GPURenderPipeline => device.createRenderPipeline({
      layout: main,
      vertex: { module, entryPoint: vs, constants: { SEG: seg } },
      fragment: { module, entryPoint: fs, targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: samples },
    });
    const depthOnly = (vs: string, seg: number): GPURenderPipeline => device.createRenderPipeline({
      layout: shadowPl,
      vertex: { module, entryPoint: vs, constants: { SEG: seg } },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    this.source = new SnapshotSource(device);
    this.pipes = {
      box: color('vsBox', 'fsBody', 'back', SEG.box),
      sphere: color('vsSphere', 'fsBody', 'back', SEG.sphere),
      ground: color('vsGround', 'fsGround', 'none', 0),
      boxShadow: depthOnly('vsBoxShadow', SEG.boxShadow),
      sphereShadow: depthOnly('vsSphereShadow', SEG.sphereShadow),
      boxId: color('vsBox', 'fsId', 'back', SEG.box, 'r32uint', 1),
      sphereId: color('vsSphere', 'fsId', 'back', SEG.sphere, 'r32uint', 1),
    };
  }

  /** Draw bodies from this source from now on. */
  setSource(source: BodySource): void {
    this.source = source;
    this.cullKey = '';
  }

  /** Fit the shadow map to the scene; call when the scene changes. */
  setShadowBounds(center: V3, radius: number): void {
    this.light = lightMatrix(center, radius);
  }

  /** Rebuild the culler and bind groups when the source's buffers change. */
  private sync(): Culler {
    const s = this.source;
    const key = `${s.version}:${s.capacity}`;
    if (key !== this.cullKey || !this.culler || this.culler.source !== s) {
      this.culler?.destroy();
      this.culler = new Culler(this.device, s, { box: BOX_VERTS, sphere: SPHERE_VERTS });
      const buffers = [this.frameBuf, this.culler.records, this.culler.lists];
      const common = buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      this.bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [...common, { binding: 3, resource: this.shadowTex.createView() }, { binding: 4, resource: this.shadowSampler }],
      });
      this.shadowBind = this.device.createBindGroup({ layout: this.shadowLayout, entries: common });
      this.cullKey = key;
    }
    return this.culler;
  }

  private targets(w: number, h: number): void {
    if (this.msaa && this.msaa.width === w && this.msaa.height === h) return;
    this.msaa?.destroy();
    this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  private writeFrame(f: FrameParams): CullFrame {
    const toWorld = translation(f.eye);
    const viewProj = multiply(f.viewProj, toWorld);
    const lightViewProj = multiply(this.light, toWorld);
    const buf = new ArrayBuffer(176);
    const u = new Float32Array(buf);
    u.set(viewProj, 0);
    u.set(lightViewProj, 16);
    u.set(f.eye, 32);
    u[35] = f.fogDist;
    u.set(SUN, 36);
    u[39] = f.groundY;
    new Uint32Array(buf)[40] = this.culler?.capacity ?? 0;
    this.device.queue.writeBuffer(this.frameBuf, 0, buf);
    return { viewProj, lightViewProj, eye: f.eye, alpha: f.alpha ?? 1, noCull: f.noCull ?? false };
  }

  /** Cull, shadow, then main pass (or the ID pass, which skips ground and shadow). */
  private encodeScene(enc: GPUCommandEncoder, f: FrameParams, view: GPUTextureView, resolve: GPUTextureView | null, ids: boolean): void {
    const culler = this.sync();
    const cf = this.writeFrame(f);
    const cp = enc.beginComputePass({ label: 'cull' });
    culler.encode(cp, cf);
    cp.end();
    if (!ids) {
      const sp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      sp.setBindGroup(0, this.shadowBind!);
      sp.setPipeline(this.pipes.boxShadow);
      sp.drawIndirect(culler.args, 16 * SEG.boxShadow);
      sp.setPipeline(this.pipes.sphereShadow);
      sp.drawIndirect(culler.args, 16 * SEG.sphereShadow);
      sp.end();
    }
    const depth = ids ? this.idDepth!.createView() : this.depth!.createView();
    const sky = { r: 0.80 ** (1 / 2.2), g: 0.86 ** (1 / 2.2), b: 0.94 ** (1 / 2.2), a: 1 };
    const p = enc.beginRenderPass({
      colorAttachments: [{ view, ...(resolve ? { resolveTarget: resolve } : {}), clearValue: ids ? { r: 0, g: 0, b: 0, a: 0 } : sky, loadOp: 'clear', storeOp: resolve ? 'discard' : 'store' }],
      depthStencilAttachment: { view: depth, depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p.setBindGroup(0, this.bind!);
    if (!ids) {
      p.setPipeline(this.pipes.ground);
      p.draw(6);
    }
    p.setPipeline(ids ? this.pipes.boxId : this.pipes.box);
    p.drawIndirect(culler.args, 16 * SEG.box);
    p.setPipeline(ids ? this.pipes.sphereId : this.pipes.sphere);
    p.drawIndirect(culler.args, 16 * SEG.sphere);
    p.end();
  }

  /**
   * Draw one frame. With capture, also read the frame back and return simple
   * pixel statistics (tests use this to prove something was drawn).
   */
  async render(f: FrameParams, capture = false, keepPixels = false): Promise<PixelStats | null> {
    const tex = this.offscreen ?? this.context!.getCurrentTexture();
    this.targets(tex.width, tex.height);
    const enc = this.device.createCommandEncoder();
    this.encodeScene(enc, f, this.msaa!.createView(), tex.createView(), false);
    let read: GPUBuffer | null = null;
    const bytesPerRow = Math.ceil((tex.width * 4) / 256) * 256;
    if (capture) {
      read = this.device.createBuffer({ size: bytesPerRow * tex.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
      enc.copyTextureToBuffer({ texture: tex }, { buffer: read, bytesPerRow }, [tex.width, tex.height]);
    }
    this.device.queue.submit([enc.finish()]);
    if (!read) return null;
    await read.mapAsync(GPUMapMode.READ);
    const raw = new Uint8Array(read.getMappedRange());
    const stats = pixelStats(raw, tex.width, tex.height, bytesPerRow);
    if (keepPixels) stats.pixels = { data: Array.from(raw), bytesPerRow, bgra: this.format.startsWith('bgra') };
    read.destroy();
    return stats;
  }

  private idTex: GPUTexture | null = null;
  private idDepth: GPUTexture | null = null;

  /** Test path: body slot + 1 per pixel (0 = nothing), row-major, size of the target. */
  async renderIds(f: FrameParams): Promise<{ width: number; height: number; ids: Uint32Array }> {
    const [w, h] = this.offscreen ? [this.offscreen.width, this.offscreen.height] : [this.context!.canvas.width, this.context!.canvas.height];
    if (!this.idTex || this.idTex.width !== w || this.idTex.height !== h) {
      this.idTex?.destroy();
      this.idDepth?.destroy();
      this.idTex = this.device.createTexture({ size: [w, h], format: 'r32uint', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.idDepth = this.device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const enc = this.device.createCommandEncoder();
    this.encodeScene(enc, f, this.idTex.createView(), null, true);
    const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
    const read = this.device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    enc.copyTextureToBuffer({ texture: this.idTex }, { buffer: read, bytesPerRow }, [w, h]);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const raw = new Uint32Array(read.getMappedRange());
    const ids = new Uint32Array(w * h);
    for (let y = 0; y < h; y++) ids.set(raw.subarray((y * bytesPerRow) / 4, (y * bytesPerRow) / 4 + w), y * w);
    read.destroy();
    return { width: w, height: h, ids };
  }

  /** Test path: the cull outputs of the last frame. */
  get cullBuffers(): Culler | null {
    return this.culler;
  }

  destroy(): void {
    this.culler?.destroy();
    for (const t of [this.msaa, this.depth, this.idTex, this.idDepth, this.shadowTex, this.offscreen]) t?.destroy();
    this.frameBuf.destroy();
  }
}

export interface PixelStats {
  width: number;
  height: number;
  distinctColors: number;
  meanLuma: number;
  nonSkyFraction: number;
  /** Raw rows when asked for (test screenshots). */
  pixels?: { data: number[]; bytesPerRow: number; bgra: boolean };
}

/** Coarse statistics of an RGBA/BGRA frame: enough to tell "drew a scene" from "blank". */
export function pixelStats(px: Uint8Array, w: number, h: number, stride: number): PixelStats {
  const colors = new Set<number>();
  let luma = 0, nonSky = 0, n = 0;
  const sky = [Math.round(255 * 0.80 ** (1 / 2.2)), Math.round(255 * 0.86 ** (1 / 2.2)), Math.round(255 * 0.94 ** (1 / 2.2))];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = y * stride + 4 * x;
    const a = px[o]!, b = px[o + 1]!, c = px[o + 2]!;
    colors.add(((a >> 3) << 10) | ((b >> 3) << 5) | (c >> 3));
    luma += (a + b + c) / 3;
    // Channel order differs (bgra vs rgba); compare as a sorted triple.
    const s = [a, b, c].sort((p, q) => p - q), k = [...sky].sort((p, q) => p - q);
    if (Math.abs(s[0]! - k[0]!) + Math.abs(s[1]! - k[1]!) + Math.abs(s[2]! - k[2]!) > 24) nonSky++;
    n++;
  }
  return { width: w, height: h, distinctColors: colors.size, meanLuma: luma / n, nonSkyFraction: nonSky / n };
}

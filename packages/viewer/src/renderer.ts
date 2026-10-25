// WebGPU renderer for boxes and spheres: instanced draws with geometry built
// from vertex_index (no vertex buffers), a sun shadow map with 3x3 PCF,
// hemisphere ambient, bevel-style edge darkening, contact darkening near the
// ground, and distance fog. 4x MSAA.
import { RenderInstance, wgslStruct } from '@tb/schema';
import type { Packed } from './instances.ts';
import { lookAt, multiply, normalize, type Mat4, type V3 } from './math.ts';

const SHADOW_SIZE = 2048;
const SAMPLES = 4;
const SPHERE_SEG = 24;
const SPHERE_RINGS = 14;
const SPHERE_VERTS = SPHERE_SEG * SPHERE_RINGS * 6;
// From the camera's right, slightly behind the scene: one lit face, one in
// shade, and shadows falling toward the viewer.
export const SUN: V3 = normalize([0.55, 0.75, -0.3]);

const SHADER = /* wgsl */ `
${wgslStruct(RenderInstance)}

struct Frame {
  viewProj: mat4x4f,
  lightViewProj: mat4x4f,
  eye: vec3f,
  fogDist: f32,
  sun: vec3f,
  groundY: f32,
}
@group(0) @binding(0) var<uniform> fr: Frame;
@group(0) @binding(1) var<storage, read> inst: array<RenderInstance>;
@group(0) @binding(2) var shadowMap: texture_depth_2d;
@group(0) @binding(3) var shadowSampler: sampler_comparison;

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
  let d = array<vec2u, 6>(vec2u(0, 0), vec2u(0, 1), vec2u(1, 1), vec2u(0, 0), vec2u(1, 1), vec2u(1, 0))[vi % 6u];
  let i = q % ${SPHERE_SEG}u + d.x;
  let j = q / ${SPHERE_SEG}u + d.y;
  let theta = f32(j) / ${SPHERE_RINGS}.0 * PI;
  let phi = f32(i) / ${SPHERE_SEG}.0 * 2.0 * PI;
  return vec3f(sin(theta) * cos(phi), cos(theta), sin(theta) * sin(phi));
}

struct VOut {
  @builtin(position) clip: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) local: vec3f,
  @location(3) @interpolate(flat) palette: u32,
  @location(4) @interpolate(flat) id: u32,
  @location(5) @interpolate(flat) shape: u32,
}

fn place(ii: u32, corner: vec3f, normal: vec3f) -> VOut {
  let b = inst[ii];
  let localPos = corner * b.half;
  let world = b.pos + qrot(b.rot, localPos);
  var o: VOut;
  o.clip = fr.viewProj * vec4f(world, 1.0);
  o.world = world;
  o.normal = qrot(b.rot, normal);
  o.local = corner;
  o.palette = b.palette;
  o.id = ii;
  o.shape = b.shape;
  return o;
}

@vertex fn vsBox(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let c = cubeCorner(vi);
  return place(ii, c[0], c[1]);
}

@vertex fn vsSphere(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> VOut {
  let p = sphereCorner(vi);
  return place(ii, p, p);
}

@vertex fn vsBoxShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let b = inst[ii];
  return fr.lightViewProj * vec4f(b.pos + qrot(b.rot, cubeCorner(vi)[0] * b.half), 1.0);
}

@vertex fn vsSphereShadow(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> @builtin(position) vec4f {
  let b = inst[ii];
  return fr.lightViewProj * vec4f(b.pos + qrot(b.rot, sphereCorner(vi) * b.half), 1.0);
}

fn shadow(world: vec3f, n: vec3f) -> f32 {
  let lc = fr.lightViewProj * vec4f(world + n * 0.04, 1.0);
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

fn shade(base: vec3f, world: vec3f, n: vec3f) -> vec3f {
  let sun = max(dot(n, fr.sun), 0.0) * shadow(world, n);
  let hemi = mix(vec3f(0.42, 0.38, 0.34), SKY, n.y * 0.5 + 0.5);
  let contact = 0.6 + 0.4 * smoothstep(0.0, 1.5, world.y - fr.groundY);
  var c = base * (hemi * 0.55 * contact + vec3f(1.0, 0.96, 0.88) * sun * 0.85);
  let fog = 1.0 - exp(-pow(distance(world, fr.eye) / fr.fogDist, 2.0));
  return mix(c, SKY, fog);
}

fn tonemap(c: vec3f) -> vec4f {
  return vec4f(pow(clamp(c, vec3f(0.0), vec3f(1.0)), vec3f(1.0 / 2.2)), 1.0);
}

@fragment fn fsBody(v: VOut) -> @location(0) vec4f {
  let n = normalize(v.normal);
  var base = PALETTE[v.palette] * (0.88 + 0.24 * hash(v.id));
  if (v.shape == 0u) {
    // Darken toward cube edges: the second-largest |local| component reaches
    // 1 only on an edge.
    let a = abs(v.local);
    let second = max(min(a.x, a.y), min(max(a.x, a.y), a.z));
    base *= 1.0 - 0.28 * smoothstep(0.88, 0.985, second);
  }
  return tonemap(shade(base, v.world, n));
}

struct GOut { @builtin(position) clip: vec4f, @location(0) world: vec3f }

@vertex fn vsGround(@builtin(vertex_index) vi: u32) -> GOut {
  let uv = array<vec2f, 6>(vec2f(-1, -1), vec2f(1, 1), vec2f(1, -1), vec2f(-1, -1), vec2f(-1, 1), vec2f(1, 1))[vi];
  let world = vec3f(fr.eye.x + uv.x * 600.0, fr.groundY, fr.eye.z + uv.y * 600.0);
  var o: GOut;
  o.clip = fr.viewProj * vec4f(world, 1.0);
  o.world = world;
  return o;
}

@fragment fn fsGround(g: GOut) -> @location(0) vec4f {
  // 1 m grid with screen-space antialiased lines.
  let p = g.world.xz;
  let w = fwidth(p);
  let line = abs(fract(p - 0.5) - 0.5) / max(w, vec2f(1e-4));
  let grid = 1.0 - min(min(line.x, line.y), 1.0);
  let base = mix(vec3f(0.86, 0.85, 0.82), vec3f(0.74, 0.73, 0.70), grid * 0.6);
  return tonemap(shade(base, g.world, vec3f(0.0, 1.0, 0.0)));
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

/** Sun view-projection covering a sphere around the scene. */
export function lightMatrix(center: V3, radius: number, sun: V3 = SUN): Mat4 {
  const r = Math.max(radius, 4);
  const eye: V3 = [center[0] + sun[0] * 2 * r, center[1] + sun[1] * 2 * r, center[2] + sun[2] * 2 * r];
  return multiply(ortho(-r, r, -r, r, 0.1, 4 * r), lookAt(eye, center, Math.abs(sun[1]) > 0.99 ? [0, 0, 1] : [0, 1, 0]));
}

export interface FrameParams { viewProj: Mat4; eye: V3; groundY: number; fogDist: number }

export class Renderer {
  readonly format: GPUTextureFormat;
  private readonly frameBuf: GPUBuffer;
  private instBuf: GPUBuffer;
  private bind!: GPUBindGroup;
  private readonly layout: GPUBindGroupLayout;
  private readonly pipes: Record<'box' | 'sphere' | 'ground' | 'boxShadow' | 'sphereShadow', GPURenderPipeline>;
  private readonly shadowTex: GPUTexture;
  private readonly shadowSampler: GPUSampler;
  private msaa: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private counts = { boxes: 0, spheres: 0 };
  private light: Mat4 = lightMatrix([0, 0, 0], 50);

  private readonly offscreen: GPUTexture | null;

  private constructor(readonly device: GPUDevice, private readonly context: GPUCanvasContext, readonly adapterInfo: GPUAdapterInfo, offscreen: [number, number] | null) {
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.offscreen = offscreen ? device.createTexture({ size: offscreen, format: this.format, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC }) : null;
    context.configure({ device, format: this.format, alphaMode: 'opaque', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
    this.frameBuf = device.createBuffer({ size: 160, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    this.instBuf = device.createBuffer({ size: RenderInstance.size * 1024, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    this.shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING });
    this.shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.layout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
      ],
    });
    // The shadow pass cannot bind the shadow map it writes, so it gets a
    // layout without bindings 2 and 3.
    const shadowLayout = device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });
    this.shadowLayout = shadowLayout;
    const module = device.createShaderModule({ code: SHADER, label: 'viewer' });
    const main = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const shadowPl = device.createPipelineLayout({ bindGroupLayouts: [shadowLayout] });
    const color = (vs: string, fs: string, cull: GPUCullMode): GPURenderPipeline => device.createRenderPipeline({
      layout: main,
      vertex: { module, entryPoint: vs },
      fragment: { module, entryPoint: fs, targets: [{ format: this.format }] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: SAMPLES },
    });
    const depthOnly = (vs: string): GPURenderPipeline => device.createRenderPipeline({
      layout: shadowPl,
      vertex: { module, entryPoint: vs },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 2 },
    });
    this.pipes = {
      box: color('vsBox', 'fsBody', 'back'),
      sphere: color('vsSphere', 'fsBody', 'back'),
      ground: color('vsGround', 'fsGround', 'none'),
      boxShadow: depthOnly('vsBoxShadow'),
      sphereShadow: depthOnly('vsSphereShadow'),
    };
    this.rebind();
  }

  private readonly shadowLayout: GPUBindGroupLayout;
  private shadowBind!: GPUBindGroup;

  /**
   * @param offscreen render into a texture of this size instead of the
   *   canvas. Headless Chromium on SwiftShader loses the device when a WebGPU
   *   canvas presents, so tests render offscreen; real browsers use the canvas.
   */
  static async create(canvas: HTMLCanvasElement, offscreen: [number, number] | null = null): Promise<Renderer> {
    if (!('gpu' in navigator)) throw new Error('WebGPU is not available in this browser');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('no WebGPU adapter');
    const device = await adapter.requestDevice();
    const context = canvas.getContext('webgpu');
    if (!context) throw new Error('could not get a webgpu canvas context');
    return new Renderer(device, context, adapter.info, offscreen);
  }

  private rebind(): void {
    this.bind = this.device.createBindGroup({
      layout: this.layout,
      entries: [
        { binding: 0, resource: { buffer: this.frameBuf } },
        { binding: 1, resource: { buffer: this.instBuf } },
        { binding: 2, resource: this.shadowTex.createView() },
        { binding: 3, resource: this.shadowSampler },
      ],
    });
    this.shadowBind = this.device.createBindGroup({
      layout: this.shadowLayout,
      entries: [{ binding: 0, resource: { buffer: this.frameBuf } }, { binding: 1, resource: { buffer: this.instBuf } }],
    });
  }

  /** Fit the shadow map to the scene; call when the scene changes. */
  setShadowBounds(center: V3, radius: number): void {
    this.light = lightMatrix(center, radius);
  }

  upload(p: Packed): void {
    const bytes = (p.boxes + p.spheres) * RenderInstance.size;
    if (bytes > this.instBuf.size) {
      this.instBuf.destroy();
      this.instBuf = this.device.createBuffer({ size: Math.ceil((bytes * 1.5) / 256) * 256, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
      this.rebind();
    }
    if (bytes) this.device.queue.writeBuffer(this.instBuf, 0, p.data, 0, bytes);
    this.counts = { boxes: p.boxes, spheres: p.spheres };
  }

  private targets(w: number, h: number): void {
    if (this.msaa && this.msaa.width === w && this.msaa.height === h) return;
    this.msaa?.destroy();
    this.depth?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], format: this.format, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT });
  }

  /**
   * Draw one frame. With capture, also read the frame back and return simple
   * pixel statistics (tests use this to prove something was drawn).
   */
  async render(f: FrameParams, capture = false, keepPixels = false): Promise<PixelStats | null> {
    const tex = this.offscreen ?? this.context.getCurrentTexture();
    this.targets(tex.width, tex.height);
    const u = new Float32Array(40);
    u.set(f.viewProj, 0);
    u.set(this.light, 16);
    u.set(f.eye, 32);
    u[35] = f.fogDist;
    u.set(SUN, 36);
    u[39] = f.groundY;
    this.device.queue.writeBuffer(this.frameBuf, 0, u);
    const enc = this.device.createCommandEncoder();
    const { boxes, spheres } = this.counts;

    const sp = enc.beginRenderPass({ colorAttachments: [], depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
    sp.setBindGroup(0, this.shadowBind);
    if (boxes) { sp.setPipeline(this.pipes.boxShadow); sp.draw(36, boxes, 0, 0); }
    if (spheres) { sp.setPipeline(this.pipes.sphereShadow); sp.draw(SPHERE_VERTS, spheres, 0, boxes); }
    sp.end();

    const p = enc.beginRenderPass({
      colorAttachments: [{ view: this.msaa!.createView(), resolveTarget: tex.createView(), clearValue: { r: 0.80 ** (1 / 2.2), g: 0.86 ** (1 / 2.2), b: 0.94 ** (1 / 2.2), a: 1 }, loadOp: 'clear', storeOp: 'discard' }],
      depthStencilAttachment: { view: this.depth!.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p.setBindGroup(0, this.bind);
    p.setPipeline(this.pipes.ground);
    p.draw(6);
    if (boxes) { p.setPipeline(this.pipes.box); p.draw(36, boxes, 0, 0); }
    if (spheres) { p.setPipeline(this.pipes.sphere); p.draw(SPHERE_VERTS, spheres, 0, boxes); }
    p.end();

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

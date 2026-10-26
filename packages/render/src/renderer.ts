// WebGPU renderer for boxes and spheres, drawn from a BodySource with GPU
// culling and indirect draws (cull.ts). Frame: cull (compute), sun shadow
// map, the scene into a 4x MSAA HDR target resolved to one sample (bodies,
// floor, sky; shaders.ts), then bloom and the AgX composite (post.ts).
// Geometry is built from vertex_index (no vertex buffers); positions are
// camera-relative. Colours and lights come from a LookParams preset.
import { writeStruct } from '@tb/schema';
import type { GpuProfiler } from '@tb/gpu';
import { Culler, NO_LOD, SEG, type CullFrame } from './cull.ts';
import { Sparks } from './sparks.ts';
import { Lights, MAX_BALLS, TRAIL } from './lights.ts';
import { aoFrame, aoGrid, AoVolume } from './ao.ts';
import { FLOOR_VERTS, floorFan, floorPolygon } from './floor.ts';
import { fitShadow, frustumCorners, type Arena, type ShadowFit, type ShadowFitState } from './shadowfit.ts';
import { FX_WORDS, packFx, tintWord, toHalf, type FxOptions, FX_ANCHOR } from './fx.ts';
import { CANDY_NIGHT, linearToOklab, srgbToLinear, type LookParams } from './look.ts';
import { invert, lookAt, multiply, normalize, type Mat4, type V3 } from './math.ts';
import { HDR_FORMAT, noStamp, Post, type Stamp } from './post.ts';
import { BOX_CUBE_VERTS, BOX_FAN_VERTS, Frame, SCENE_WGSL, sceneWgsl, SHADOW_SIZE, SPHERE_VERTS } from './shaders.ts';
import { Materials, STONES } from './materials.ts';
import { ADAPTED_EXPOSURE_OFFSET, Atmosphere, medium, sunAtGround, sunDiscRadiance } from './atmosphere.ts';
import { SnapshotSource, type BodySource } from './source.ts';

export { BOX_CUBE_VERTS, BOX_FAN_VERTS, BOX_VERTS, SPHERE_VERTS } from './shaders.ts';

const SAMPLES = 4;
// From the camera's right, slightly behind the scene: one lit face, one in
// shade, and shadows falling toward the viewer.
/** Most overlay spheres setOverlay draws. */
export const MAX_OVERLAY = 1024;
/** Overlay colour when none is given: white, slightly glowing. */
const OVERLAY_DEFAULT = 0x40ffffff;

export const SUN: V3 = normalize([0.55, 0.75, -0.3]);

export function translation(t: V3): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2];
  return m;
}

export interface FrameParams {
  /** World-space view-projection; made camera-relative internally. */
  viewProj: Mat4;
  eye: V3;
  /** What the camera looks at (orbit target); places the horizon glow. */
  focus?: V3;
  groundY: number;
  /** Seconds, for animated effects. */
  time?: number;
  /** Interpolation between the previous step (0) and the latest (1). */
  alpha?: number;
  /** Draw every body regardless of frusta (tests compare against this). */
  noCull?: boolean;
  /** Seconds since the last scene frame, for sparks (default: from time, at most 0.1). */
  dt?: number;
}

export type RenderTarget = { canvas: HTMLCanvasElement } | { size: [number, number] };

/**
 * How boxes are drawn: the 18-vertex hexagon fan (the three faces towards
 * the viewer, or the light) or the 36-vertex cube (all six, faces turned
 * away culled by the rasterizer). Same pixels and depths either way (tests).
 */
export type BoxPath = 'fan' | 'cube';


export interface RendererOptions {
  /**
   * Box path for the scene pass. Default 'cube': on the M5 Max the scene
   * pass took 0.90 vs 1.19 ms (near) and 0.98 vs 1.43 ms (far) at 100k
   * with the cube, though the fan runs half the vertices.
   */
  scenePath?: BoxPath;
  /** Box path for the shadow pass. Default 'fan'. */
  shadowPath?: BoxPath;
  /** Shorthand: both paths. */
  boxPath?: BoxPath;
  /** Bench diagnostics: boxes shaded with their flat albedo only, which separates fragment cost from the rest. */
  flatBoxes?: boolean;
  /**
   * Bench diagnostics for AO's cost: 'no-seam' compiles the seam cavity out.
   */
  aoDiag?: 'no-seam';
  /**
   * Bench diagnostics for the real look's block shading: 'stone-off'
   * compiles the stone samples out (against stone texture 0, the cost of
   * the samples' code being there at all); 'step1' shades blocks as realism
   * step 1 did (the stylized body under the atmosphere); 'no-floor-sky'
   * gives the floor the vertical sky term only (no floorSky cones).
   */
  realDiag?: 'stone-off' | 'step1' | 'no-floor-sky';
  /** false: no material level of detail, every box drawn with the stone code (bench and tests). Default true. */
  stoneLod?: boolean;
  /** Spark slots (default SPARK_POOL, 65536). Every slot costs a simulation thread and a quad per frame. */
  sparkPool?: number;
  /** Output format; default the canvas's preferred one (bgra8unorm on Apple, rgba8unorm elsewhere). Tests set it to cover both. */
  format?: GPUTextureFormat;
}

type PipeName = 'box' | 'sphere' | 'ground' | 'sky' | 'overlay' | 'spark' | 'trail' | 'boxShadow' | 'sphereShadow' | 'boxId' | 'sphereId';
/** The pipelines whose shading differs for a look with an atmosphere (sceneWgsl(true)). */
type RealPipe = 'box' | 'boxFar' | 'sphere' | 'ground' | 'sky' | 'overlay';

/**
 * The depth past the near plane beyond which every pixel of a surface
 * covers at least fade metres (as fsBox measures it: the length of fwidth
 * of the body-frame position), so the stone has faded out there and boxes
 * all of whose bounding sphere lies beyond can use the shader without it.
 * viewProj: camera-relative; height: viewport pixels. A pixel step at view
 * depth z spans at least z cos(theta) 2 / (P11 height) metres on any
 * surface, theta the pixel's angle off the view axis (at most the frustum
 * corner's), and fwidth's length is at least sqrt(2) times one step. The
 * near plane is closer than view depth, which only adds margin; so does
 * the 10% on top.
 */
export function stoneLodDepth(viewProj: Float32Array, height: number, fade: number): number {
  const p00 = Math.hypot(viewProj[0]!, viewProj[4]!, viewProj[8]!), p11 = Math.hypot(viewProj[1]!, viewProj[5]!, viewProj[9]!);
  const cosCorner = 1 / Math.sqrt(1 + 1 / (p00 * p00) + 1 / (p11 * p11));
  return (1.1 * fade * p11 * height) / (2 * Math.SQRT2 * cosCorner);
}

/** Direction toward the sun of a look. */
export function sunOf(l: LookParams): V3 {
  return l.sunDir ? normalize(l.sunDir) : SUN;
}

/** Frame uniform values that come from a look preset (colours to OKLab / linear as the shader wants). */
export function lookUniforms(l: LookParams): Record<string, number | number[]> {
  const lin = (c: V3) => c.map(srgbToLinear);
  // With an atmosphere, the sun's colour is the sunlight that reaches the ground (atmosphere.ts).
  const sunColor = l.atmosphere ? sunAtGround(l.atmosphere, sunOf(l)) : l.sunColor;
  return {
    skyZenith: l.skyZenith, skyHorizon: l.skyHorizon, glow: l.glow, floor: l.floor, floorGrid: l.floorGrid,
    sunColor, ambSky: l.ambSky, ambGround: l.ambGround,
    keyColor: l.keyColor, keyDir: normalize(l.keyDir), keySize: l.keySize,
    rimColor: l.rimColor, rimDir: normalize(l.rimDir), rimSize: l.rimSize,
    roughness: l.roughness, clearcoat: l.clearcoat, bevel: l.bevel, hueStep: (l.hueStep * Math.PI) / 180,
    ball: lin(l.ball), ballEmissive: l.ballEmissive, fogDensity: l.fogDensity, fogHeight: l.fogHeight, exposure: l.exposure,
    stone: l.stone ? [STONES.indexOf(l.stone.kind), l.stone.scale, l.stone.wear, l.stone.dirt] : [0, 1, 0, 0],
    stoneDetail: [l.stone?.detail ?? 0, l.stone?.fade ?? 1, 0, 0],
    blockAlbedo: [...[0, 1, 2].map((k) => l.ramp.reduce((acc, c) => acc + srgbToLinear(c[k]!), 0) / l.ramp.length), 0],
    ...Object.fromEntries(l.ramp.map((c, i) => [`ramp${i}`, [...linearToOklab(lin(c) as V3), 0]])),
  };
}

export class Renderer {
  readonly format: GPUTextureFormat;
  look: LookParams = CANDY_NIGHT;
  private readonly frameBuf: GPUBuffer;
  private readonly frameData = new DataView(new ArrayBuffer(Frame.size));
  private readonly layout: GPUBindGroupLayout;
  private readonly shadowLayout: GPUBindGroupLayout;
  private readonly pipes: Record<PipeName, GPURenderPipeline>;
  /** Pipelines and sky of looks with an atmosphere, made on first use. */
  private real: { pipes: Record<RealPipe, GPURenderPipeline>; atmosphere: Atmosphere; materials: Materials; layout: GPUBindGroupLayout; bind: GPUBindGroup } | null = null;
  private readonly makeReal: () => NonNullable<Renderer['real']>;
  private lastSun: V3 = SUN;
  private readonly facePipe: () => GPURenderPipeline;
  private faceCache: GPURenderPipeline | null = null;
  private readonly shadowTex: GPUTexture;
  private readonly shadowSampler: GPUSampler;
  private readonly context: GPUCanvasContext | null;
  private readonly offscreen: GPUTexture | null;
  private readonly post: Post;
  private msaa: GPUTexture | null = null;
  private hdr: GPUTexture | null = null;
  private depth: GPUTexture | null = null;
  private idTex: GPUTexture | null = null;
  private idDepth: GPUTexture | null = null;
  private arena: Arena = { center: [0, 0, 0], half: [50, 50, 50], radius: 50 };
  /** The floor height the AO grid was fitted to (the last frame's groundY). */
  private aoFloor = -Infinity;
  private readonly shadowState: ShadowFitState = { level: -1 };
  /** The shadow window of the last frame (tests, debug overlays). */
  shadowFit: ShadowFit | null = null;
  private source: BodySource;
  private culler: Culler | null = null;
  private cullKey = '';
  private bind: GPUBindGroup | null = null;
  private shadowBind: GPUBindGroup | null = null;
  /** Per-slot FX records: CPU mirror (grows with the source) and its GPU copy. */
  private fx = new Uint32Array(1024 * FX_WORDS);
  private fxBuf: GPUBuffer | null = null;
  private readonly overlayBuf: GPUBuffer;
  private readonly overlayColours: GPUBuffer;
  private overlayCount = 0;
  private readonly floorBuf: GPUBuffer;
  private readonly floorData = new Float32Array(FLOOR_VERTS * 3);
  private floorCount = 0;
  private lastTime = 0;
  private sceneTime: number | null = null;
  /** Sparks from impacts: detector, pool and tunables (sparks.ts). */
  readonly sparks: Sparks;
  /** Ball and flash lights and the ball trail (lights.ts). */
  readonly lights: Lights;
  /** Occupancy volume for AO (ao.ts), fitted to the arena (setShadowBounds). */
  readonly ao: AoVolume;
  private readonly aoSampler: GPUSampler;

  private readonly boxVerts: { scene: number; shadow: number };
  /** Per-pass GPU timing of render() (cull, shadow, scene, bloom, composite) when set; read with profiler.collect(). */
  profiler: GpuProfiler | null = null;
  /** Passes to skip, for measuring their marginal cost (bench:render). sparks off also freezes heat (its detector writes it). */
  toggles = { shadow: true, post: true, sparks: true, trail: true, heat: true, ao: true };
  private readonly stoneLod: boolean;

  constructor(readonly device: GPUDevice, target: RenderTarget, opts: RendererOptions = {}) {
    this.stoneLod = opts.stoneLod !== false;
    const sceneFan = (opts.scenePath ?? opts.boxPath ?? 'cube') === 'fan';
    const shadowFan = (opts.shadowPath ?? opts.boxPath ?? 'fan') === 'fan';
    this.boxVerts = { scene: sceneFan ? BOX_FAN_VERTS : BOX_CUBE_VERTS, shadow: shadowFan ? BOX_FAN_VERTS : BOX_CUBE_VERTS };
    this.format = opts.format ?? navigator.gpu.getPreferredCanvasFormat();
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
    this.frameBuf = device.createBuffer({ size: Frame.size, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'frame' });
    this.shadowTex = device.createTexture({ size: [SHADOW_SIZE, SHADOW_SIZE], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
    this.shadowSampler = device.createSampler({ compare: 'less', magFilter: 'linear', minFilter: 'linear' });
    this.post = new Post(device, this.format);
    this.sparks = new Sparks(device, opts.sparkPool);
    this.lights = new Lights(device);
    this.ao = new AoVolume(device, aoGrid(this.arena));
    this.aoSampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
    const VF = GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT;
    const ro = { type: 'read-only-storage' } as const;
    const common: GPUBindGroupLayoutEntry[] = [
      { binding: 0, visibility: VF, buffer: { type: 'uniform' } },
      { binding: 1, visibility: VF, buffer: ro },
      { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: ro },
    ];
    this.floorBuf = device.createBuffer({ size: this.floorData.byteLength, usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST, label: 'floor polygon' });
    this.overlayBuf = device.createBuffer({ size: MAX_OVERLAY * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'overlay spheres' });
    this.overlayColours = device.createBuffer({ size: MAX_OVERLAY * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'overlay colours' });
    this.layout = device.createBindGroupLayout({
      entries: [
        ...common,
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'depth' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'comparison' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, buffer: ro },
        { binding: 6, visibility: GPUShaderStage.VERTEX, buffer: ro },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, buffer: ro },
        { binding: 8, visibility: GPUShaderStage.VERTEX, buffer: ro },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 10, visibility: GPUShaderStage.VERTEX, buffer: ro },
        { binding: 11, visibility: GPUShaderStage.FRAGMENT, buffer: ro },
        { binding: 12, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 13, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 14, visibility: GPUShaderStage.FRAGMENT, buffer: ro },
      ],
    });
    // The shadow pass cannot bind the shadow map it writes.
    this.shadowLayout = device.createBindGroupLayout({ entries: common });
    const module = device.createShaderModule({ code: SCENE_WGSL, label: 'scene' });
    const main = device.createPipelineLayout({ bindGroupLayouts: [this.layout] });
    const shadowPl = device.createPipelineLayout({ bindGroupLayouts: [this.shadowLayout] });
    const fsConsts: Record<string, Record<string, number>> = { fsBox: { AO_SEAM: opts.aoDiag === 'no-seam' ? 0 : 1 } };
    const color = (vs: string, fs: string, cull: GPUCullMode, seg: number, opts: { format?: GPUTextureFormat; samples?: number; sky?: boolean; buffers?: GPUVertexBufferLayout[]; module?: GPUShaderModule; layout?: GPUPipelineLayout; constants?: Record<string, number> } = {}): GPURenderPipeline => device.createRenderPipeline({
      layout: opts.layout ?? main,
      vertex: { module: opts.module ?? module, entryPoint: vs, constants: { SEG: seg, ...(vs === 'vsBox' ? { FAN: sceneFan ? 1 : 0 } : {}) }, buffers: opts.buffers ?? [] },
      fragment: { module: opts.module ?? module, entryPoint: fs, constants: { ...fsConsts[fs], ...opts.constants }, targets: [{ format: opts.format ?? HDR_FORMAT }] },
      primitive: { topology: 'triangle-list', cullMode: cull, frontFace: 'ccw' },
      depthStencil: opts.sky
        ? { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' }
        : { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
      multisample: { count: opts.samples ?? SAMPLES },
    });
    const depthOnly = (vs: string, seg: number): GPURenderPipeline => device.createRenderPipeline({
      layout: shadowPl,
      vertex: { module, entryPoint: vs, constants: { SEG: seg, ...(vs === 'vsBoxShadow' ? { FAN: shadowFan ? 1 : 0 } : {}) } },
      // Casters are the light-facing faces: the fan around the corner
      // nearest the light, or the cube with faces turned away culled. Both
      // write the same nearest depth.
      primitive: { topology: 'triangle-list', cullMode: 'back', frontFace: 'ccw' },
      // No caster bias: one bias model, all on the receiver (normal offset
      // plus a constant, in shadow() in shaders.ts). Slope-scaled caster bias
      // also depends on how a face is triangulated in the rasterizer, so the
      // fan and cube paths' maps differed by up to 4 cm with it.
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
    });
    this.source = new SnapshotSource(device);
    this.facePipe = () => (this.faceCache ??= color('vsBox', 'fsFace', 'back', SEG.box, { format: 'r32uint', samples: 1 }));
    this.pipes = {
      box: color('vsBox', opts.flatBoxes ? 'fsBoxFlat' : 'fsBox', 'back', SEG.box),
      sphere: color('vsSphere', 'fsSphere', 'back', SEG.sphere),
      ground: color('vsGround', 'fsGround', 'none', 0, { buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] }),
      sky: color('vsSky', 'fsSky', 'none', 0, { sky: true }),
      overlay: color('vsOverlay', 'fsOverlay', 'back', 0),
      spark: device.createRenderPipeline({
        layout: main,
        vertex: { module, entryPoint: 'vsSpark' },
        fragment: {
          module, entryPoint: 'fsSpark',
          targets: [{ format: HDR_FORMAT, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        multisample: { count: SAMPLES },
      }),
      trail: device.createRenderPipeline({
        layout: main,
        vertex: { module, entryPoint: 'vsTrail' },
        fragment: {
          module, entryPoint: 'fsTrail',
          targets: [{ format: HDR_FORMAT, writeMask: GPUColorWrite.RED | GPUColorWrite.GREEN | GPUColorWrite.BLUE, blend: { color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }, alpha: { srcFactor: 'zero', dstFactor: 'one', operation: 'add' } } }],
        },
        primitive: { topology: 'triangle-list', cullMode: 'none' },
        depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less' },
        multisample: { count: SAMPLES },
      }),
      boxShadow: depthOnly('vsBoxShadow', SEG.boxShadow),
      sphereShadow: depthOnly('vsSphereShadow', SEG.sphereShadow),
      boxId: color('vsBox', 'fsId', 'back', SEG.box, { format: 'r32uint', samples: 1 }),
      sphereId: color('vsSphere', 'fsId', 'back', SEG.sphere, { format: 'r32uint', samples: 1 }),
    };
    this.makeReal = () => {
      const atmosphere = new Atmosphere(device);
      const layout = device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float' } },
          { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
          { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: ro },
          { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
          { binding: 5, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        ],
      });
      const materials = new Materials(device);
      const m = { module: device.createShaderModule({ code: sceneWgsl(true), label: 'scene (real)' }), layout: device.createPipelineLayout({ bindGroupLayouts: [this.layout, layout] }) };
      const pipes: Record<RealPipe, GPURenderPipeline> = {
        box: color('vsBox', opts.flatBoxes ? 'fsBoxFlat' : 'fsBox', 'back', SEG.box, { ...m, constants: opts.flatBoxes ? {} : { REAL_STONE: opts.realDiag === 'stone-off' ? 0 : 1, REAL_BLOCK: opts.realDiag === 'step1' ? 0 : 1 } }),
        // Past the stone's fade-out (stoneLodDepth): the same shading without the stone code.
        boxFar: color('vsBox', opts.flatBoxes ? 'fsBoxFlat' : 'fsBox', 'back', SEG.boxFar, { ...m, constants: opts.flatBoxes ? {} : { REAL_STONE: 0, REAL_BLOCK: opts.realDiag === 'step1' ? 0 : 1 } }),
        sphere: color('vsSphere', 'fsSphere', 'back', SEG.sphere, m),
        ground: color('vsGround', 'fsGround', 'none', 0, { ...m, constants: { FLOOR_CONES: opts.realDiag === 'no-floor-sky' ? 0 : 1 }, buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] }),
        sky: color('vsSky', 'fsSky', 'none', 0, { ...m, sky: true, constants: { FLOOR_CONES: opts.realDiag === 'no-floor-sky' ? 0 : 1 } }),
        overlay: color('vsOverlay', 'fsOverlay', 'back', 0, m),
      };
      const bind = device.createBindGroup({
        layout,
        entries: [
          { binding: 0, resource: atmosphere.skyView.createView() }, { binding: 1, resource: atmosphere.sampler }, { binding: 2, resource: { buffer: atmosphere.ambient } },
          { binding: 3, resource: materials.detail.createView({ dimension: '2d-array' }) }, { binding: 4, resource: materials.normal.createView({ dimension: '2d-array' }) },
          { binding: 5, resource: materials.sampler },
        ],
      });
      return { pipes, atmosphere, materials, layout, bind };
    };
  }

  /** Draw bodies from this source from now on. */
  setSource(source: BodySource): void {
    this.source = source;
    this.cullKey = '';
  }

  /**
   * Where shadows can fall: a sphere around center, optionally clipped by a
   * box of half extents `half`. Each frame the shadow map covers only the
   * part of it the camera sees (shadowfit.ts).
   */
  setShadowBounds(center: V3, radius: number, half: V3 = [radius, radius, radius]): void {
    this.arena = { center, half, radius };
    this.shadowState.level = -1;
    this.fitAo();
  }

  /** The AO grid for the arena, down to just under the floor (aoGrid); refitted when either changes. */
  private fitAo(): void {
    const before = this.ao.volume;
    this.ao.setGrid(aoGrid(this.arena, undefined, undefined, this.aoFloor));
    if (this.ao.volume !== before) this.cullKey = ''; // rebind the new volume
  }

  /**
   * Set visual effects on body slots (fx.ts): one slot with options, or a
   * contiguous range from bulk arrays. Tints are rgb8 (linear, r in the low
   * byte) + emissive8 in the high byte; null keeps the current tint. Scales
   * set the visual scale, anchored at the base when anchor is set. Applied
   * from the next frame; costs one small upload per call.
   */
  setFx(slot: number, fx: FxOptions): void;
  setFx(slot0: number, tints: Uint32Array | null, scales?: Float32Array, anchor?: boolean): void;
  setFx(slot: number, a: FxOptions | Uint32Array | null, scales?: Float32Array, anchor = false): void {
    const n = a === null || a instanceof Uint32Array ? Math.max(a?.length ?? 0, scales?.length ?? 0) : 1;
    this.growFx(slot + n);
    if (a === null || a instanceof Uint32Array) {
      for (let k = 0; k < n; k++) {
        const o = (slot + k) * FX_WORDS;
        if (a && k < a.length) this.fx[o] = tintWord(a[k]!);
        if (scales && k < scales.length) this.fx[o + 1] = (toHalf(1 - Math.min(1, Math.max(0, scales[k]!))) | (anchor ? FX_ANCHOR : 0)) >>> 0;
      }
    } else {
      packFx(a, this.fx, slot * FX_WORDS, this.lastTime);
    }
    this.uploadFx(slot, n);
  }

  /** Remove the effects of count slots from slot. */
  clearFx(slot: number, count = 1): void {
    this.growFx(slot + count);
    this.fx.fill(0, slot * FX_WORDS, (slot + count) * FX_WORDS);
    this.uploadFx(slot, count);
  }

  /**
   * Spheres drawn after the bodies (aim previews, markers): x, y, z, radius
   * per sphere in world space, and optionally sRGB rgb8 + emissive8 per
   * sphere (r in the low byte). At most MAX_OVERLAY; replaces the last set.
   */
  setOverlay(xyzr: Float32Array, colours?: Uint32Array): void {
    const n = Math.min(MAX_OVERLAY, Math.floor(xyzr.length / 4));
    if (n) this.device.queue.writeBuffer(this.overlayBuf, 0, xyzr, 0, 4 * n);
    const c = colours ?? new Uint32Array(n).fill(OVERLAY_DEFAULT);
    if (n) this.device.queue.writeBuffer(this.overlayColours, 0, c, 0, Math.min(n, c.length));
    this.overlayCount = Math.min(n, c.length);
  }

  private growFx(slots: number): void {
    if (slots * FX_WORDS <= this.fx.length) return;
    let len = this.fx.length;
    while (len < slots * FX_WORDS) len *= 2;
    const next = new Uint32Array(len);
    next.set(this.fx);
    this.fx = next;
  }

  private uploadFx(slot: number, count: number): void {
    const b = this.fxBuf;
    if (!b || (slot + count) * FX_WORDS * 4 > b.size) return; // sync() uploads the whole mirror when it reallocates
    this.device.queue.writeBuffer(b, slot * FX_WORDS * 4, this.fx, slot * FX_WORDS, count * FX_WORDS);
  }

  private aoUniforms(eye: V3) {
    const g = this.ao.grid, { originRel, invVoxel } = aoFrame(g, eye);
    return { aoOrigin: originRel, aoInvVoxel: invVoxel, aoDims: g.dims, aoOn: this.toggles.ao ? 1 : 0, aoK: this.ao.k };
  }

  /** Rebuild the culler and bind groups when the source's buffers change. */
  private sync(): Culler {
    const s = this.source;
    const key = `${s.version}:${s.capacity}`;
    if (key !== this.cullKey || !this.culler || this.culler.source !== s) {
      this.culler?.destroy();
      this.growFx(s.capacity);
      if (!this.fxBuf || this.fxBuf.size < s.capacity * FX_WORDS * 4) {
        this.fxBuf?.destroy();
        this.fxBuf = this.device.createBuffer({ size: Math.max(16, this.fx.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST, label: 'fx' });
        this.device.queue.writeBuffer(this.fxBuf, 0, this.fx);
      }
      this.culler = new Culler(this.device, s, { box: this.boxVerts.scene, boxShadow: this.boxVerts.shadow, sphere: SPHERE_VERTS }, this.fxBuf);
      const buffers = [this.frameBuf, this.culler.records, this.culler.lists];
      const common = buffers.map((buffer, binding) => ({ binding, resource: { buffer } }));
      this.bind = this.device.createBindGroup({
        layout: this.layout,
        entries: [
          ...common, { binding: 3, resource: this.shadowTex.createView() }, { binding: 4, resource: this.shadowSampler },
          { binding: 5, resource: { buffer: this.fxBuf } }, { binding: 6, resource: { buffer: this.overlayBuf } }, { binding: 7, resource: { buffer: this.overlayColours } },
          { binding: 8, resource: { buffer: this.sparks.sparks } },
          { binding: 9, resource: { buffer: this.lights.lights } }, { binding: 10, resource: { buffer: this.lights.trail } },
          { binding: 11, resource: { buffer: this.sparks.stateFor(s) } },
          { binding: 12, resource: this.ao.volume.createView() }, { binding: 13, resource: this.aoSampler }, { binding: 14, resource: { buffer: this.ao.feetFor(s) } },
        ],
      });
      this.shadowBind = this.device.createBindGroup({ layout: this.shadowLayout, entries: common });
      this.cullKey = key;
    }
    return this.culler;
  }

  private targets(w: number, h: number): void {
    if (this.msaa && this.msaa.width === w && this.msaa.height === h) return;
    for (const t of [this.msaa, this.hdr, this.depth]) t?.destroy();
    this.msaa = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'hdr msaa' });
    this.hdr = this.device.createTexture({ size: [w, h], format: HDR_FORMAT, usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING, label: 'hdr' });
    this.depth = this.device.createTexture({ size: [w, h], format: 'depth24plus', sampleCount: SAMPLES, usage: GPUTextureUsage.RENDER_ATTACHMENT, label: 'depth msaa' });
  }

  private writeFrame(f: FrameParams): CullFrame {
    const toWorld = translation(f.eye);
    const viewProj = multiply(f.viewProj, toWorld);
    const { center, radius = Math.hypot(...this.arena.half) } = this.arena;
    // Nothing past the far side of the arena receives a shadow.
    const reach = Math.hypot(f.eye[0] - center[0], f.eye[1] - center[1], f.eye[2] - center[2]) + radius;
    const sun = sunOf(this.look);
    if (sun.some((x, k) => x !== this.lastSun[k])) { this.shadowState.level = -1; this.lastSun = sun; } // refit from scratch for a new sun
    const fit = (this.shadowFit = fitShadow(this.arena, sun, frustumCorners(invert(f.viewProj), f.eye, reach), SHADOW_SIZE, this.shadowState, f.groundY));
    const lightViewProj = multiply(fit.matrix, toWorld);
    const focus = f.focus ?? [f.eye[0], f.eye[1], f.eye[2] - 1];
    this.lastTime = f.time ?? 0;
    const inv = invert(viewProj);
    this.floorCount = floorFan(floorPolygon(inv, f.groundY - f.eye[1]), this.floorData).count;
    if (this.floorCount) this.device.queue.writeBuffer(this.floorBuf, 0, this.floorData, 0, this.floorCount * 3);
    writeStruct(this.frameData, Frame, 0, {
      viewProj, lightViewProj, invViewProj: inv,
      eye: f.eye, time: f.time ?? 0, sun, groundY: f.groundY,
      focus: [focus[0] - f.eye[0], focus[1] - f.eye[1], focus[2] - f.eye[2]], capacity: this.culler?.capacity ?? 0,
      ...lookUniforms(this.look),
      // Bias, all on the receiver: normal offset of 2 texels, depth bias of 1 texel + 1 cm.
      shadowParams: [2 * fit.texel, (fit.texel + 0.01) / fit.depthRange, fit.texel, 0],
      ...this.aoUniforms(f.eye),
      heat: this.toggles.heat && this.look.effects !== false ? 1 : 0, viewport: this.viewport(), dt: f.dt ?? 0, trailHead: (this.lights.nextFrame + TRAIL - 1) % TRAIL,
      ...this.atmosphereUniforms(f, sun),
    });
    this.device.queue.writeBuffer(this.frameBuf, 0, this.frameData);
    return { viewProj, lightViewProj, eye: f.eye, alpha: f.alpha ?? 1, noCull: f.noCull ?? false };
  }

  /** Eye height above the floor, km, for the atmosphere (at least 1 m). */
  private eyeKm(f: FrameParams): number {
    return Math.max(f.eye[1] - f.groundY, 1) / 1000;
  }

  private atmosphereUniforms(f: FrameParams, sun: V3): Record<string, number | number[]> {
    const a = this.look.atmosphere;
    if (!a) return {};
    const h = this.eyeKm(f);
    return { atmoSigma: medium(a, h).extinction.map((x) => x / 1000), atmoEyeKm: h, sunDisc: sunDiscRadiance(a, sun, h), sunCos: Math.cos(a.sunRadius) };
  }

  /** Cull, shadow, then the scene pass (or the ID pass, which skips floor, sky and shadow). */
  private encodeScene(enc: GPUCommandEncoder, f: FrameParams, mode: 'scene' | 'ids' | 'faces', stamp: Stamp = noStamp): void {
    const ids = mode !== 'scene';
    if (f.groundY !== this.aoFloor) { this.aoFloor = f.groundY; this.fitAo(); }
    const culler = this.sync();
    let dt = 0;
    if (!ids) {
      const t = f.time ?? 0;
      dt = f.dt ?? (this.sceneTime === null ? 0 : Math.min(0.1, Math.max(0, t - this.sceneTime)));
      this.sceneTime = t;
    }
    const cf = this.writeFrame({ ...f, dt });
    const ao = !ids && this.toggles.ao;
    if (ao) this.ao.clear(enc);
    // Material level of detail: in the real look, boxes past the stone's fade-out go to boxFar, all of them with no stone.
    const stone = !ids && this.look.atmosphere ? this.look.stone : undefined;
    if (stone && this.stoneLod) cf.lodDepth = stone.detail > 0 ? stoneLodDepth(cf.viewProj, this.viewport()[1], stone.fade) : -NO_LOD;
    const cp = enc.beginComputePass({ label: 'cull', ...stamp('cull') });
    culler.encode(cp, cf);
    if (ao) {
      this.ao.splat(cp, this.source, culler.records, f.eye);
      this.ao.compose(cp);
    }
    const real = !ids && this.look.atmosphere ? (this.real ??= this.makeReal()) : null;
    if (real) real.atmosphere.encode(cp, this.look.atmosphere!, sunOf(this.look), this.eyeKm(f), this.look.exposure, this.look.autoExposure ?? 0);
    const effects = this.look.effects !== false;
    if (!ids && effects) {
      if (this.toggles.sparks) this.sparks.encode(cp, this.source, { dt, groundY: f.groundY });
      this.lights.encode(cp, this.source, culler.records, this.sparks, { eye: f.eye, time: f.time ?? 0, ball: this.look.ball.map(srgbToLinear) as V3 });
    } else if (!ids) this.lights.off();
    cp.end();
    if (!ids && this.toggles.shadow) {
      const sp = enc.beginRenderPass({ label: 'shadow', ...stamp('shadow'), colorAttachments: [], depthStencilAttachment: { view: this.shadowTex.createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'store' } });
      sp.setBindGroup(0, this.shadowBind!);
      sp.setPipeline(this.pipes.boxShadow);
      sp.drawIndirect(culler.args, 16 * SEG.boxShadow);
      sp.setPipeline(this.pipes.sphereShadow);
      sp.drawIndirect(culler.args, 16 * SEG.sphereShadow);
      sp.end();
    }
    const color: GPURenderPassColorAttachment = ids
      ? { view: this.idTex!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 0 }, loadOp: 'clear', storeOp: 'store' }
      // Tile memory only: the MSAA samples are resolved and never stored.
      : { view: this.msaa!.createView(), resolveTarget: this.hdr!.createView(), clearValue: { r: 0, g: 0, b: 0, a: 1 }, loadOp: 'clear', storeOp: 'discard' };
    const p = enc.beginRenderPass({
      label: mode,
      ...(ids ? {} : stamp('scene')),
      colorAttachments: [color],
      depthStencilAttachment: { view: (ids ? this.idDepth! : this.depth!).createView(), depthClearValue: 1, depthLoadOp: 'clear', depthStoreOp: 'discard' },
    });
    p.setBindGroup(0, this.bind!);
    if (real) p.setBindGroup(1, real.bind);
    const pipes = real ? { ...this.pipes, ...real.pipes } : this.pipes;
    p.setPipeline(mode === 'faces' ? this.facePipe() : ids ? pipes.boxId : pipes.box);
    p.drawIndirect(culler.args, 16 * SEG.box);
    if (real) {
      p.setPipeline(real.pipes.boxFar);
      p.drawIndirect(culler.args, 16 * SEG.boxFar);
    }
    if (mode === 'faces') { p.end(); return; }
    p.setPipeline(ids ? pipes.sphereId : pipes.sphere);
    p.drawIndirect(culler.args, 16 * SEG.sphere);
    if (!ids) {
      if (this.overlayCount) {
        p.setPipeline(pipes.overlay);
        p.draw(SPHERE_VERTS, this.overlayCount);
      }
      if (this.floorCount) {
        p.setPipeline(pipes.ground);
        p.setVertexBuffer(0, this.floorBuf);
        p.draw(this.floorCount);
      }
      p.setPipeline(pipes.sky);
      p.draw(3);
      if (this.toggles.sparks && effects) {
        p.setPipeline(this.pipes.spark);
        p.drawIndirect(this.sparks.args, 0);
      }
      if (this.toggles.trail && effects) {
        p.setPipeline(this.pipes.trail);
        p.draw(6 * (TRAIL - 1), MAX_BALLS);
      }
    }
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
    const prof = this.profiler;
    prof?.begin();
    const stamp: Stamp = prof ? (label) => prof.pass(label) as { timestampWrites?: GPURenderPassTimestampWrites } : noStamp;
    this.encodeScene(enc, f, 'scene', stamp);
    // With an atmosphere, the exposure adapts to the light (csAmbient, written in encodeScene).
    const adapted = this.look.atmosphere && this.real ? { buffer: this.real.atmosphere.ambient, offset: ADAPTED_EXPOSURE_OFFSET } : undefined;
    if (this.toggles.post) this.post.encode(enc, this.hdr!, tex.createView(), this.look, stamp, adapted);
    prof?.resolve(enc);
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
    if (keepPixels) {
      const data = Array.from(raw);
      // Always RGBA for the caller: Apple's preferred canvas format is BGRA.
      if (this.format.startsWith('bgra')) for (let o = 0; o < data.length; o += 4) { const b = data[o]!; data[o] = data[o + 2]!; data[o + 2] = b; }
      stats.pixels = { data, bytesPerRow };
    }
    read.destroy();
    const { ids } = await this.renderIds(f);
    stats.bodyFraction = ids.reduce((a, v) => a + (v ? 1 : 0), 0) / ids.length;
    return stats;
  }

  /**
   * Test path: body slot + 1 per pixel (0 = nothing), row-major, size of the
   * target. With faces, boxes only, the face code fsFace writes instead.
   */
  async renderIds(f: FrameParams, faces = false): Promise<{ width: number; height: number; ids: Uint32Array }> {
    const [w, h] = this.offscreen ? [this.offscreen.width, this.offscreen.height] : [this.context!.canvas.width, this.context!.canvas.height];
    if (!this.idTex || this.idTex.width !== w || this.idTex.height !== h) {
      this.idTex?.destroy();
      this.idDepth?.destroy();
      this.idTex = this.device.createTexture({ size: [w, h], format: 'r32uint', usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC });
      this.idDepth = this.device.createTexture({ size: [w, h], format: 'depth24plus', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    }
    const enc = this.device.createCommandEncoder();
    this.encodeScene(enc, f, faces ? 'faces' : 'ids');
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

  /** Test path: the shadow map of the last frame, light depth 0..1 per texel (SHADOW_SIZE squared). */
  async readShadowMap(): Promise<Float32Array> {
    const bytesPerRow = SHADOW_SIZE * 4;
    const read = this.device.createBuffer({ size: bytesPerRow * SHADOW_SIZE, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
    const enc = this.device.createCommandEncoder();
    enc.copyTextureToBuffer({ texture: this.shadowTex, aspect: 'depth-only' }, { buffer: read, bytesPerRow }, [SHADOW_SIZE, SHADOW_SIZE]);
    this.device.queue.submit([enc.finish()]);
    await read.mapAsync(GPUMapMode.READ);
    const out = new Float32Array(read.getMappedRange().slice(0));
    read.destroy();
    return out;
  }

  /** Test path: the cull outputs of the last frame. */
  get cullBuffers(): Culler | null {
    return this.culler;
  }

  destroy(): void {
    this.culler?.destroy();
    this.post.destroy();
    for (const t of [this.msaa, this.hdr, this.depth, this.idTex, this.idDepth, this.shadowTex, this.offscreen]) t?.destroy();
    this.frameBuf.destroy();
    this.fxBuf?.destroy();
    this.overlayBuf.destroy();
    this.floorBuf.destroy();
    this.overlayColours.destroy();
    this.sparks.destroy();
    this.lights.destroy();
    this.ao.destroy();
    this.real?.atmosphere.destroy();
    this.real?.materials.destroy();
  }

  /** Sparks from a game event at pos, flying out around dir; strength is a speed change in m/s. */
  burst(pos: V3, dir: V3, strength: number): void {
    this.sparks.inject(pos, dir, strength);
  }

  private viewport(): [number, number] {
    const t = this.offscreen ?? this.context?.canvas;
    return t ? [t.width, t.height] : [1, 1];
  }
}

export interface PixelStats {
  width: number;
  height: number;
  distinctColors: number;
  meanLuma: number;
  /** Fraction of pixels covered by a body (from the ID pass of the same frame). */
  bodyFraction?: number;
  /** Raw rows when asked for (test screenshots), RGBA8 whatever the output format. */
  pixels?: { data: number[]; bytesPerRow: number };
}

/** Coarse statistics of an RGBA/BGRA frame: enough to tell "drew a scene" from "blank". */
export function pixelStats(px: Uint8Array, w: number, h: number, stride: number): PixelStats {
  const colors = new Set<number>();
  let luma = 0, n = 0;
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) {
    const o = y * stride + 4 * x;
    const a = px[o]!, b = px[o + 1]!, c = px[o + 2]!;
    colors.add(((a >> 3) << 10) | ((b >> 3) << 5) | (c >> 3));
    luma += (a + b + c) / 3;
    n++;
  }
  return { width: w, height: h, distinctColors: colors.size, meanLuma: luma / n };
}

// Occupancy volume for ambient occlusion (design step 13, R5).
//
// Every drawable body is splatted, each frame, into an arena-fitted grid
// of 0.5 m voxels as an axis-aligned box of the body's own volume:
//
//   footprint  the body's world AABB (its rotated box; a sphere's cube),
//              scaled about its centre to the body's volume, so a cube at
//              rest is exactly itself and a tumbling cube changes shape
//              smoothly (no AO pops), and slabs and rods keep their aspect
//   overlap    exact per voxel: the product of the three 1D overlaps of
//              footprint and voxel, as a fraction of the voxel, added in
//              16.16 fixed point with integer atomics, so the grid is
//              independent of thread order (bit-identical frame to frame)
//
// Compose then turns the grid into an rgba8unorm 3D texture with AO_MIPS
// levels (0.5, 1, 2 m), one thread per column per level, top down:
//   R  occupancy: each 0.5 m voxel clamped to 1, averaged over the level's voxel
//   G  sky visibility: exp(-skyK * occupancy above, in 0.5 m voxels)
// Each level is built from the accumulator directly (not from the level
// below), so the levels have no dependency on one another.
//
// The splat reads the cull pass's records (pose interpolated, FX scale
// applied), so AO, culling, shadows and the draw see the same pose. It
// covers every drawable slot, not just the visible ones: occluders off
// screen still darken what is on screen. splatReference is the CPU twin.
//
// Alternatives considered: a gather (each voxel finds its bodies) needs a
// spatial index the renderer does not have; rasterizing into 3D texture
// slices needs one render pass per slice; an equal-volume cube (the
// first design) ignores aspect, so a floor slab becomes a tall blob.
import { Body, RenderRecord, Shape, TIER, wgslStruct } from '@tb/schema';
import type { Arena } from './shadowfit.ts';
import type { BodySource } from './source.ts';
import type { V3 } from './math.ts';

export const AO_VOXEL = 0.5;
/** Grids above this many voxels double the voxel size instead. */
export const AO_MAX_VOXELS = 5_000_000;
/** Fixed point of the accumulator: 1 voxel fully covered. */
export const AO_ONE = 65536;
/** cbrt(pi / 6): a sphere's volume over its bounding cube's, as a length scale. */
export const FOOT_SPHERE = Math.fround(Math.cbrt(Math.PI / 6));
/** Texture levels: 0.5, 1 and 2 m voxels at the default size. Grid dims are multiples of 2^(AO_MIPS-1). */
export const AO_MIPS = 3;
/** Sky visibility falls by e per this many fully occupied 0.5 m voxels above, inverted. */
export const AO_SKY_K = 0.5;

const WG = 256;
const PARAM_BYTES = 48;

export interface AoGrid {
  /** World position of voxel (0, 0, 0)'s low corner, a multiple of voxel. */
  origin: V3;
  voxel: number;
  dims: [number, number, number];
}

/** The grid over an arena's box (clipped by its sphere), voxel doubled until it fits the cap. */
export function aoGrid(arena: Arena, voxel = AO_VOXEL, cap = AO_MAX_VOXELS): AoGrid {
  const { center: c, half: h, radius = Infinity } = arena;
  const lo = [0, 1, 2].map((k) => c[k]! - Math.min(h[k]!, radius)), hi = [0, 1, 2].map((k) => c[k]! + Math.min(h[k]!, radius));
  for (;;) {
    const origin = lo.map((v) => Math.floor(v / voxel) * voxel) as V3;
    const step = 2 ** (AO_MIPS - 1);
    const dims = [0, 1, 2].map((k) => Math.max(1, Math.ceil((hi[k]! - origin[k]!) / voxel / step)) * step) as [number, number, number];
    if (dims[0] * dims[1] * dims[2] <= cap) return { origin, voxel, dims };
    voxel *= 2;
  }
}

export const voxelCount = (g: AoGrid) => g.dims[0] * g.dims[1] * g.dims[2];

/** The splat's view of the grid for one frame: camera-relative origin, rounded to f32 once for GPU and twin alike. */
export function aoFrame(g: AoGrid, eye: V3) {
  return { originRel: g.origin.map((v, k) => Math.fround(v - eye[k]!)) as V3, invVoxel: Math.fround(1 / g.voxel) };
}

/** Half extents of the footprint (see the header), in metres. WGSL; aoFootReference is the twin. */
export const AO_FOOT_WGSL = /* wgsl */ `
fn aoQrot(q: vec4f, v: vec3f) -> vec3f {
  let t = 2.0 * cross(q.xyz, v);
  return v + q.w * t + cross(q.xyz, t);
}

fn aoFoot(rot: vec4f, half: vec3f, sphere: bool) -> vec3f {
  if (sphere) { return vec3f(half.x * ${FOOT_SPHERE}); }
  let v = half.x * half.y * half.z;
  // Hidden (FX scale 0): 0/0 below. SwiftShader folds 0 * NaN to 0; other GPUs need not.
  if (!(v > 0.0)) { return vec3f(0.0); }
  let a = abs(aoQrot(rot, vec3f(1.0, 0.0, 0.0))) * half.x + abs(aoQrot(rot, vec3f(0.0, 1.0, 0.0))) * half.y + abs(aoQrot(rot, vec3f(0.0, 0.0, 1.0))) * half.z;
  let ratio = v / (a.x * a.y * a.z);
  return a * select(pow(ratio, 1.0 / 3.0), 1.0, ratio >= 1.0);
}
`;

export const AO_SPLAT_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
${wgslStruct(RenderRecord)}

struct AoParams {
  originRel: vec3f, invVoxel: f32,
  dims: vec3u, count: u32,
  capacity: u32, pad0: u32, pad1: u32, pad2: u32,
}

@group(0) @binding(0) var<uniform> p: AoParams;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> shapes: array<Shape>;
@group(0) @binding(3) var<storage, read> records: array<RenderRecord>;
@group(0) @binding(4) var<storage, read_write> occ: array<atomic<u32>>;

${AO_FOOT_WGSL}

@compute @workgroup_size(${WG})
fn splat(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= p.count || i >= p.capacity) { return; }
  let b = bodies[i];
  let tier = (b.flags >> 8u) & 0xffu;
  if (tier == ${TIER.lattice}u || tier == ${TIER.free}u) { return; }
  let r = records[i];
  let e = aoFoot(r.rot, r.half, shapes[b.shape].kind == 1u) * p.invVoxel;
  let u = (r.pos - p.originRel) * p.invVoxel;
  let lo = u - e;
  let hi = u + e;
  let k0 = max(vec3i(floor(lo)), vec3i(0));
  let k1 = min(vec3i(floor(hi)), vec3i(p.dims) - 1);
  for (var z = k0.z; z <= k1.z; z++) {
    let oz = min(hi.z, f32(z + 1)) - max(lo.z, f32(z));
    for (var y = k0.y; y <= k1.y; y++) {
      let oyz = oz * (min(hi.y, f32(y + 1)) - max(lo.y, f32(y)));
      for (var x = k0.x; x <= k1.x; x++) {
        let w = oyz * (min(hi.x, f32(x + 1)) - max(lo.x, f32(x)));
        let q = u32(floor(w * ${AO_ONE}.0 + 0.5));
        if (q > 0u) { atomicAdd(&occ[(u32(z) * p.dims.y + u32(y)) * p.dims.x + u32(x)], q); }
      }
    }
  }
}
`;

export const AO_COMPOSE_WGSL = /* wgsl */ `
struct ComposeParams { dims: vec3u, level: u32, base: vec3u, skyK: f32 }

@group(0) @binding(0) var<uniform> c: ComposeParams;
@group(0) @binding(1) var<storage, read> occ: array<u32>;
@group(0) @binding(2) var dst: texture_storage_3d<rgba8unorm, write>;

@compute @workgroup_size(8, 8)
fn compose(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= c.dims.x || id.y >= c.dims.z) { return; }
  let s = 1u << c.level;
  let inv = 1.0 / f32(s * s * s);
  var above = 0.0;
  for (var y = i32(c.dims.y) - 1; y >= 0; y--) {
    var o = 0.0;
    for (var dz = 0u; dz < s; dz++) {
      for (var dy = 0u; dy < s; dy++) {
        let row = ((id.y * s + dz) * c.base.y + u32(y) * s + dy) * c.base.x + id.x * s;
        for (var dx = 0u; dx < s; dx++) { o += min(f32(occ[row + dx]) / ${AO_ONE}.0, 1.0); }
      }
    }
    o *= inv;
    textureStore(dst, vec3u(id.x, u32(y), id.y), vec4f(o, exp(-c.skyK * above), 0.0, 1.0));
    above += o * f32(s);
  }
}
`;

/**
 * Shading from the volume (design step 13, taps): occlusion from three
 * taps along the normal (0.3 m at level 0, 0.9 m at 1, 2.0 m at 2),
 * ao = product of (1 - k_i * max(0, occ_i - own_i)), and sky visibility
 * from G at p + 0.6n + 0.5 m up. own_i is the shaded body's own share of
 * the tap, exact for its footprint: a level's texel is the mean over its
 * voxel and both the overlap and the trilinear weights are separable, so
 * own = product over axes of (w0 o0 + w1 o1), where o0 and o1 are the
 * footprint's overlaps with the two texels the tap blends. Without it
 * every body darkens itself. Outside the grid a tap is empty.
 * The includer declares aoVol (texture_3d<f32>) and aoSamp (filtering).
 */
export const AO_SAMPLE_WGSL = /* wgsl */ `
struct AoView { origin: vec3f, invVoxel: f32, dims: vec3f, on: f32, k: vec4f }

fn aoOwn(s: vec3f, c: vec3f, e: vec3f) -> f32 {
  let j0 = floor(s - 0.5);
  let w1 = s - 0.5 - j0;
  let o0 = clamp(min(c + e, j0 + 1.0) - max(c - e, j0), vec3f(0.0), vec3f(1.0));
  let o1 = clamp(min(c + e, j0 + 2.0) - max(c - e, j0 + 1.0), vec3f(0.0), vec3f(1.0));
  let t = (1.0 - w1) * o0 + w1 * o1;
  return t.x * t.y * t.z;
}

// Occupancy at camera-relative p from level, minus the own footprint (centre c, half extents e, metres).
fn aoTap(av: AoView, p: vec3f, level: u32, c: vec3f, e: vec3f) -> f32 {
  let scale = av.invVoxel / f32(1u << level);
  let dims = av.dims / f32(1u << level);
  let s = (p - av.origin) * scale;
  if (any(s < vec3f(0.0)) || any(s > dims)) { return 0.0; }
  let occ = textureSampleLevel(aoVol, aoSamp, s / dims, f32(level)).r;
  return max(occ - aoOwn(s, (c - av.origin) * scale, e * scale), 0.0);
}

// (occlusion, sky visibility) at a surface point: rel and c camera-relative, n unit, foot from aoFoot (0 for none).
fn aoAt(av: AoView, rel: vec3f, n: vec3f, c: vec3f, foot: vec3f) -> vec2f {
  if (av.on == 0.0) { return vec2f(1.0); }
  var a = (1.0 - av.k.x * aoTap(av, rel + 0.3 * n, 0u, c, foot));
  a *= 1.0 - av.k.y * aoTap(av, rel + 0.9 * n, 1u, c, foot);
  a *= 1.0 - av.k.z * aoTap(av, rel + 2.0 * n, 2u, c, foot);
  let sp = (rel + 0.6 * n + vec3f(0.0, 0.5, 0.0) - av.origin) * av.invVoxel;
  var sky = 1.0;
  if (all(sp >= vec3f(0.0)) && all(sp <= av.dims)) { sky = textureSampleLevel(aoVol, aoSamp, sp / av.dims, 0.0).g; }
  return vec2f(a, mix(1.0, sky, av.k.w));
}
`;

/** Tap strengths (0.3, 0.9, 2.0 m) and the sky term's weight. */
export const AO_K: [number, number, number, number] = [0.6, 0.5, 0.35, 1];

// ---------------------------------------------------------------- CPU twins

const fr = Math.fround;

function qrotRef(q: readonly number[], v: V3): V3 {
  const [x, y, z, w] = q as [number, number, number, number];
  const t = [fr(2 * fr(fr(y * v[2]) - fr(z * v[1]))), fr(2 * fr(fr(z * v[0]) - fr(x * v[2]))), fr(2 * fr(fr(x * v[1]) - fr(y * v[0])))];
  const c = [fr(fr(y * t[2]!) - fr(z * t[1]!)), fr(fr(z * t[0]!) - fr(x * t[2]!)), fr(fr(x * t[1]!) - fr(y * t[0]!))];
  return [0, 1, 2].map((k) => fr(fr(v[k]! + fr(w * t[k]!)) + c[k]!)) as V3;
}

/** CPU twin of aoFoot (f32 at every step; exact for unrotated boxes and spheres, within a few ulps otherwise). */
export function aoFootReference(rot32: readonly number[], half32: readonly number[], sphere: boolean): V3 {
  const rot = rot32.map(fr), half = [0, 1, 2].map((k) => fr(half32[k] ?? 0));
  if (sphere) { const s = fr(half[0]! * FOOT_SPHERE); return [s, s, s]; }
  const v = fr(fr(half[0]! * half[1]!) * half[2]!);
  if (!(v > 0)) return [0, 0, 0];
  const cols = [qrotRef(rot, [1, 0, 0]), qrotRef(rot, [0, 1, 0]), qrotRef(rot, [0, 0, 1])];
  const a = [0, 1, 2].map((k) => fr(fr(fr(Math.abs(cols[0]![k]!) * half[0]!) + fr(Math.abs(cols[1]![k]!) * half[1]!)) + fr(Math.abs(cols[2]![k]!) * half[2]!)));
  const ratio = fr(v / fr(fr(a[0]! * a[1]!) * a[2]!));
  const s = ratio >= 1 ? 1 : fr(Math.cbrt(ratio));
  return a.map((x) => fr(x * s)) as V3;
}

export interface SplatBody { pos: readonly number[]; rot: readonly number[]; half: readonly number[]; sphere: boolean }

/** CPU twin of the splat: the 16.16 grid for these records (camera-relative, as the cull pass wrote them). */
export function splatReference(bodies: SplatBody[], g: AoGrid, eye: V3): Uint32Array {
  const { originRel, invVoxel } = aoFrame(g, eye);
  const [nx, ny, nz] = g.dims;
  const occ = new Uint32Array(nx * ny * nz);
  for (const b of bodies) {
    const foot = aoFootReference(b.rot, b.half, b.sphere);
    const e = foot.map((x) => fr(x * invVoxel));
    const u = [0, 1, 2].map((k) => fr(fr(b.pos[k]! - originRel[k]!) * invVoxel));
    const lo = u.map((x, k) => fr(x - e[k]!)), hi = u.map((x, k) => fr(x + e[k]!));
    const k0 = lo.map((x) => Math.max(Math.floor(x), 0)), k1 = hi.map((x, k) => Math.min(Math.floor(x), g.dims[k]! - 1));
    for (let z = k0[2]!; z <= k1[2]!; z++) {
      const oz = fr(Math.min(hi[2]!, z + 1) - Math.max(lo[2]!, z));
      for (let y = k0[1]!; y <= k1[1]!; y++) {
        const oyz = fr(oz * fr(Math.min(hi[1]!, y + 1) - Math.max(lo[1]!, y)));
        for (let x = k0[0]!; x <= k1[0]!; x++) {
          const w = fr(oyz * fr(Math.min(hi[0]!, x + 1) - Math.max(lo[0]!, x)));
          const q = Math.floor(fr(w * AO_ONE) + 0.5);
          if (q > 0) occ[(z * ny + y) * nx + x]! += q;
        }
      }
    }
  }
  return occ;
}

/** CPU twin of compose: per level, R and G as floats (before unorm8 rounding), x fastest. */
export function composeReference(occ: Uint32Array, g: AoGrid, skyK = AO_SKY_K): { dims: [number, number, number]; r: Float32Array; g: Float32Array }[] {
  const [bx, by] = g.dims;
  const out = [];
  for (let level = 0; level < AO_MIPS; level++) {
    const s = 2 ** level, dims = g.dims.map((d) => d / s) as [number, number, number];
    const R = new Float32Array(dims[0] * dims[1] * dims[2]), G = new Float32Array(R.length);
    const inv = fr(1 / (s * s * s));
    for (let z = 0; z < dims[2]; z++) for (let x = 0; x < dims[0]; x++) {
      let above = 0;
      for (let y = dims[1] - 1; y >= 0; y--) {
        let o = 0;
        for (let dz = 0; dz < s; dz++) for (let dy = 0; dy < s; dy++) {
          const row = ((z * s + dz) * by + y * s + dy) * bx + x * s;
          for (let dx = 0; dx < s; dx++) o = fr(o + Math.min(fr(occ[row + dx]! / AO_ONE), 1));
        }
        o = fr(o * inv);
        const v = (z * dims[1] + y) * dims[0] + x;
        R[v] = o;
        G[v] = Math.exp(-skyK * above);
        above = fr(above + fr(o * s));
      }
    }
    out.push({ dims, r: R, g: G });
  }
  return out;
}

// ---------------------------------------------------------------- GPU side

export class AoVolume {
  /** The 16.16 occupancy accumulator, x fastest. */
  occ: GPUBuffer;
  /** The composed volume (R occupancy, G sky), AO_MIPS levels; sample it with linear filtering. */
  volume: GPUTexture;
  /** Sky visibility falloff, read each frame. */
  skyK = AO_SKY_K;
  /** Shading strengths (AO_K), read each frame by the renderer. */
  k: [number, number, number, number] = [...AO_K];
  private readonly params: GPUBuffer;
  private readonly composeParams: GPUBuffer[];
  private readonly pipe: GPUComputePipeline;
  private readonly composePipe: GPUComputePipeline;
  private bind: GPUBindGroup | null = null;
  private composeBinds: GPUBindGroup[] = [];
  private bound: unknown[] = [];

  constructor(private readonly device: GPUDevice, public grid: AoGrid) {
    this.params = device.createBuffer({ size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'ao params' });
    this.composeParams = Array.from({ length: AO_MIPS }, (_, l) => device.createBuffer({ size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: `ao compose ${l}` }));
    const module = device.createShaderModule({ code: AO_SPLAT_WGSL, label: 'ao splat' });
    this.pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'splat' } });
    const cm = device.createShaderModule({ code: AO_COMPOSE_WGSL, label: 'ao compose' });
    this.composePipe = device.createComputePipeline({ layout: 'auto', compute: { module: cm, entryPoint: 'compose' } });
    [this.occ, this.volume] = this.allocate();
  }

  private allocate(): [GPUBuffer, GPUTexture] {
    const g = this.grid;
    const occ = this.device.createBuffer({ size: voxelCount(g) * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST, label: 'ao occupancy' });
    const volume = this.device.createTexture({
      size: g.dims, dimension: '3d', format: 'rgba8unorm', mipLevelCount: AO_MIPS,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC, label: 'ao volume',
    });
    this.composeBinds = this.composeParams.map((params, level) => this.device.createBindGroup({
      layout: this.composePipe.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: params } }, { binding: 1, resource: { buffer: occ } }, { binding: 2, resource: volume.createView({ baseMipLevel: level, mipLevelCount: 1 }) }],
    }));
    this.bind = null;
    return [occ, volume];
  }

  /** Change the grid; the buffers and texture are rebuilt when its size changes (rebind the volume then). */
  setGrid(g: AoGrid): void {
    const same = g.voxel === this.grid.voxel && g.dims.every((d, k) => d === this.grid.dims[k]);
    this.grid = g;
    if (same) return;
    this.occ.destroy();
    this.volume.destroy();
    [this.occ, this.volume] = this.allocate();
  }

  /** Zero the accumulator: outside any pass, before the compute pass that splats. */
  clear(enc: GPUCommandEncoder): void {
    enc.clearBuffer(this.occ);
  }

  /** Splat every drawable slot, after the cull pass wrote this frame's records (same compute pass is fine). */
  splat(pass: GPUComputePassEncoder, source: BodySource, records: GPUBuffer, eye: V3): void {
    const want = [source.bodies, source.shapes, records, this.occ];
    if (!this.bind || want.some((b, i) => b !== this.bound[i])) {
      this.bind = this.device.createBindGroup({
        layout: this.pipe.getBindGroupLayout(0),
        entries: [this.params, ...want].map((buffer, binding) => ({ binding, resource: { buffer } })),
      });
      this.bound = want;
    }
    const { originRel, invVoxel } = aoFrame(this.grid, eye);
    const buf = new ArrayBuffer(PARAM_BYTES), fl = new Float32Array(buf), u = new Uint32Array(buf);
    fl.set(originRel, 0); fl[3] = invVoxel;
    u.set(this.grid.dims, 4);
    u[7] = Math.min(source.count, source.capacity);
    u[8] = source.capacity;
    this.device.queue.writeBuffer(this.params, 0, buf);
    pass.setBindGroup(0, this.bind);
    pass.setPipeline(this.pipe);
    pass.dispatchWorkgroups(Math.ceil(source.capacity / WG));
  }

  /** Build the volume's levels from the accumulator, after the splat (same compute pass). */
  compose(pass: GPUComputePassEncoder): void {
    pass.setPipeline(this.composePipe);
    for (let level = 0; level < AO_MIPS; level++) {
      const s = 2 ** level, dims = this.grid.dims.map((d) => d / s);
      const buf = new ArrayBuffer(32), u = new Uint32Array(buf), fl = new Float32Array(buf);
      u.set(dims, 0); u[3] = level; u.set(this.grid.dims, 4); fl[7] = this.skyK;
      this.device.queue.writeBuffer(this.composeParams[level]!, 0, buf);
      pass.setBindGroup(0, this.composeBinds[level]!);
      pass.dispatchWorkgroups(Math.ceil(dims[0]! / 8), Math.ceil(dims[2]! / 8));
    }
  }

  destroy(): void {
    for (const b of [this.occ, this.params, ...this.composeParams]) b.destroy();
    this.volume.destroy();
  }
}

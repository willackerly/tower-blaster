// Per-frame body preparation on the GPU: interpolate each body's pose
// between the last two steps, make it camera-relative, cull it against the
// camera and light frusta, and compact the survivors into one list per draw
// segment, with indirect draw arguments. No CPU readback, no per-body upload.
//
// Passes (one compute pass):
//   prepare   one thread per slot: RenderRecord (with the slot's FX scale
//             applied) + a 0/1 flag per segment
//   scan      exclusive scan over all segment flags (one Scanner, fixed n)
//   scatter   flagged slot -> lists[seg * capacity + local index]
//   args      one thread: drawIndirect arguments per segment
//
// Lists hold slot indices; vertex shaders read records[lists[...]]. The
// alternative, copying 48 B records into the lists, costs 12x the scatter
// traffic to save one dependent load per vertex; revisit with bench:render.
// A scan rather than atomic appends keeps list order deterministic, so the
// lists can be compared element by element with cullReference().
import { Scanner } from '@tb/gpu';
import { Body, RenderRecord, Shape, TIER, wgslStruct } from '@tb/schema';
import { FX_WGSL } from './fx.ts';
import type { BodySource } from './source.ts';

export const SEGMENTS = ['box', 'sphere', 'boxShadow', 'sphereShadow'] as const;
export type Segment = (typeof SEGMENTS)[number];
export const SEG = { box: 0, sphere: 1, boxShadow: 2, sphereShadow: 3 } as const;

/** Interpolation is skipped when a body moved further than this in one step (teleport, slot reuse). */
export const MAX_STEP_JUMP = 3;

const WG = 256;

export const CULL_WGSL = /* wgsl */ `
${wgslStruct(Body)}
${wgslStruct(Shape)}
${wgslStruct(RenderRecord)}
${FX_WGSL}

struct CullParams {
  planes: array<vec4f, 6>,      // camera frustum, camera-relative, inside: dot(n, p) + d >= 0
  lightPlanes: array<vec4f, 6>, // shadow caster box, camera-relative
  eye: vec3f,
  alpha: f32,                   // 0 = previous step, 1 = latest step
  count: u32,
  capacity: u32,
  noCull: u32,
  vertsBox: u32,
  vertsSphere: u32,
  vertsBoxShadow: u32,
}

@group(0) @binding(0) var<uniform> p: CullParams;
@group(0) @binding(1) var<storage, read> bodies: array<Body>;
@group(0) @binding(2) var<storage, read> prev: array<Body>;
@group(0) @binding(3) var<storage, read> shapes: array<Shape>;
@group(0) @binding(4) var<storage, read> looks: array<u32>;
@group(0) @binding(5) var<storage, read_write> records: array<RenderRecord>;
@group(0) @binding(6) var<storage, read_write> scan: array<u32>;   // 4 * capacity + 1
@group(0) @binding(7) var<storage, read_write> lists: array<u32>;  // 4 * capacity
@group(0) @binding(8) var<storage, read_write> args: array<u32>;   // 4 x drawIndirect
@group(0) @binding(9) var<storage, read> fx: array<vec4u>;         // per slot, see fx.ts

fn inside(planes: array<vec4f, 6>, c: vec3f, r: f32) -> bool {
  var ok = true;
  for (var k = 0; k < 6; k++) { ok = ok && dot(planes[k].xyz, c) + planes[k].w >= -r; }
  return ok;
}

@compute @workgroup_size(${WG})
fn prepare(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let cap = p.capacity;
  if (i >= cap) { return; }
  var seg = 0u;
  var vis = false;
  var shadow = false;
  if (i < p.count) {
    let b = bodies[i];
    let tier = (b.flags >> 8u) & 0xffu;
    if (tier != ${TIER.lattice}u && tier != ${TIER.free}u) {
      let sh = shapes[b.shape];
      var pos = b.pos;
      var rot = b.rot;
      let q = prev[i];
      let qTier = (q.flags >> 8u) & 0xffu;
      let valid = q.shape == b.shape && qTier == tier && dot(q.rot, q.rot) > 0.5 && distance(q.pos, b.pos) < ${MAX_STEP_JUMP}.0;
      if (valid && p.alpha < 1.0) {
        pos = mix(q.pos, b.pos, p.alpha);
        let qr = select(q.rot, -q.rot, dot(q.rot, b.rot) < 0.0);
        rot = normalize(mix(qr, b.rot, p.alpha));
      }
      let fs = fxScale(fx[i].y);
      let half = sh.half * fs.scale;
      if (fs.anchor) {
        let t = 2.0 * cross(rot.xyz, vec3f(0.0, 1.0, 0.0));
        pos -= (sh.half.y - half.y) * (vec3f(0.0, 1.0, 0.0) + rot.w * t + cross(rot.xyz, t));
      }
      let rel = pos - p.eye;
      records[i] = RenderRecord(rel, looks[i], rot, half, i);
      seg = min(sh.kind, 1u);
      let r = select(length(half), half.x, sh.kind == 1u);
      let shown = fs.scale > 0.0;
      vis = shown && (p.noCull != 0u || inside(p.planes, rel, r));
      shadow = shown && (p.noCull != 0u || inside(p.lightPlanes, rel, r));
    }
  }
  scan[i] = select(0u, 1u, vis && seg == 0u);
  scan[cap + i] = select(0u, 1u, vis && seg == 1u);
  scan[2u * cap + i] = select(0u, 1u, shadow && seg == 0u);
  scan[3u * cap + i] = select(0u, 1u, shadow && seg == 1u);
  if (i == 0u) { scan[4u * cap] = 0u; }
}

@compute @workgroup_size(${WG})
fn scatter(@builtin(global_invocation_id) id: vec3u) {
  let k = id.x;
  let cap = p.capacity;
  if (k >= 4u * cap) { return; }
  let o = scan[k];
  if (scan[k + 1u] == o) { return; }
  let seg = k / cap;
  lists[seg * cap + (o - scan[seg * cap])] = k - seg * cap;
}

@compute @workgroup_size(1)
fn writeArgs() {
  let cap = p.capacity;
  for (var s = 0u; s < 4u; s++) {
    args[4u * s] = select(select(p.vertsBox, p.vertsBoxShadow, s == ${SEG.boxShadow}u), p.vertsSphere, s % 2u == 1u);
    args[4u * s + 1u] = scan[(s + 1u) * cap] - scan[s * cap];
    args[4u * s + 2u] = 0u;
    args[4u * s + 3u] = 0u;
  }
}
`;

export type Planes = Float32Array; // 6 x vec4

export interface CullFrame {
  /** Camera-relative view-projection (clip = M * (world - eye)). */
  viewProj: Float32Array;
  /** Camera-relative light view-projection for the shadow map. */
  lightViewProj: Float32Array;
  eye: [number, number, number];
  alpha: number;
  noCull?: boolean;
}

/**
 * Frustum planes of a WebGPU clip matrix (depth 0..1), normalized, as
 * (n, d) with dot(n, p) + d >= 0 inside. Gribb-Hartmann on the rows.
 */
export function frustumPlanes(m: Float32Array): Planes {
  const row = (r: number) => [m[r]!, m[4 + r]!, m[8 + r]!, m[12 + r]!];
  const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
  const planes = [
    r3.map((x, k) => x + r0[k]!), r3.map((x, k) => x - r0[k]!),
    r3.map((x, k) => x + r1[k]!), r3.map((x, k) => x - r1[k]!),
    r2, r3.map((x, k) => x - r2[k]!),
  ];
  const out = new Float32Array(24);
  planes.forEach((pl, i) => {
    const l = Math.hypot(pl[0]!, pl[1]!, pl[2]!) || 1;
    for (let k = 0; k < 4; k++) out[4 * i + k] = pl[k]! / l;
  });
  return out;
}

const PARAM_BYTES = 12 * 16 + 16 + 32;

export class Culler {
  readonly records: GPUBuffer;
  readonly lists: GPUBuffer;
  /** 4 x drawIndirect (vertexCount, instanceCount, firstVertex, firstInstance), in SEGMENTS order. */
  readonly args: GPUBuffer;
  private readonly scanBuf: GPUBuffer;
  private readonly params: GPUBuffer;
  private readonly scanner: Scanner;
  private readonly binds: { prepare: GPUBindGroup; scatter: GPUBindGroup; args: GPUBindGroup };
  private readonly pipes: { prepare: GPUComputePipeline; scatter: GPUComputePipeline; args: GPUComputePipeline };
  readonly capacity: number;

  /** fx: the renderer's per-slot FX records (FX_WORDS u32 each, at least capacity of them). */
  constructor(private readonly device: GPUDevice, readonly source: BodySource, private readonly verts: { box: number; boxShadow?: number; sphere: number }, fx: GPUBuffer) {
    const cap = (this.capacity = source.capacity);
    const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC;
    this.records = device.createBuffer({ size: Math.max(16, cap * RenderRecord.size), usage, label: 'render records' });
    this.lists = device.createBuffer({ size: Math.max(16, 4 * cap * 4), usage, label: 'render lists' });
    this.scanBuf = device.createBuffer({ size: (4 * cap + 1) * 4, usage, label: 'cull scan' });
    this.args = device.createBuffer({ size: 64, usage: usage | GPUBufferUsage.INDIRECT, label: 'draw args' });
    this.params = device.createBuffer({ size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST, label: 'cull params' });
    this.scanner = new Scanner(device, this.scanBuf, 4 * cap + 1);
    const module = device.createShaderModule({ code: CULL_WGSL, label: 'cull' });
    // One layout per kernel ('auto', holding only what it uses): together
    // they bind 9 storage buffers, over WebGPU's default limit of 8.
    const pipe = (entryPoint: string) => device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint } });
    this.pipes = { prepare: pipe('prepare'), scatter: pipe('scatter'), args: pipe('writeArgs') };
    const all = [this.params, source.bodies, source.prev, source.shapes, source.looks, this.records, this.scanBuf, this.lists, this.args, fx];
    const bind = (p: GPUComputePipeline, bindings: number[]) => device.createBindGroup({
      layout: p.getBindGroupLayout(0),
      entries: bindings.map((binding) => ({ binding, resource: { buffer: all[binding]! } })),
    });
    this.binds = { prepare: bind(this.pipes.prepare, [0, 1, 2, 3, 4, 5, 6, 9]), scatter: bind(this.pipes.scatter, [0, 6, 7]), args: bind(this.pipes.args, [0, 6, 8]) };
  }

  /** Record the cull into an open compute pass. */
  encode(pass: GPUComputePassEncoder, f: CullFrame): void {
    const cap = this.capacity;
    const buf = new ArrayBuffer(PARAM_BYTES);
    const fl = new Float32Array(buf), u = new Uint32Array(buf);
    fl.set(frustumPlanes(f.viewProj), 0);
    fl.set(frustumPlanes(f.lightViewProj), 24);
    fl.set(f.eye, 48);
    fl[51] = Math.min(1, Math.max(0, f.alpha));
    u[52] = Math.min(this.source.count, cap);
    u[53] = cap;
    u[54] = f.noCull ? 1 : 0;
    u[55] = this.verts.box;
    u[56] = this.verts.sphere;
    u[57] = this.verts.boxShadow ?? this.verts.box;
    this.device.queue.writeBuffer(this.params, 0, buf);
    pass.setBindGroup(0, this.binds.prepare);
    pass.setPipeline(this.pipes.prepare);
    pass.dispatchWorkgroups(Math.ceil(cap / WG));
    this.scanner.encode(pass, 4 * cap + 1);
    pass.setBindGroup(0, this.binds.scatter);
    pass.setPipeline(this.pipes.scatter);
    pass.dispatchWorkgroups(Math.ceil((4 * cap) / WG));
    pass.setBindGroup(0, this.binds.args);
    pass.setPipeline(this.pipes.args);
    pass.dispatchWorkgroups(1);
  }

  destroy(): void {
    this.scanner.destroy();
    for (const b of [this.records, this.lists, this.scanBuf, this.args, this.params]) b.destroy();
  }
}

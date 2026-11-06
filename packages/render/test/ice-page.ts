// Page-side drivers for the ice tests (render-ice.test.ts): a block in front
// of a striped backdrop, drawn opaque, as ice, and hidden (the backdrop
// alone); the path WGSL against its CPU twin.
import { emptySnapshot, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { readBuffer, sharedDevice } from '@tb/gpu';
import { ICE_PATH_WGSL, icePath, LOOKS, lookAt, multiply, perspective, refractRay, Renderer, SnapshotSource, type FrameParams, type IceParams, type SurfaceOptions, type V3 } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function box(pos: V3, half: V3, rot: [number, number, number, number] = [0, 0, 0, 1], tag = 0): BodyDesc {
  return { shape: { kind: 'box', half }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag };
}

function snapshotOf(descs: BodyDesc[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  return s;
}

// ---------------------------------------------------------------- path twin

/** icePath on the GPU (ICE_PATH_WGSL) against the CPU twin on random rays into random boxes. */
export async function iceTwins(seed: number, n = 4096) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed), f32 = Math.fround;
  const cases: Array<{ p0: V3; d0: V3; h: V3; ior: number; bounces: number }> = [];
  for (let i = 0; i < n; i++) {
    const h: V3 = [f32(0.05 + r()), f32(0.05 + r()), f32(0.05 + r())];
    const ax = Math.floor(r() * 3), sg = r() < 0.5 ? -1 : 1;
    const p0 = h.map((x, k) => f32(k === ax ? sg * x : (2 * r() - 1) * x)) as V3;
    const nrm: V3 = [0, 0, 0]; nrm[ax] = sg;
    let v: V3 = [r() - 0.5, r() - 0.5, r() - 0.5];
    const l = Math.hypot(...v); v = v.map((x) => x / l) as V3;
    if (v[0] * nrm[0] + v[1] * nrm[1] + v[2] * nrm[2] > 0) v = v.map((x) => -x) as V3;
    const ior = f32(1.31 + (r() < 0.2 ? 0.2 : 0));
    const d0 = refractRay(v, nrm, 1 / ior).map(f32) as V3;
    cases.push({ p0, d0, h, ior, bounces: Math.floor(r() * 4) });
  }
  const inputs = new Float32Array(cases.flatMap((c) => [...c.p0, c.ior, ...c.d0, c.bounces, ...c.h, 0]));
  const code = `${ICE_PATH_WGSL}
@group(0) @binding(0) var<storage, read> xs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> ys: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= ${n}u) { return; }
  let a = xs[3u * i]; let b = xs[3u * i + 1u]; let c = xs[3u * i + 2u];
  let o = icePath(a.xyz, b.xyz, c.xyz, a.w, u32(b.w));
  ys[3u * i] = vec4f(o.p, o.len);
  ys[3u * i + 1u] = vec4f(o.d, o.first);
  ys[3u * i + 2u] = vec4f(o.t, f32(o.bounces), select(0.0, 1.0, o.escaped), f32(o.axis));
}`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const xs = device.createBuffer({ size: inputs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(xs, 0, inputs);
  const ys = device.createBuffer({ size: n * 48, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: xs } }, { binding: 1, resource: { buffer: ys } }] }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const out = new Float32Array(await readBuffer(device, ys));
  xs.destroy(); ys.destroy();
  // Rays that graze an edge or the critical angle may go either way in f32: count them, compare the rest.
  let lenErr = 0, dirErr = 0, tErr = 0, branch = 0, escaped = 0, bounced = 0;
  cases.forEach((c, i) => {
    const want = icePath(c.p0, c.d0, c.h, c.ior, c.bounces);
    const o = 12 * i;
    const same = out[o + 10] === (want.escaped ? 1 : 0) && out[o + 9] === want.bounces && out[o + 11] === want.axis;
    if (!same) { branch++; return; }
    if (want.escaped) escaped++;
    if (want.bounces > 0) bounced++;
    lenErr = Math.max(lenErr, Math.abs(out[o + 3]! - want.len) / Math.max(1, want.len));
    for (let k = 0; k < 3; k++) dirErr = Math.max(dirErr, Math.abs(out[o + 4 + k]! - want.d[k]!));
    tErr = Math.max(tErr, Math.abs(out[o + 8]! - want.t));
  });
  const err = await device.popErrorScope();
  return { n, branch, escaped, bounced, lenErr, dirErr, tErr, error: err?.message ?? null };
}

// ---------------------------------------------------------------- frames

export interface IceFrameCase {
  look: 'candy' | 'real';
  size?: [number, number];
  /** Crack levels to draw the ice block at (each its own frame), with this origin (body-normalized). */
  cracks?: number[];
  crackAt?: V3;
  ice?: Partial<IceParams>;
  /** Turn the block so it shows three faces (internal reflections show). */
  turned?: boolean;
  /** Keep the frames' pixels (debug screenshots). */
  keep?: boolean;
  /** Also draw a blast behind the block (the effects after the ice pass). */
  blast?: boolean;
}

type Px = { data: number[]; bytesPerRow: number };

/**
 * A block (slot 0) in front of a striped backdrop, drawn: opaque (A), as ice (B), hidden (C, the
 * backdrop alone), and as ice at each crack level asked for. Over the block's pixels (from A's IDs):
 * how B correlates with C (see-through) and with A, mean colours, and per crack level the mean
 * change from the uncracked ice. Also: the frame with no surface ever set and with the default
 * surface set are bit-identical (no ice: one pass, as before), and IDs include an ice block.
 */
export async function iceFrames(c: IceFrameCase) {
  const { device } = await sharedDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const [W, H] = c.size ?? [200, 120];
  const s2 = Math.SQRT1_2, turn: [number, number, number, number] = c.turned ? [0.2798, 0.3647, -0.1159, 0.8806] : [0, 0, 0, 1];
  const descs: BodyDesc[] = [box([0, 0.5, 0.4], [0.5, 0.5, 0.5], turn)];
  for (let k = 0; k < 9; k++) descs.push(box([-2 + 0.5 * k, 0.9, -1.5], [0.22, 0.9, 0.2], [0, 0, 0, 1], 1));
  void s2;
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] }, { format: 'rgba8unorm' });
  rend.look = { ...(c.look === 'real' ? LOOKS.real! : LOOKS.candy!), bloomMix: 0, vignette: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  rend.setShadowBounds([0, 1, 0], 4, [3, 2, 3]);
  const stripes = (flip: boolean) => { for (let k = 0; k < 9; k++) rend.setFx(1 + k, { tint: (k % 2 === 0) !== flip ? [1, 1, 1] : [0.08, 0.08, 0.08] }); };
  stripes(false);
  if (c.ice) rend.ice.params = { ...rend.ice.params, ...c.ice };
  const eye: V3 = [0, 1.0, 3.2];
  const f: FrameParams = { viewProj: multiply(perspective(0.9, W / H, 0.1, 400), lookAt(eye, [0, 0.6, 0])), eye, groundY: 0, time: 1, dt: 0, alpha: 1 };
  const frame = async () => { await rend.render(f); return (await rend.render(f, true, true))!.pixels! as Px; };
  const hash = (p: Px) => { let h = 2166136261; for (const x of p.data) h = Math.imul(h ^ x, 16777619) >>> 0; return h; };

  const A = await frame();
  const noSurface = hash(A);
  const ids = (await rend.renderIds(f)).ids;
  rend.setSurface(0, { kind: 'default' });
  const defaultSet = hash(await frame());
  const surface = (s: SurfaceOptions) => rend.setSurface(0, { kind: 'ice', at: c.crackAt ?? [0, 0.4, 1], seed: 7, ...s });
  surface({ crack: 0 });
  const iceCount = rend.ice.count;
  const B = await frame();
  const idsIce = (await rend.renderIds(f)).ids;
  const crackFrames: Px[] = [];
  for (const level of c.cracks ?? []) { surface({ crack: level }); crackFrames.push(await frame()); }
  surface({ crack: 0 });
  let blastDiff = 0;
  if (c.blast) {
    rend.blast([0, 1, -3], 1, 0.9);
    const withBlast = await frame();
    blastDiff = mean(withBlast, B, W, H, () => true);
    rend.toggles.blasts = false;
  }
  // The same ice without absorption: what the tint adds.
  const params = rend.ice.params;
  rend.ice.params = { ...params, absorb: 0 };
  const clear = await frame();
  rend.ice.params = params;
  // The stripes swapped: how much of the change behind shows through, per channel.
  stripes(true);
  const B2 = await frame();
  rend.setSurface(0, { kind: 'default' });
  const A2 = await frame();
  rend.setFx(0, { scale: 0 });
  const C2 = await frame();
  stripes(false);
  const C = await frame();
  const err = await device.popErrorScope();
  rend.destroy();

  const region = (x: number, y: number) => ids[y * W + x] === 1;
  const lumas = (p: Px) => { const out: number[] = []; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (region(x, y)) { const o = y * p.bytesPerRow + 4 * x; out.push((p.data[o]! + p.data[o + 1]! + p.data[o + 2]!) / 3); } return out; };
  const meanRgb = (p: Px) => { const s = [0, 0, 0]; let n = 0; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (region(x, y)) { const o = y * p.bytesPerRow + 4 * x; s[0] = s[0]! + p.data[o]!; s[1] = s[1]! + p.data[o + 1]!; s[2] = s[2]! + p.data[o + 2]!; n++; } return s.map((v) => v / Math.max(n, 1)); };
  const lA = lumas(A), lB = lumas(B), lC = lumas(C);
  let iceIds = 0;
  for (let i = 0; i < idsIce.length; i++) if (idsIce[i] === 1) iceIds++;
  return {
    error: err?.message ?? null, W, H, pixels: lA.length, iceCount, iceIds,
    noSurface, defaultSet,
    corrBC: corr(lB, lC), corrBA: corr(lB, lA), corrAC: corr(lA, lC),
    // Per channel, mean |change| in the block's pixels when the stripes swap, over the backdrop's own change there.
    throughIce: chan(B, B2, W, H, region).map((x, k) => x / Math.max(chan(C, C2, W, H, region)[k]!, 1e-6)),
    throughOpaque: chan(A, A2, W, H, region).map((x, k) => x / Math.max(chan(C, C2, W, H, region)[k]!, 1e-6)),
    rgbA: meanRgb(A), rgbB: meanRgb(B), rgbC: meanRgb(C), rgbClear: meanRgb(clear),
    diffBC: mean(B, C, W, H, region), diffBA: mean(B, A, W, H, region),
    crackDiff: crackFrames.map((p) => mean(p, B, W, H, region)),
    crackOutside: crackFrames.map((p) => mean(p, B, W, H, (x, y) => !region(x, y))),
    blastDiff,
    frames: c.keep ? { A, B, C, cracks: crackFrames } : null,
  };
}

function chan(p: Px, q: Px, W: number, H: number, inRegion: (x: number, y: number) => boolean): number[] {
  const s = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inRegion(x, y)) {
    const o = y * p.bytesPerRow + 4 * x;
    for (let k = 0; k < 3; k++) s[k] = s[k]! + Math.abs(p.data[o + k]! - q.data[o + k]!);
    n++;
  }
  return s.map((v) => v / Math.max(n, 1));
}

function corr(a: number[], b: number[]): number {
  const n = a.length, ma = a.reduce((s, x) => s + x, 0) / n, mb = b.reduce((s, x) => s + x, 0) / n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { sab += (a[i]! - ma) * (b[i]! - mb); saa += (a[i]! - ma) ** 2; sbb += (b[i]! - mb) ** 2; }
  return sab / Math.sqrt(Math.max(saa * sbb, 1e-12));
}

function mean(p: Px, q: Px, W: number, H: number, inRegion: (x: number, y: number) => boolean): number {
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (inRegion(x, y)) {
    const o = y * p.bytesPerRow + 4 * x;
    s += (Math.abs(p.data[o]! - q.data[o]!) + Math.abs(p.data[o + 1]! - q.data[o + 1]!) + Math.abs(p.data[o + 2]! - q.data[o + 2]!)) / 3;
    n++;
  }
  return s / Math.max(n, 1);
}

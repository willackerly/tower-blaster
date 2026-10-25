// Drivers that run inside the browser page (bundled by render.test.ts). Each
// checks GPU output against a CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { emptySnapshot, TAG_BALL, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { createDevice, readBuffer } from '@tb/gpu';
import { Body, RenderRecord, Shape, TIER, readStruct } from '@tb/schema';
import {
  Culler, cullReference, GpuBodySource, invert, listMatches, lookAt, makeGpuBodies, multiply, perspective, Renderer, SEGMENTS, SnapshotSource, transform,
  translation, BOX_VERTS, SPHERE_VERTS, type BodySource, type CullFrame, type FrameParams, type V3,
} from '../src/index.ts';

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

function randomQuat(r: () => number): [number, number, number, number] {
  const q = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5];
  const l = Math.hypot(...q) || 1;
  return q.map((x) => x / l) as [number, number, number, number];
}

const W = 160, H = 100;

function camera(eye: V3, target: V3, aspect = W / H): FrameParams {
  return { viewProj: multiply(perspective(0.9, aspect, 0.1, 400), lookAt(eye, target)), eye, groundY: -100, fogDist: 1e6 };
}

// ---------------------------------------------------------------- cull

/** A source made of raw Body/Shape words, so tests control tiers and prev exactly. */
function rawSource(device: GPUDevice, bodies: ArrayBuffer, prev: ArrayBuffer, shapes: ArrayBuffer, looks: Uint32Array, count: number, capacity: number): BodySource {
  const make = (data: ArrayBuffer | Uint32Array, bytes: number) => {
    const b = device.createBuffer({ size: Math.max(16, bytes), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  return {
    bodies: make(bodies, capacity * Body.size), prev: make(prev, capacity * Body.size), shapes: make(shapes, capacity * Shape.size), looks: make(looks, capacity * 4),
    capacity, count, version: 1,
  };
}

export interface CullCase { seed: number; count: number; capacity: number; alpha: number; noCull: boolean }

/**
 * Random world: boxes, slabs and spheres scattered around the camera (so
 * every frustum plane cuts some), lattice-proxy and free tiers, and prev
 * states that are valid, teleported, tier-changed or zeroed.
 */
export async function cull(cases: CullCase[]) {
  const { device } = await createDevice({ timestamps: false });
  const out: Array<{ seed: number; error: string | null; lists: Array<string | null>; counts: number[]; argsOk: boolean; recordErr: number; listed: number }> = [];
  device.pushErrorScope('validation');
  for (const c of cases) {
    const r = rng(c.seed);
    const bodies = new ArrayBuffer(c.capacity * Body.size), prev = new ArrayBuffer(c.capacity * Body.size), shapes = new ArrayBuffer(c.capacity * Shape.size);
    const bf = new Float32Array(bodies), bu = new Uint32Array(bodies), pf = new Float32Array(prev), pu = new Uint32Array(prev);
    const sf = new Float32Array(shapes), su = new Uint32Array(shapes);
    const looks = new Uint32Array(c.capacity);
    const BW = Body.size / 4, SW = Shape.size / 4;
    for (let i = 0; i < c.count; i++) {
      const sphere = r() < 0.1;
      const half = sphere ? [0.3 + r(), 0, 0] : [0.1 + r(), 0.1 + r() * 0.5, 0.1 + r() * 2];
      sf.set([half[0]!, sphere ? half[0]! : half[1]!, sphere ? half[0]! : half[2]!], i * SW);
      su[i * SW + 3] = sphere ? 1 : 0;
      const pos = [(r() - 0.5) * 120, (r() - 0.5) * 60, (r() - 0.5) * 120];
      const rot = randomQuat(r);
      const t = r();
      const tier = t < 0.05 ? TIER.latticeProxy : t < 0.08 ? TIER.free : t < 0.2 ? TIER.rubble : TIER.active;
      bf.set(pos, i * BW); bf.set(rot, i * BW + 4);
      bu[i * BW + 11] = 1 | (tier << 8);
      bu[i * BW + 15] = i;
      looks[i] = (r() * 2 ** 32) >>> 0;
      // prev: mostly a small move, sometimes invalid in each way.
      const k = r();
      const ppos = k < 0.05 ? pos.map((x) => x + 10) : pos.map((x) => x + (r() - 0.5) * 0.6);
      const prot = k > 0.95 ? [0, 0, 0, 0] : k > 0.9 ? rot.map((x) => -x) : randomQuat(r);
      pf.set(ppos, i * BW); pf.set(prot, i * BW + 4);
      pu[i * BW + 11] = 1 | ((k > 0.85 && k <= 0.9 ? TIER.rubble + 1 : tier) << 8);
      pu[i * BW + 15] = i;
    }
    const src = rawSource(device, bodies, prev, shapes, looks, c.count, c.capacity);
    const culler = new Culler(device, src, { box: BOX_VERTS, sphere: SPHERE_VERTS });
    const eye: V3 = [r() * 4, r() * 4, r() * 4];
    const cam = multiply(multiply(perspective(1.0, 1.5, 0.5, 70), lookAt(eye, [eye[0] + 1, eye[1] - 0.2, eye[2] + 0.5])), translation(eye));
    const light = multiply(multiply(perspective(0.6, 1, 1, 200), lookAt([eye[0], eye[1] + 80, eye[2]], [eye[0] + 5, eye[1], eye[2]], [0, 0, 1])), translation(eye));
    const f: CullFrame = { viewProj: cam, lightViewProj: light, eye, alpha: c.alpha, noCull: c.noCull };
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    culler.encode(pass, f);
    pass.end();
    device.queue.submit([enc.finish()]);
    const [lists, args, recs] = await Promise.all([readBuffer(device, culler.lists), readBuffer(device, culler.args), readBuffer(device, culler.records)]);
    const ref = cullReference({ bodies, prev, shapes, looks, count: c.count }, f);
    const L = new Uint32Array(lists), A = new Uint32Array(args);
    const counts = SEGMENTS.map((_, s) => A[4 * s + 1]!);
    const segLists = SEGMENTS.map((_, s) => Array.from(L.subarray(s * c.capacity, s * c.capacity + counts[s]!)));
    const argsOk = SEGMENTS.every((_, s) => A[4 * s] === (s % 2 ? SPHERE_VERTS : BOX_VERTS) && A[4 * s + 2] === 0 && A[4 * s + 3] === 0);
    let recordErr = 0;
    const view = new DataView(recs);
    for (const [slot, want] of ref.records) {
      const got = readStruct(view, RenderRecord, slot);
      if (got.slot![0] !== slot || got.look![0] !== want.look) recordErr = Infinity;
      for (const k of ['pos', 'rot', 'half'] as const) want[k].forEach((x, j) => { recordErr = Math.max(recordErr, Math.abs(x - got[k]![j]!)); });
    }
    out.push({
      seed: c.seed, error: null, counts, argsOk, recordErr, listed: counts.reduce((a, b) => a + b, 0),
      lists: segLists.map((l, s) => listMatches(l, ref.must[s]!, ref.may[s]!)),
    });
    culler.destroy();
    for (const b of [src.bodies, src.prev, src.shapes, src.looks]) b.destroy();
  }
  const err = await device.popErrorScope();
  if (err) out.forEach((o) => { o.error = err.message; });
  device.destroy();
  return out;
}

// ---------------------------------------------------------------- id probes

function box(pos: V3, half: V3, rot: [number, number, number, number], tag = 0): BodyDesc {
  return { shape: { kind: 'box', half }, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag };
}
function ball(pos: V3, radius: number): BodyDesc {
  return { shape: { kind: 'sphere', radius }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: TAG_BALL };
}

function snapshotOf(descs: BodyDesc[]): Snapshot {
  const s = emptySnapshot(descs.length);
  descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  return s;
}

function qrotInv(q: number[], v: number[]): number[] {
  // Rotate by the conjugate quaternion.
  const [x, y, z, w] = [-q[0]!, -q[1]!, -q[2]!, q[3]!];
  const t = [2 * (y * v[2]! - z * v[1]!), 2 * (z * v[0]! - x * v[2]!), 2 * (x * v[1]! - y * v[0]!)];
  return [v[0]! + w * t[0]! + (y * t[2]! - z * t[1]!), v[1]! + w * t[1]! + (z * t[0]! - x * t[2]!), v[2]! + w * t[2]! + (x * t[1]! - y * t[0]!)];
}

/**
 * CPU raycast: slot + 1 of the nearest body hit (0 for none), or -1 when
 * the nearest two hits are within 5 cm (a tessellated sphere or f32 depth
 * could legitimately pick either, so such probes are not used).
 */
function raycast(descs: BodyDesc[], o: V3, d: V3): number {
  let best = Infinity, second = Infinity, id = 0;
  descs.forEach((b, i) => {
    const rel = [o[0] - b.pos[0], o[1] - b.pos[1], o[2] - b.pos[2]];
    let t = Infinity;
    if (b.shape.kind === 'sphere') {
      const bq = rel[0]! * d[0] + rel[1]! * d[1] + rel[2]! * d[2], cq = rel[0]! ** 2 + rel[1]! ** 2 + rel[2]! ** 2 - b.shape.radius ** 2;
      const disc = bq * bq - cq;
      if (disc >= 0) t = -bq - Math.sqrt(disc);
    } else {
      const lo = qrotInv(b.rot, rel), ld = qrotInv(b.rot, d);
      let t0 = -Infinity, t1 = Infinity;
      for (let k = 0; k < 3; k++) {
        const h = b.shape.half[k]!;
        if (Math.abs(ld[k]!) < 1e-12) { if (Math.abs(lo[k]!) > h) { t0 = Infinity; } continue; }
        const a = (-h - lo[k]!) / ld[k]!, c = (h - lo[k]!) / ld[k]!;
        t0 = Math.max(t0, Math.min(a, c)); t1 = Math.min(t1, Math.max(a, c));
      }
      if (t0 <= t1 && t0 > 0) t = t0;
    }
    if (!(t > 0)) return;
    if (t < best) { second = best; best = t; id = i + 1; } else if (t < second) second = t;
  });
  return second - best < 0.05 ? -1 : id;
}

function rayAt(f: FrameParams, px: number, py: number): { o: V3; d: V3 } {
  const inv = invert(f.viewProj);
  const nx = ((px + 0.5) / W) * 2 - 1, ny = 1 - ((py + 0.5) / H) * 2;
  const a = transform(inv, [nx, ny, 0]), b = transform(inv, [nx, ny, 1]);
  const pa = [a[0] / a[3], a[1] / a[3], a[2] / a[3]], pb = [b[0] / b[3], b[1] / b[3], b[2] / b[3]];
  const d = pb.map((x, k) => x - pa[k]!);
  const l = Math.hypot(...d);
  return { o: f.eye, d: d.map((x) => x / l) as V3 };
}

/** Rotated boxes and slabs, intersecting each other, plus a sphere, viewed at an angle. */
function probeScene(seed: number): BodyDesc[] {
  const r = rng(seed);
  const out: BodyDesc[] = [];
  for (let i = 0; i < 40; i++) out.push(box([(r() - 0.5) * 7, (r() - 0.5) * 5, (r() - 0.5) * 7], [0.4 + r(), 0.3 + r() * 0.5, 0.4 + r() * 1.5], randomQuat(r), i));
  out.push(ball([1, 2, 0], 1.3));
  return out;
}

/** ID pixels at probes away from edges (stable under a 2 px shift) must equal the CPU raycast. */
export async function idProbes(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = probeScene(seed);
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  const f = camera([9, 5, 10], [0, 0, 0]);
  const { ids } = await rend.renderIds(f);
  let probes = 0, mismatches = 0, hitProbes = 0;
  const examples: string[] = [];
  for (let py = 3; py < H - 3; py += 4) for (let px = 3; px < W - 3; px += 4) {
    const want = raycast(descs, ...Object.values(rayAt(f, px, py)) as [V3, V3]);
    const stable = want >= 0 && [[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => raycast(descs, ...Object.values(rayAt(f, px + dx!, py + dy!)) as [V3, V3]) === want);
    if (!stable) continue;
    probes++;
    if (want) hitProbes++;
    const got = ids[py * W + px]!;
    if (got !== want) { mismatches++; if (examples.length < 5) examples.push(`(${px},${py}) gpu ${got} cpu ${want}`); }
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  const covered = ids.reduce((a, v) => a + (v ? 1 : 0), 0) / ids.length;
  return { probes, hitProbes, mismatches, examples, covered, error: err?.message ?? null };
}

function diffIds(a: Uint32Array, b: Uint32Array): number {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++;
  return n;
}

/** A dense random cloud around the camera: culling must not change a single ID pixel. */
export async function cullInvariance(seed: number, count: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  for (let i = 0; i < count; i++) {
    const p: V3 = [(r() - 0.5) * 80, (r() - 0.5) * 30, (r() - 0.5) * 80];
    descs.push(r() < 0.05 ? ball(p, 0.3 + r()) : box(p, [0.2 + r() * 0.5, 0.2 + r() * 0.5, 0.2 + r() * 2], randomQuat(r), i));
  }
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  const f = camera([3, 2, 1], [20, -3, 9]);
  const culled = await rend.renderIds(f);
  const counts = new Uint32Array(await readBuffer(device, rend.cullBuffers!.args));
  const all = await rend.renderIds({ ...f, noCull: true });
  const drawn = new Set(culled.ids).size - 1;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { diff: diffIds(culled.ids, all.ids), drawnBoxes: counts[1]!, drawnSpheres: counts[5]!, distinctOnScreen: drawn, error: err?.message ?? null };
}

/** prev = A, current = B: alpha 0 draws A, alpha 1 draws B, alpha 0.5 lands halfway. */
export async function interpolation(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const a = probeScene(seed);
  const b = a.map((d, i) => ({ ...d, pos: [d.pos[0] + (i === 0 ? 2 : 0.2), d.pos[1] + 0.1, d.pos[2]] as V3, rot: i % 2 ? d.rot : randomQuat(rng(seed + i)) }));
  const f = camera([9, 5, 10], [0, 0, 0]);
  const rend = new Renderer(device, { size: [W, H] });
  const only = async (descs: BodyDesc[]) => {
    const s = new SnapshotSource(device);
    s.update(snapshotOf(descs), descs);
    rend.setSource(s);
    return (await rend.renderIds({ ...f, alpha: 1 })).ids;
  };
  const idsA = await only(a), idsB = await only(b);
  // Three updates, so prev must come from the GPU copy of the second, not the first write.
  const z = a.map((d) => ({ ...d, pos: [d.pos[0], d.pos[1] + 1, d.pos[2]] as V3 }));
  const both = new SnapshotSource(device);
  both.update(snapshotOf(z), a);
  both.update(snapshotOf(a), a);
  both.update(snapshotOf(b), a);
  rend.setSource(both);
  const at = async (alpha: number) => (await rend.renderIds({ ...f, alpha })).ids;
  const i0 = await at(0), i1 = await at(1);
  // Centroid of body 0's pixels (slot + 1 = 1) at alpha 0, 0.5, 1, with body 0 alone moving 2 m.
  const solo = new SnapshotSource(device);
  solo.update(snapshotOf([a[0]!]), [a[0]!]);
  solo.update(snapshotOf([b[0]!]), [b[0]!]);
  rend.setSource(solo);
  const centroid = (ids: Uint32Array) => {
    let sx = 0, n = 0;
    ids.forEach((v, k) => { if (v === 1) { sx += k % W; n++; } });
    return n ? sx / n : NaN;
  };
  const c0 = centroid(await at(0)), c5 = centroid(await at(0.5)), c1 = centroid(await at(1));
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { diff0: diffIds(i0, idsA), diff1: diffIds(i1, idsB), pixels: W * H, c0, c5, c1, error: err?.message ?? null };
}

/**
 * The same state through SnapshotSource and through a GPU engine's own
 * buffers (GpuBodySource): identical IDs. Steady-state GPU frames upload at
 * most 1 KB (uniforms only).
 */
export async function gpuSource(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = probeScene(seed);
  const f = camera([9, 5, 10], [0, 0, 0]);
  const rend = new Renderer(device, { size: [W, H] });
  const snap = new SnapshotSource(device);
  snap.update(snapshotOf(descs), descs);
  rend.setSource(snap);
  const idsSnap = (await rend.renderIds(f)).ids;

  const engine = makeGpuBodies(device, descs, descs.length + 8);
  const src = new GpuBodySource(engine, descs);
  src.describe(descs);
  rend.setSource(src);
  await rend.render(f); // warm-up: culler and bind groups built here
  let bytes = 0, calls = 0;
  const q = device.queue, orig = q.writeBuffer.bind(q);
  q.writeBuffer = ((buffer: GPUBuffer, offset: number, data: BufferSource, dataOffset?: number, size?: number) => {
    calls++;
    bytes += size ?? (data as ArrayBufferView).byteLength ?? (data as ArrayBuffer).byteLength;
    return orig(buffer, offset, data, dataOffset, size);
  }) as typeof q.writeBuffer;
  const FRAMES = 10;
  for (let i = 0; i < FRAMES; i++) {
    src.beforeStep();
    await rend.render({ ...f, alpha: i / FRAMES });
  }
  q.writeBuffer = orig;
  const idsGpu = (await rend.renderIds(f)).ids;
  const [cur, prev] = await Promise.all([readBuffer(device, engine.bodies), readBuffer(device, src.prev)]);
  const prevEqual = new Uint32Array(cur).every((x, i) => x === new Uint32Array(prev)[i]);
  const err = await device.popErrorScope();
  rend.destroy();
  src.destroy();
  device.destroy();
  return { diff: diffIds(idsSnap, idsGpu), prevEqual, bytesPerFrame: bytes / FRAMES, callsPerFrame: calls / FRAMES, error: err?.message ?? null };
}

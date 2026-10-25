// Drivers that run inside the browser page (bundled by render.test.ts). Each
// checks GPU output against a CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { emptySnapshot, TAG_BALL, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { createDevice, readBuffer } from '@tb/gpu';
import { Body, RenderRecord, Shape, TIER, readStruct } from '@tb/schema';
import {
  agx, AGX_WGSL, fromHalf, FX_WORDS, packFx, toHalf, bevelNormal, BEVEL_WGSL, oklabToLinear, OKLAB_WGSL, Post,
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
  return { viewProj: multiply(perspective(0.9, aspect, 0.1, 400), lookAt(eye, target)), eye, groundY: -100 };
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

export interface CullCase { seed: number; count: number; capacity: number; alpha: number; noCull: boolean; fx?: boolean }

/**
 * Random world: boxes, slabs and spheres scattered around the camera (so
 * every frustum plane cuts some), lattice and free tiers, and prev
 * states that are valid, teleported, tier-changed or zeroed. With fx, a
 * third of the bodies get an FX scale (some 0, i.e. hidden), half anchored.
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
    const fx = new Uint32Array(c.capacity * FX_WORDS);
    const BW = Body.size / 4, SW = Shape.size / 4;
    for (let i = 0; i < c.count; i++) {
      const sphere = r() < 0.1;
      const half = sphere ? [0.3 + r(), 0, 0] : [0.1 + r(), 0.1 + r() * 0.5, 0.1 + r() * 2];
      sf.set([half[0]!, sphere ? half[0]! : half[1]!, sphere ? half[0]! : half[2]!], i * SW);
      su[i * SW + 3] = sphere ? 1 : 0;
      const pos = [(r() - 0.5) * 120, (r() - 0.5) * 60, (r() - 0.5) * 120];
      const rot = randomQuat(r);
      const t = r();
      const tier = t < 0.05 ? TIER.lattice : t < 0.08 ? TIER.free : t < 0.2 ? TIER.rubble : TIER.active;
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
      if (c.fx && r() < 0.33) packFx({ scale: r() < 0.15 ? 0 : 0.2 + 0.8 * r(), anchor: r() < 0.5, emissive: r() }, fx, i * FX_WORDS);
    }
    const src = rawSource(device, bodies, prev, shapes, looks, c.count, c.capacity);
    const fxBuf = device.createBuffer({ size: Math.max(16, fx.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(fxBuf, 0, fx);
    const culler = new Culler(device, src, { box: BOX_VERTS, sphere: SPHERE_VERTS }, fxBuf);
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
    const ref = cullReference({ bodies, prev, shapes, looks, count: c.count, fx }, f);
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
    for (const b of [src.bodies, src.prev, src.shapes, src.looks, fxBuf]) b.destroy();
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

// ---------------------------------------------------------------- faces

/** Face code (1 + 2 * axis + negative) of where a ray enters an AABB, 0 for a miss. */
function aabbFace(lo: V3, hi: V3, o: V3, d: V3): number {
  let t0 = -Infinity, t1 = Infinity, face = 0;
  for (let k = 0; k < 3; k++) {
    if (Math.abs(d[k]!) < 1e-12) { if (o[k]! < lo[k]! || o[k]! > hi[k]!) return 0; continue; }
    const a = (lo[k]! - o[k]!) / d[k]!, b = (hi[k]! - o[k]!) / d[k]!;
    const near = Math.min(a, b);
    if (near > t0) { t0 = near; face = 1 + 2 * k + (d[k]! > 0 ? 1 : 0); }
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t0 <= t1 && t0 > 0 ? face : 0;
}

/**
 * A gap-free F x F x H tower of unit cubes is exactly an AABB, so every
 * pixel's visible face is known. Pixels whose 3x3 neighbourhood sees one
 * face (away from the silhouette and the tower's own edges) must show that
 * face, and the box shader must name the same face anywhere within half a
 * pixel (unstable otherwise). Off-centre eyes put the cubes' shared edges
 * at arbitrary sub-pixel positions.
 */
export async function towerFaces() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const F = 6, Ht = 10, ox = 0.37, oz = -0.21;
  const descs: BodyDesc[] = [];
  for (let y = 0; y < Ht; y++) for (let x = 0; x < F; x++) for (let z = 0; z < F; z++) descs.push(box([ox + x - (F - 1) / 2, 0.5 + y, oz + z - (F - 1) / 2], [0.5, 0.5, 0.5], [0, 0, 0, 1]));
  const lo: V3 = [ox - F / 2, 0, oz - F / 2], hi: V3 = [ox + F / 2, Ht, oz + F / 2];
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  let checked = 0, wrong = 0, unstable = 0;
  const examples: string[] = [];
  for (const eye of [[17.3, 9.1, 21.7], [-23.9, 14.2, 19.4], [29.1, 4.3, -11.8], [-8.6, 22.5, -31.3]] as V3[]) {
    const f = camera(eye, [ox, Ht / 2, oz]);
    const { ids: faces } = await rend.renderIds(f, true);
    const want = new Uint8Array(W * H);
    for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) want[py * W + px] = aabbFace(lo, hi, ...Object.values(rayAt(f, px, py)) as [V3, V3]);
    for (let py = 1; py < H - 1; py++) for (let px = 1; px < W - 1; px++) {
      const w = want[py * W + px]!;
      if (!w || [-1, 0, 1].some((dy) => [-1, 0, 1].some((dx) => want[(py + dy) * W + px + dx] !== w))) continue;
      checked++;
      const got = faces[py * W + px]!;
      if (got === 15) unstable++;
      else if (got !== w) wrong++;
      if (got !== w && examples.length < 5) examples.push(`eye ${eye} (${px},${py}) face ${got} want ${w}`);
    }
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { checked, wrong, unstable, examples, error: err?.message ?? null };
}


// ---------------------------------------------------------------- look twins

/** Run WGSL fn(vec4f x 3) -> vec4f over n inputs on the GPU. */
async function mapGpu(device: GPUDevice, lib: string, body: string, inputs: Float32Array, n: number): Promise<Float32Array> {
  const code = `${lib}
@group(0) @binding(0) var<storage, read> xs: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> ys: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  if (i >= ${n}u) { return; }
  let a = xs[3u * i]; let b = xs[3u * i + 1u]; let c = xs[3u * i + 2u];
  ${body}
}`;
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module: device.createShaderModule({ code }), entryPoint: 'main' } });
  const xs = device.createBuffer({ size: inputs.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(xs, 0, inputs);
  const ys = device.createBuffer({ size: n * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: xs } }, { binding: 1, resource: { buffer: ys } }] }));
  pass.dispatchWorkgroups(Math.ceil(n / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const out = new Float32Array(await readBuffer(device, ys));
  xs.destroy();
  ys.destroy();
  return out;
}

/**
 * The colour and bevel WGSL against their TypeScript twins (look.ts), on
 * random inputs: AgX over 1e-5..1e3 linear HDR (and zero), OKLab around
 * the ramp colours, bevel normals over random boxes, faces, pixel sizes
 * and radii. Returns the largest absolute difference of each.
 */
export async function lookTwins(seed: number, n = 4096) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const f32 = Math.fround;
  const pack = (rows: number[][][]) => new Float32Array(rows.flatMap((abc) => abc.flatMap((v) => [v[0] ?? 0, v[1] ?? 0, v[2] ?? 0, v[3] ?? 0]).map(f32)));
  const hdr = () => (r() < 0.02 ? 0 : 10 ** (r() * 8 - 5));
  // AgX
  const agxIn = Array.from({ length: n }, () => [[hdr(), hdr(), hdr()], [], []]);
  const agxGpu = await mapGpu(device, AGX_WGSL, 'ys[i] = vec4f(agx(a.xyz), 0.0);', pack(agxIn), n);
  let agxErr = 0;
  agxIn.forEach(([c], i) => agx(c!.map(f32) as V3).forEach((v, k) => { agxErr = Math.max(agxErr, Math.abs(v - agxGpu[4 * i + k]!)); }));
  // OKLab
  const labIn = Array.from({ length: n }, () => [[0.3 + 0.7 * r(), (r() - 0.5) * 0.4, (r() - 0.5) * 0.4], [], []]);
  const labGpu = await mapGpu(device, OKLAB_WGSL, 'ys[i] = vec4f(oklabToLinear(a.xyz), 0.0);', pack(labIn), n);
  let labErr = 0;
  labIn.forEach(([c], i) => oklabToLinear(c!.map(f32) as V3).forEach((v, k) => { labErr = Math.max(labErr, Math.abs(v - labGpu[4 * i + k]!)); }));
  // Bevel
  const bevIn = Array.from({ length: n }, () => {
    const half = [0.05 + r() * 1.5, 0.05 + r() * 1.5, 0.05 + r() * 1.5];
    const axis = Math.floor(r() * 3), sgn = r() < 0.5 ? -1 : 1;
    const faceN = [0, 0, 0];
    faceN[axis] = sgn;
    const lp = half.map((h, k) => (k === axis ? sgn * h : (r() * 2 - 1) * h));
    return [lp, faceN, [...half, 10 ** (r() * 4 - 4)], [r() < 0.5 ? 0.06 : 0.005 + r() * 0.2]];
  });
  const bevPacked = new Float32Array(bevIn.flatMap(([lp, fn, hp, rb]) => [...lp!, rb![0]!, ...fn!, 0, ...hp!]).map(f32));
  const bevGpu = await mapGpu(device, BEVEL_WGSL, 'ys[i] = vec4f(bevelNormal(a.xyz, b.xyz, c.xyz, c.w, a.w), 0.0);', bevPacked, n);
  let bevErr = 0;
  bevIn.forEach(([lp, fn, hp, rb], i) => {
    const want = bevelNormal(lp!.map(f32) as V3, fn as V3, hp!.slice(0, 3).map(f32) as V3, f32(hp![3]!), f32(rb![0]!));
    want.forEach((v, k) => { bevErr = Math.max(bevErr, Math.abs(v - bevGpu[4 * i + k]!)); });
  });
  const err = await device.popErrorScope();
  device.destroy();
  return { agxErr, labErr, bevErr, error: err?.message ?? null };
}

// ---------------------------------------------------------------- bloom

/**
 * One bright pixel through the bloom pyramid. Without Karis weighting
 * every filter preserves the mean, so levels[0] (the sum of all levels)
 * divided by the level count has the input's mean; the glow falls off
 * monotonically from the pixel; nothing is NaN or infinite.
 */
export async function bloomEnergy(karis: boolean) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const w = 256, h = 192, cx = 128, cy = 96, value = 1000;
  const hdr = device.createTexture({ size: [w, h], format: 'rgba16float', usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT });
  const px = new Uint16Array(w * h * 4);
  for (let i = 0; i < w * h; i++) px[4 * i + 3] = toHalf(1);
  px.set([toHalf(value), toHalf(value), toHalf(value)], 4 * (cy * w + cx));
  device.queue.writeTexture({ texture: hdr }, px, { bytesPerRow: w * 8 }, [w, h]);
  const post = new Post(device, 'rgba8unorm');
  const enc = device.createCommandEncoder();
  post.encodeBloom(enc, hdr, karis);
  const top = post.levels[0]!;
  const bpr = Math.ceil((top.width * 8) / 256) * 256;
  const read = device.createBuffer({ size: bpr * top.height, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  enc.copyTextureToBuffer({ texture: top }, { buffer: read, bytesPerRow: bpr }, [top.width, top.height]);
  device.queue.submit([enc.finish()]);
  await read.mapAsync(GPUMapMode.READ);
  const raw = new Uint16Array(read.getMappedRange());
  const at = (x: number, y: number) => fromHalf(raw[(y * bpr) / 2 + 4 * x]!);
  let sum = 0, finite = true;
  for (let y = 0; y < top.height; y++) for (let x = 0; x < top.width; x++) { const v = at(x, y); sum += v; if (!Number.isFinite(v)) finite = false; }
  const meanRatio = sum / (top.width * top.height) / post.levels.length / (value / (w * h));
  // Outward from the peak along the row and column through it: never rising.
  const tx = cx / 2, ty = cy / 2;
  let rises = 0;
  for (let x = tx + 1; x < top.width; x++) if (at(x, ty) > at(x - 1, ty) * 1.001 + 1e-6) rises++;
  for (let x = tx - 2; x >= 0; x--) if (at(x, ty) > at(x + 1, ty) * 1.001 + 1e-6) rises++;
  for (let y = ty + 1; y < top.height; y++) if (at(tx, y) > at(tx, y - 1) * 1.001 + 1e-6) rises++;
  const levels = post.levels.length;
  read.destroy();
  post.destroy();
  hdr.destroy();
  const err = await device.popErrorScope();
  device.destroy();
  return { meanRatio, rises, finite, levels, error: err?.message ?? null };
}

// ---------------------------------------------------------------- fx

/** Probe mismatches between the ID image and a CPU raycast of descs (probes stable under a 2 px shift). */
function probeMismatches(ids: Uint32Array, f: FrameParams, descs: BodyDesc[]) {
  let probes = 0, hits = 0, mismatches = 0;
  const examples: string[] = [];
  for (let py = 3; py < H - 3; py += 2) for (let px = 3; px < W - 3; px += 2) {
    const want = raycast(descs, ...Object.values(rayAt(f, px, py)) as [V3, V3]);
    const stable = want >= 0 && [[2, 0], [-2, 0], [0, 2], [0, -2]].every(([dx, dy]) => raycast(descs, ...Object.values(rayAt(f, px + dx!, py + dy!)) as [V3, V3]) === want);
    if (!stable) continue;
    probes++;
    if (want) hits++;
    if (ids[py * W + px] !== want) { mismatches++; if (examples.length < 5) examples.push(`(${px},${py}) gpu ${ids[py * W + px]} cpu ${want}`); }
  }
  return { probes, hits, mismatches, examples };
}

/**
 * FX scale through the renderer: hidden (scale 0), centre-scaled, and
 * base-anchored bodies, set one by one and in bulk, must draw exactly as
 * the CPU raycast of the bodies with those sizes and positions; clearFx
 * restores the original image.
 */
export async function fxScale(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  for (let i = 0; i < 24; i++) descs.push(box([(r() - 0.5) * 8, (r() - 0.5) * 4, (r() - 0.5) * 8], [0.4 + r() * 0.6, 0.4 + r() * 0.8, 0.4 + r() * 0.6], randomQuat(r)));
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  const f = camera([9, 5, 10], [0, 0, 0]);
  const before = (await rend.renderIds(f)).ids;
  // What the CPU expects: scaled halves; anchored bodies keep their base (body -y face).
  const scaled = descs.map((b, i) => {
    const s = i % 4 === 0 ? 0 : i % 4 === 1 ? 0.6 : i % 4 === 2 ? 0.45 : 1;
    const anchor = i % 4 === 2;
    if (b.shape.kind !== 'box') return b;
    const half = b.shape.half.map((h) => h * s) as V3;
    const [x, y, z, w] = b.rot;
    const up = [2 * (x * y - w * z), 1 - 2 * (x * x + z * z), 2 * (y * z + w * x)];
    const pos = anchor ? b.pos.map((p, k) => p - (b.shape.kind === 'box' ? (b.shape.half[1]! - half[1]!) : 0) * up[k]!) as V3 : b.pos;
    return { ...b, pos, shape: { kind: 'box' as const, half } };
  }).filter((_, i) => i % 4 !== 0);
  const slotOf = descs.map((_, i) => i).filter((i) => i % 4 !== 0);
  // Single-slot calls for hidden and centre-scaled, one bulk call for the anchored ones.
  for (let i = 0; i < descs.length; i++) if (i % 4 === 0) rend.setFx(i, { scale: 0 }); else if (i % 4 === 1) rend.setFx(i, { scale: 0.6 });
  for (let i = 2; i < descs.length; i += 4) rend.setFx(i, null, new Float32Array([0.45]), true);
  const { ids } = await rend.renderIds(f);
  const remapped = ids.map((v) => (v ? slotOf.indexOf(v - 1) + 1 : 0));
  const scaledCheck = probeMismatches(remapped, f, scaled);
  let hiddenSeen = 0;
  for (const v of ids) if (v && (v - 1) % 4 === 0) hiddenSeen++;
  rend.clearFx(0, descs.length);
  const after = (await rend.renderIds(f)).ids;
  let restored = 0;
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) restored++;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { ...scaledCheck, hiddenSeen, restoreDiff: restored, error: err?.message ?? null };
}

/**
 * Tint, glow, flash and overlay in the final image: mean colour of one box's
 * pixels (from the ID mask) under each effect, and overlay spheres in front
 * of and behind the box.
 */
export async function fxColour() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([0, 0, 0], [1, 1, 1], [0, 0, 0, 1])];
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  const f = { ...camera([4, 3, 5], [0, 0, 0]), time: 10 };
  const mask = (await rend.renderIds(f)).ids;
  const mean = async () => {
    const st = (await rend.render(f, true, true))!;
    const { data, bytesPerRow, bgra } = st.pixels!;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const o = y * bytesPerRow + 4 * x;
      const px = bgra ? [data[o + 2]!, data[o + 1]!, data[o]!] : [data[o]!, data[o + 1]!, data[o + 2]!];
      px.forEach((v, k) => { sum[k]! += v; });
      n++;
    }
    return sum.map((v) => v / n);
  };
  const plain = await mean();
  rend.setFx(0, { tint: [1, 0.15, 0.15] });
  const red = await mean();
  rend.setFx(0, { emissive: 0.5 });
  const glow = await mean();
  rend.setFx(0, { emissive: 0.5, flash: 1, flashAt: 9.5 });
  const flashMid = await mean();
  rend.setFx(0, { emissive: 0.5, flash: 1, flashAt: 5 });
  const flashDone = await mean();
  rend.clearFx(0);
  // Overlay: a glowing sphere hidden behind the box changes nothing; one in front of it shows.
  const pix = async () => (await rend.render(f, true, true))!.pixels!;
  const base = await pix();
  rend.setOverlay(new Float32Array([-2.5, -1.8, -3, 0.3]), new Uint32Array([0xff0000ff]));
  const withBack = await pix();
  rend.setOverlay(new Float32Array([2.5, 2, 3.8, 0.3]), new Uint32Array([0xff00ff00]));
  const withFront = await pix();
  // Where the front sphere's centre projects, the image must change; the hidden one changes nothing it covers.
  const project = (p: V3) => {
    const c = transform(f.viewProj, p);
    return [Math.floor(((c[0] / c[3]) * 0.5 + 0.5) * W), Math.floor((0.5 - (c[1] / c[3]) * 0.5) * H)] as const;
  };
  const at = (px: { data: number[]; bytesPerRow: number }, [x, y]: readonly [number, number]) => [0, 1, 2].map((k) => px.data[y * px.bytesPerRow + 4 * x + k]!);
  const front = project([2.5, 2, 3.8]), back = project([-2.5, -1.8, -3]);
  const frontDelta = Math.max(...at(withFront, front).map((v, k) => Math.abs(v - at(base, front)[k]!)));
  const backDelta = Math.max(...at(withBack, back).map((v, k) => Math.abs(v - at(base, back)[k]!)));
  const backBehindBox = mask[back[1] * W + back[0]] !== 0;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { plain, red, glow, flashMid, flashDone, frontDelta, backDelta, backBehindBox, error: err?.message ?? null };
}

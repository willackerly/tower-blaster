export { runRenderBench, renderBenchMarkdown } from '../src/bench.ts';

// Drivers that run inside the browser page (bundled by render.test.ts). Each
// checks GPU output against a CPU reference in the page and returns a small
// summary, so large arrays never cross the Playwright boundary.
import { emptySnapshot, TAG_BALL, type BodyDesc, type Snapshot } from '@tb/engine-api';
import { createDevice, readBuffer } from '@tb/gpu';
import { Body, RenderRecord, Shape, TIER, readStruct } from '@tb/schema';
import {
  agx, AGX_WGSL, LOOKS, realLook, type RealOptions, type LookParams, fromHalf, Atmosphere, CLEAR_DAY, transmittance, transmittanceHMu, multiScattering, skyViewDir, skyRadiance, skyViewUv, sampleTransmittance, ambientOf, distanceToGround, meteredIlluminance, Materials, MATERIAL_TILE, heightNormal, STONES, stoneSample, adaptedExposure, LUMA, R_TOP, R_GROUND, FX_WORDS, packFx, toHalf, bevelNormal, BEVEL_WGSL, oklabToLinear, OKLAB_WGSL, Post,
  Culler, cullReference, GpuBodySource, invert, listMatches, lookAt, makeGpuBodies, multiply, packBodies, perspective, Renderer, SEGMENTS, SnapshotSource, transform,
  translation, normalize, BOX_VERTS, SPHERE_VERTS, SUN, Sparks, CTL, MAX_EVENTS, flashSlot, FLASHES, MAX_BALLS, TRAIL, Lights, LIGHTS, LIGHT_META, LIGHT_PACKED, MATERIAL, AoVolume, aoGrid, aoFrame, splatReference, composeReference, AO_FOOT_WGSL, AO_SAMPLE_WGSL, AO_SEAM_WGSL, AO_ONE, type SplatBody, unpackImpacts, unpackSparks, spawnReference, stepReference, type Impact, type BodySource, type CullFrame, type FrameParams, type RendererOptions, type V3,
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

function qrotV(q: number[], v: number[]): number[] {
  return qrotInv([-q[0]!, -q[1]!, -q[2]!, q[3]!], v);
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

/**
 * SnapshotSource with Snapshot.tier: after each update the GPU Body[] equals
 * a full pack of the snapshot, while only new, active and re-tiered slots
 * are uploaded. Dormant (lattice-tier) bodies are still drawn.
 */
export async function tierUploads(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  for (let i = 0; i < 200; i++) descs.push(box([(i % 20) - 10, 0.5 + Math.floor(i / 20), 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], i));
  descs.push(ball([0, 3, 4], 1));
  const src = new SnapshotSource(device);
  const s = snapshotOf(descs.slice(0, 200));
  s.tier = new Uint8Array(200).fill(TIER.lattice);
  s.awake.fill(0);
  const steps: Array<{ uploaded: number; equal: boolean }> = [];
  const check = async (snap: Snapshot) => {
    src.update(snap, descs);
    const got = new Uint8Array(await readBuffer(device, src.bodies)).subarray(0, snap.count * Body.size);
    const want = new Uint8Array(packBodies(snap, descs), 0, snap.count * Body.size);
    steps.push({ uploaded: src.uploaded, equal: got.every((x, i) => x === want[i]) });
  };
  await check(s); // first: everything
  const t = structuredClone(s);
  for (const i of [5, 77, 150]) { t.tier![i] = TIER.active; t.pos[3 * i + 1]! += r(); t.awake[i] = 1; }
  await check(t); // three woken
  const u = structuredClone(t);
  u.tier![77] = TIER.rubble; u.pos[3 * 5]! += 0.25;
  await check(u); // 5 moves, 77 freezes, 150 still active
  const v = { ...structuredClone(u), count: 201 };
  for (const k of ['pos', 'rot', 'linVel', 'angVel'] as const) { const a = new Float64Array(201 * (k === 'rot' ? 4 : 3)); a.set(u[k]); v[k] = a; }
  v.pos.set(descs[200]!.pos, 600); v.rot.set([0, 0, 0, 1], 800);
  v.awake = Uint8Array.from([...u.awake, 1]); v.tier = Uint8Array.from([...u.tier!, TIER.active]);
  await check(v); // a spawned ball
  const rend = new Renderer(device, { size: [W, H] });
  rend.setSource(src);
  const { ids } = await rend.renderIds(camera([0, 6, 30], [0, 5, 0]));
  const drawn = new Set(ids);
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { steps, dormantDrawn: [0, 10, 199].map((i) => drawn.has(i + 1)), error: err?.message ?? null };
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
    const { data, bytesPerRow } = st.pixels!;
    const sum = [0, 0, 0];
    let n = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      if (!mask[y * W + x]) continue;
      const o = y * bytesPerRow + 4 * x;
      const px = [data[o]!, data[o + 1]!, data[o + 2]!];
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

// ---------------------------------------------------------------- hexagon fan

/**
 * The 18-vertex hexagon fan against the 36-vertex cube: boxes, slabs and
 * rods at random rotations, seen from cameras among them (so many eyes sit
 * inside a box's slab on some axis, where the fan includes a face seen
 * edge-on or from behind). Returns the fraction of ID pixels that differ,
 * and the shadow maps' texel differences.
 */
export async function fanVsCube(seed: number, cameras = 50) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const descs: BodyDesc[] = [];
  for (let i = 0; i < 60; i++) {
    const k = i % 3; // cube-ish, slab, rod
    const half: V3 = k === 0 ? [0.3 + r() * 0.5, 0.3 + r() * 0.5, 0.3 + r() * 0.5] : k === 1 ? [0.8 + r(), 0.05 + r() * 0.1, 0.6 + r()] : [0.06 + r() * 0.1, 1 + r() * 1.5, 0.06 + r() * 0.1];
    descs.push(box([(r() - 0.5) * 12, (r() - 0.5) * 6, (r() - 0.5) * 12], half, randomQuat(r)));
  }
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const fan = new Renderer(device, { size: [W, H] });
  const cube = new Renderer(device, { size: [W, H] }, { boxPath: 'cube' });
  for (const rend of [fan, cube]) { rend.setSource(src); rend.setShadowBounds([0, 0, 0], 10); }
  let differ = 0, pixels = 0, covered = 0;
  for (let c = 0; c < cameras; c++) {
    const eye: V3 = [(r() - 0.5) * 14, (r() - 0.5) * 7, (r() - 0.5) * 14];
    const f = camera(eye, [(r() - 0.5) * 4, (r() - 0.5) * 2, (r() - 0.5) * 4]);
    const a = (await fan.renderIds(f)).ids, b = (await cube.renderIds(f)).ids;
    for (let i = 0; i < a.length; i++) { if (a[i] !== b[i]) differ++; if (b[i]) covered++; }
    pixels += a.length;
  }
  // Shadow maps from the same frame. Where both maps see a caster the depths
  // differ only by interpolation (the two triangulate each face differently,
  // and vertices snap to the sub-texel grid, which tilts thin triangles), or
  // where the two disagree about which of two touching surfaces is nearer.
  // Compared in metres against the receiver's depth bias (at least 1 cm):
  // anything below it cannot change a shadow.
  const f = camera([9, 5, 10], [0, 0, 0]);
  await fan.render(f);
  await cube.render(f);
  const sa = await fan.readShadowMap(), sb = await cube.readShadowMap();
  const range = fan.shadowFit!.depthRange;
  let texels = 0, coverDiff = 0, over1mm = 0, over1cm = 0, maxDiff = 0;
  for (let i = 0; i < sa.length; i++) {
    if (sb[i]! >= 1 && sa[i]! >= 1) continue;
    texels++;
    if (sa[i]! >= 1 || sb[i]! >= 1) { coverDiff++; continue; }
    const d = Math.abs(sa[i]! - sb[i]!) * range;
    if (d > 0.001) over1mm++;
    if (d > 0.01) over1cm++;
    else maxDiff = Math.max(maxDiff, d);
  }
  const err = await device.popErrorScope();
  fan.destroy();
  cube.destroy();
  device.destroy();
  return { differ, pixels, covered, texels, coverDiff, over1mm, over1cm, maxDiff, error: err?.message ?? null };
}

// ---------------------------------------------------------------- shadows

/**
 * Shadows against an analytic reference: a ground pixel is in shadow exactly
 * when the ray from its ground point towards the sun hits a body. Cases:
 * 'float' a cube 3 m up, seen from above (position and shape of the shadow);
 * 'contact' a cube resting on the ground, close up on its shadowed corner
 * (no light leaking between cube and shadow); 'grazing' a slab lit at 80
 * degrees from its normal (no acne on the lit face).
 */
export interface ShadowCheckOptions {
  /** Output format (bgra8unorm is Apple's preferred). */
  format?: GPUTextureFormat;
}

export async function shadowCheck(kind: 'float' | 'contact' | 'grazing', { format }: ShadowCheckOptions = {}) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const sun = SUN;
  const descs: BodyDesc[] = [];
  let f: FrameParams;
  if (kind === 'float') {
    descs.push(box([0, 3.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1]));
    f = { ...camera([1.5, 12, -1.2], [1.5, 0, -0.8]), groundY: 0 };
  } else if (kind === 'contact') {
    descs.push(box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1]));
    f = { ...camera([-1.3, 2.2, 1.1], [-0.8, 0, 0.7]), groundY: 0 };
  } else {
    // Tilt the slab's normal away from the sun until N.L = 0.17.
    const h = Math.hypot(sun[0], sun[2]), axis: V3 = [sun[2] / h, 0, -sun[0] / h]; // up x sun, normalised
    const phi = -(Math.acos(0.17) - Math.atan2(h, sun[1]));
    const s = Math.sin(phi / 2);
    descs.push(box([0, 2, 0], [2, 0.05, 2], [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(phi / 2)]));
    f = { ...camera([0.3, 7, 0.4], [0, 2, 0]), groundY: -5 };
  }
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] }, { format });
  rend.look = { ...rend.look, floorGrid: 0, fogDensity: 0, bloomMix: 0, vignette: 0 };
  rend.setSource(src);
  rend.setShadowBounds([0, 2, 0], 8);
  const ids = (await rend.renderIds(f)).ids;
  const px = (await rend.render(f, true, true))!.pixels!;
  const luma = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * px.bytesPerRow + 4 * x;
    luma[y * W + x] = 0.2126 * px.data[o]! + 0.7152 * px.data[o + 1]! + 0.0722 * px.data[o + 2]!;
  }
  // Surface point and analytic visibility of each pixel's surface.
  const want = new Int8Array(W * H).fill(-1); // 1 shadowed, 0 lit, -1 not used
  const ground: (V3 | null)[] = new Array(W * H).fill(null);
  const target = kind === 'grazing' ? 1 : 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x;
    if (ids[i] !== target) continue;
    const { o, d } = rayAt(f, x, y);
    let p: V3;
    if (target === 0) {
      if (d[1] >= 0) continue;
      const t = (f.groundY - o[1]) / d[1];
      p = [o[0] + d[0] * t, f.groundY, o[2] + d[2] * t];
      ground[i] = p;
    } else {
      // Slab top face: keep its flat interior (the bevel and edges shade differently).
      const b = descs[0]!, half = (b.shape as { half: V3 }).half;
      const lo = qrotInv(b.rot, [o[0] - b.pos[0], o[1] - b.pos[1], o[2] - b.pos[2]]), ld = qrotInv(b.rot, d);
      const t = (half[1] - lo[1]!) / ld[1]!;
      const u = lo[0]! + ld[0]! * t, v = lo[2]! + ld[2]! * t;
      if (!(t > 0) || Math.abs(u) > 0.8 * half[0] || Math.abs(v) > 0.8 * half[2]) continue;
      p = [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t];
    }
    want[i] = target === 1 ? 0 : raycast(descs, [p[0] + sun[0] * 1e-4, p[1] + sun[1] * 1e-4, p[2] + sun[2] * 1e-4], sun) !== 0 ? 1 : 0;
  }
  // Boundary band: pixels next to the other class or to anything unused
  // (body silhouettes blend with MSAA; the shadow edge is PCF-soft).
  const band = (i: number) => {
    const x = i % W, y = (i - x) / W;
    if (x === 0 || y === 0 || x === W - 1 || y === H - 1) return true;
    return [-W - 1, -W, -W + 1, -1, 1, W - 1, W, W + 1].some((o) => want[i + o] !== want[i]);
  };
  const median = (xs: number[]) => (xs.sort((a, b) => a - b), xs[xs.length >> 1] ?? NaN);
  const litL: number[] = [], shadeL: number[] = [];
  for (let i = 0; i < W * H; i++) if (want[i]! >= 0 && !band(i)) (want[i] ? shadeL : litL).push(luma[i]!);
  const lit = median(litL), shaded = median(shadeL);
  const cut = shadeL.length ? (lit + shaded) / 2 : 0.85 * lit; // all lit (grazing): any dark speckle is acne
  // Mismatches away from the band; leak: furthest lit pixel of the predicted
  // shadow from the cube's footprint (light under a resting cube).
  let predicted = 0, measured = 0, both = 0, wrong = 0, leak = 0, maxStep = 0;
  const cen = [[0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < W * H; i++) {
    if (want[i]! < 0) continue;
    const dark = luma[i]! < cut;
    if (want[i]) { predicted++; const g = ground[i]!; cen[0]![0]! += g[0]; cen[0]![1]! += g[2]; cen[0]![2]!++; }
    if (dark) { measured++; const g = ground[i]; if (g) { cen[1]![0]! += g[0]; cen[1]![1]! += g[2]; cen[1]![2]!++; } }
    if (want[i] && dark) both++;
    if (band(i)) continue;
    if (dark !== (want[i] === 1)) {
      wrong++;
      const g = ground[i];
      if (g && want[i]) leak = Math.max(leak, Math.hypot(Math.max(Math.abs(g[0]) - 0.5, 0), Math.max(Math.abs(g[2]) - 0.5, 0)));
    }
    // Acne: speckle between neighbouring pixels of one class.
    for (const o of [1, W]) if (want[i + o] === want[i] && !band(i + o)) maxStep = Math.max(maxStep, Math.abs(luma[i + o]! - luma[i]!));
  }
  const centroid = (c: number[]) => [c[0]! / c[2]!, c[1]! / c[2]!];
  const cp = centroid(cen[0]!), cm = centroid(cen[1]!);
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return {
    lit, shaded, predicted, measured, iou: both / (predicted + measured - both || 1), wrong, used: litL.length + shadeL.length,
    centroidErr: predicted ? Math.hypot(cp[0]! - cm[0]!, cp[1]! - cm[1]!) : 0, leak, maxStep,
    window: rend.shadowFit!.half, NoL: kind === 'grazing' ? qrotV(descs[0]!.rot, [0, 1, 0]).reduce((a, v, k) => a + v * sun[k]!, 0) : null, error: err?.message ?? null,
  };
}

/**
 * The floor in the image against the analytic plane: with no bodies, a red
 * floor and a green sky, every pixel whose ray meets y = groundY before
 * the far plane must be floor and every other pixel sky, away from the
 * horizon (the pixels next to the other class).
 */
export async function floorCoverage(eye: V3, target: V3, groundY: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = new SnapshotSource(device);
  src.update(snapshotOf([]), []);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...rend.look, floor: [1, 0, 0], floorGrid: 0, skyZenith: [0, 0.5, 0], skyHorizon: [0, 0.5, 0], glow: [0, 0, 0], fogDensity: 0, bloomMix: 0, vignette: 0 };
  rend.setSource(src);
  const f: FrameParams = { ...camera(eye, target), groundY };
  const px = (await rend.render(f, true, true))!.pixels!;
  const want = new Int8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const { o, d } = rayAt(f, x, y);
    const t = (groundY - o[1]) / d[1];
    // camera() has its far plane at 400 m along the view axis.
    const view = normalize([target[0] - eye[0], target[1] - eye[1], target[2] - eye[2]]);
    want[y * W + x] = t > 0 && t * (d[0] * view[0] + d[1] * view[1] + d[2] * view[2]) < 400 ? 1 : 0;
  }
  let floor = 0, wrong = 0, checked = 0;
  for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) {
    const i = y * W + x, o = y * px.bytesPerRow + 4 * x;
    if ([-W, -1, 1, W].some((k) => want[i + k] !== want[i])) continue;
    const isFloor = px.data[o]! > px.data[o + 1]!;
    checked++;
    if (want[i]) floor++;
    if (isFloor !== (want[i] === 1)) wrong++;
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { checked, floor, wrong, error: err?.message ?? null };
}

/** Frames at tiny output sizes (a hidden or minimised canvas): no validation error, and the scene still shows. */
export async function tinyFrames(sizes: [number, number][]) {
  const { device } = await createDevice({ timestamps: false });
  const descs = [box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1])];
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const out: { size: [number, number]; meanLuma: number | null; error: string | null }[] = [];
  for (const size of sizes) {
    device.pushErrorScope('validation');
    let thrown: string | null = null, meanLuma: number | null = null;
    try {
      const rend = new Renderer(device, { size });
      rend.setSource(src);
      meanLuma = (await rend.render({ ...camera([2, 2, 3], [0, 0.5, 0], size[0] / size[1]), groundY: 0 }, true))!.meanLuma;
      rend.destroy();
    } catch (e) { thrown = (e as Error).message; }
    const err = await device.popErrorScope();
    out.push({ size, meanLuma, error: thrown ?? err?.message ?? null });
  }
  device.destroy();
  return out;
}

// ---------------------------------------------------------------- sparks

interface RawBody { pos: V3; vel: V3; tier?: number; invMass?: number; shape: number; rot?: [number, number, number, number] }

function bodyWords(bs: RawBody[], capacity: number): ArrayBuffer {
  const out = new ArrayBuffer(capacity * Body.size), f = new Float32Array(out), u = new Uint32Array(out);
  const at = (name: string) => Body.fields.find((x) => x.name === name)!.offset / 4;
  bs.forEach((b, i) => {
    const o = (i * Body.size) / 4;
    f.set(b.pos, o + at('pos'));
    f[o + at('invMass')] = b.invMass ?? 1;
    f.set(b.rot ?? [0, 0, 0, 1], o + at('rot'));
    f.set(b.vel, o + at('linVel'));
    u[o + at('flags')] = 1 | ((b.tier ?? TIER.active) << 8);
    u[o + at('shape')] = b.shape;
  });
  return out;
}

function sparkShapes(): ArrayBuffer {
  const out = new ArrayBuffer(4 * Shape.size), f = new Float32Array(out), u = new Uint32Array(out);
  const halfs: V3[] = [[0.5, 0.5, 0.5], [1, 0.25, 0.5], [0.4, 0.4, 0.4], [0.3, 0.3, 0.3]];
  halfs.forEach((h, i) => { f.set(h, i * 4); u[i * 4 + 3] = i === 2 ? 1 : 0; });
  return out;
}

async function sparkFrame(device: GPUDevice, sp: Sparks, src: BodySource, dt = 0, groundY = -100) {
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  sp.encode(pass, src, { dt, groundY });
  pass.end();
  device.queue.submit([enc.finish()]);
  const ctl = Array.from(new Uint32Array(await readBuffer(device, sp.ctl)));
  return { ctl, events: unpackImpacts(await readBuffer(device, sp.events), Math.min(ctl[CTL.events]!, MAX_EVENTS)) };
}

/**
 * The impact detector against hand-computed events: one step changes ten
 * bodies' velocities, each case either a real impact or one a guard must
 * reject (below threshold, teleport, tier change, static, lattice, shape
 * change, new slots).
 */
export async function sparkDetect() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const cap = 12;
  const base: RawBody[] = Array.from({ length: 10 }, (_, i) => ({ pos: [i * 3, 2, 0] as V3, vel: [0, -1, 0] as V3, shape: 0 }));
  base[7]!.shape = 1;
  base[7]!.rot = [0, 0, Math.SQRT1_2, Math.SQRT1_2]; // 90 degrees about z: local x is world y
  base[8]!.shape = 2; // sphere r 0.4
  const looks = new Uint32Array(cap).map((_, i) => (i % 4) << 12);
  const src = rawSource(device, bodyWords(base, cap), bodyWords(base, cap), sparkShapes(), looks, 10, cap) as BodySource & { count: number };
  const sp = new Sparks(device);
  const first = await sparkFrame(device, sp, src); // first sight of every slot
  const still = await sparkFrame(device, sp, src); // no step: no change
  const next: RawBody[] = base.map((b) => ({ ...b, vel: [...b.vel] as V3, pos: [...b.pos] as V3 }));
  const add = (i: number, dv: V3) => { next[i]!.vel = next[i]!.vel.map((v, k) => v + dv[k]!) as V3; };
  add(0, [5, 0, 0]); // impact
  add(1, [0, 2, 0]); // below dvMin
  add(2, [0, 8, 0]); next[2]!.pos[1] += 5; // teleport
  add(3, [6, 0, 0]); next[3]!.tier = TIER.rubble; // tier change
  add(4, [9, 0, 0]); next[4]!.invMass = 0; // static
  add(5, [9, 0, 0]); next[5]!.tier = TIER.lattice; // dormant cell
  add(6, [9, 0, 0]); next[6]!.shape = 3; // reused slot, new shape
  add(7, [0, 7, 0]); // rotated slab: support 1.0 along y
  add(8, [0, 0, -4]); // sphere
  add(9, [3, 0, 0]); // just above dvMin
  next.push({ pos: [40, 2, 0], vel: [20, 0, 0], shape: 0 }, { pos: [43, 2, 0], vel: [0, 20, 0], shape: 0 }); // spawned this step
  device.queue.writeBuffer(src.prev, 0, bodyWords(base, cap));
  device.queue.writeBuffer(src.bodies, 0, bodyWords(next, cap));
  src.count = 12;
  const step = await sparkFrame(device, sp, src);
  const after = await sparkFrame(device, sp, src); // no further step
  // Body 3 now has a known tier: its next impact counts.
  const later = next.map((b) => ({ ...b, vel: [...b.vel] as V3 }));
  later[3]!.vel[0] += 6;
  device.queue.writeBuffer(src.prev, 0, bodyWords(next, cap));
  device.queue.writeBuffer(src.bodies, 0, bodyWords(later, cap));
  const again = await sparkFrame(device, sp, src);
  const err = await device.popErrorScope();
  sp.destroy();
  device.destroy();
  return {
    first: first.ctl[CTL.events], still: still.ctl[CTL.events], after: after.ctl[CTL.events],
    step: step.events.sort((a, b) => (a.packed & 0xffffff) - (b.packed & 0xffffff)), spawned: step.ctl[CTL.spawned],
    again: again.events, error: err?.message ?? null,
  };
}

/** Spawn and flight against the CPU twins: three injected bursts, then frames of flight with ground bounces. */
export async function sparkSim(frames: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = rawSource(device, new ArrayBuffer(4 * Body.size), new ArrayBuffer(4 * Body.size), sparkShapes(), new Uint32Array(4), 0, 4);
  const sp = new Sparks(device);
  const bursts: { pos: V3; dir: V3; strength: number }[] = [
    { pos: [0, 1, 0], dir: [0, 1, 0], strength: 8 },
    { pos: [2, 0.3, 1], dir: [1, 0.2, 0], strength: 14 },
    { pos: [-1, 2, -1], dir: [0.1, -1, 0.2], strength: 30 },
  ];
  for (const b of bursts) sp.inject(b.pos, b.dir, b.strength);
  // The events as the GPU sees them (f32).
  const f32v = (v: number[]) => v.map((x) => Math.fround(x)) as V3;
  const events: Impact[] = bursts.map((b) => { const l = Math.hypot(...b.dir); return { pos: f32v(b.pos), dir: f32v(b.dir.map((x) => x / l)), strength: Math.fround(b.strength), packed: 0xffffff | (1 << 24) }; });
  const frame0 = sp.nextFrame;
  const s0 = await sparkFrame(device, sp, src, 0, 0);
  const born = unpackSparks(await readBuffer(device, sp.sparks)).filter((s) => s.age >= 0);
  const want = spawnReference(events, frame0, sp.config);
  const byPacked = new Map(want.map((s) => [s.packed, s]));
  let spawnErr = 0, unmatched = 0;
  for (const s of born) {
    const w = byPacked.get(s.packed);
    if (!w) { unmatched++; continue; }
    for (let k = 0; k < 3; k++) spawnErr = Math.max(spawnErr, Math.abs(s.pos[k]! - w.pos[k]!), Math.abs(s.vel[k]! - w.vel[k]!) / (1 + Math.abs(w.vel[k]!)));
  }
  // Flight: the twin starts from the GPU's own initial states.
  const dt = 1 / 60;
  let last = s0;
  for (let i = 0; i < frames; i++) last = await sparkFrame(device, sp, src, dt, 0);
  const flown = unpackSparks(await readBuffer(device, sp.sparks));
  const argsFlying = Array.from(new Uint32Array(await readBuffer(device, sp.args)));
  let simErr = 0, alive = 0, aliveRef = 0, bounced = 0;
  const all = new Map(born.map((s) => [s.packed, s]));
  for (const s of flown) {
    if (s.age < 0 && !all.has(s.packed)) continue; // never-used slot
    const init = all.get(s.packed);
    if (!init) continue;
    let r = init, up = false;
    for (let i = 0; i < frames; i++) { const n = stepReference(r, dt, 0, sp.config); if (n.age >= 0 && r.vel[1] < 0 && n.vel[1] > 0 && n.pos[1] < 0.5) up = true; r = n; }
    if (r.age >= 0) aliveRef++;
    if (s.age >= 0) alive++;
    if (up && r.age >= 0) bounced++;
    if ((r.age < 0) !== (s.age < 0)) { simErr = Infinity; continue; }
    if (r.age < 0) continue;
    for (let k = 0; k < 3; k++) simErr = Math.max(simErr, Math.abs(s.pos[k]! - r.pos[k]!), Math.abs(s.vel[k]! - r.vel[k]!) / (1 + Math.abs(r.vel[k]!)));
  }
  // Past the longest life (1.2 s) every spark is dead and the streak draw is empty.
  let dead = last;
  for (let i = 0; i < 80; i++) dead = await sparkFrame(device, sp, src, dt, 0);
  const argsDead = Array.from(new Uint32Array(await readBuffer(device, sp.args)));
  const err = await device.popErrorScope();
  sp.destroy();
  device.destroy();
  return {
    born: born.length, want: want.length, spawned: s0.ctl[CTL.spawned], unmatched, spawnErr, alive, aliveRef, bounced, simErr,
    aliveCtl: last.ctl[CTL.alive], argsFlying, aliveDead: dead.ctl[CTL.alive], argsDead, pool: sp.pool, error: err?.message ?? null,
  };
}

/** A flood: every one of 100k bodies hit at once. Events and sparks stay within their budgets. */
export async function sparkFlood(n: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const bs: RawBody[] = Array.from({ length: n }, (_, i) => ({ pos: [(i % 300) * 1.1, 1 + Math.floor(i / 90000), Math.floor(i / 300) % 300] as V3, vel: [0, 0, 0] as V3, shape: 0 }));
  const src = rawSource(device, bodyWords(bs, n), bodyWords(bs, n), sparkShapes(), new Uint32Array(n), n, n);
  const sp = new Sparks(device);
  await sparkFrame(device, sp, src);
  device.queue.writeBuffer(src.bodies, 0, bodyWords(bs.map((b) => ({ ...b, vel: [10, 0, 0] as V3 })), n));
  const hit = await sparkFrame(device, sp, src);
  const live = unpackSparks(await readBuffer(device, sp.sparks)).filter((s) => s.age >= 0).length;
  const slots = new Set(hit.events.map((e) => e.packed & 0xffffff));
  const err = await device.popErrorScope();
  sp.destroy();
  device.destroy();
  return { ctl: hit.ctl, events: hit.events.length, distinct: slots.size, live, error: err?.message ?? null };
}

/**
 * Streaks in the image: a burst in the open shows around where it
 * projects and nowhere else (64k dead slots draw nothing); a burst behind
 * a wall is hidden by depth.
 */
export async function sparkDraw() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([2, 1, -5], [2, 2, 0.3], [0, 0, 0, 1])];
  const src = new SnapshotSource(device);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...rend.look, bloomMix: 0 };
  rend.setSource(src);
  const f: FrameParams = { ...camera([0, 1.5, 6], [0, 1, 0]), groundY: -1, time: 1, dt: 1 / 60 };
  const open: V3 = [-2.5, 1.5, 0], hidden: V3 = [2, 1, -8];
  rend.burst(open, [0, 1, 0], 20);
  rend.burst(hidden, [0, 0, -1], 20);
  const a = (await rend.render(f, true, true))!.pixels!;
  rend.toggles.sparks = false;
  const b = (await rend.render(f, true, true))!.pixels!;
  const ids = (await rend.renderIds(f)).ids;
  const project = (p: V3) => { const c = transform(f.viewProj, p); return [((c[0] / c[3]) * 0.5 + 0.5) * W, (0.5 - (c[1] / c[3]) * 0.5) * H]; };
  const [ox, oy] = project(open);
  let near = 0, stray = 0, behindWall = 0, maxWall = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = y * a.bytesPerRow + 4 * x;
    const d = Math.max(...[0, 1, 2].map((k) => a.data[o + k]! - b.data[o + k]!));
    const r = Math.hypot(x + 0.5 - ox!, y + 0.5 - oy!);
    if (ids[y * W + x]) { maxWall = Math.max(maxWall, Math.abs(d)); if (d > 1) behindWall++; continue; }
    if (r < 30) near += Math.max(d, 0);
    else if (d > 1) stray++;
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { near, stray, behindWall, maxWall, wallPixels: ids.reduce((s, v) => s + (v ? 1 : 0), 0), error: err?.message ?? null };
}

// ---------------------------------------------------------------- lights

/** Mean 8-bit luma over the pixels whose ID is slot + 1. */
function meanOver(px: { data: number[]; bytesPerRow: number }, ids: Uint32Array, id: number) {
  let s = 0, n = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (ids[y * W + x] !== id) continue;
    const o = y * px.bytesPerRow + 4 * x;
    s += 0.2126 * px.data[o]! + 0.7152 * px.data[o + 1]! + 0.0722 * px.data[o + 2]!;
    n++;
  }
  return { mean: n ? s / n : NaN, n };
}

/** The ball light: a cube 2 m from the ball brightens, one 20 m away does not change. */
export async function ballLight() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [ball([0, 1, 0], 0.3), box([2, 1, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1]), box([0, 1, -20], [2, 2, 2], [0, 0, 0, 1])];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] });
  rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0 };
  rend.toggles.trail = false;
  rend.setSource(src);
  const f: FrameParams = { ...camera([1, 3, 7], [1, 1, -6]), groundY: 0, time: 1 };
  const ids = (await rend.renderIds(f)).ids;
  const on = (await rend.render(f, true, true))!.pixels!;
  rend.lights.config = { ...rend.lights.config, ballIntensity: 0 };
  const off = (await rend.render(f, true, true))!.pixels!;
  const near = [meanOver(on, ids, 2), meanOver(off, ids, 2)], far = [meanOver(on, ids, 3), meanOver(off, ids, 3)];
  // Ground pixels within 1.5 m of the ball's foot get brighter too.
  let groundOn = 0, groundOff = 0, gn = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (ids[y * W + x]) continue;
    const { o, d } = rayAt(f, x, y);
    if (d[1] >= 0) continue;
    const t = -o[1] / d[1], gx = o[0] + d[0] * t, gz = o[2] + d[2] * t;
    if (Math.hypot(gx, gz) > 1.5) continue;
    const i = y * on.bytesPerRow + 4 * x;
    groundOn += on.data[i + 1]!; groundOff += off.data[i + 1]!; gn++;
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { near, far, ground: [groundOn / gn, groundOff / gn], gn, balls: src.balls, error: err?.message ?? null };
}

/** Flash lights against the CPU slot rule: the strongest bid per slot wins, then decays; a weaker later bid does not replace it. */
export async function flashLights() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = new SnapshotSource(device);
  const rend = new Renderer(device, { size: [W, H] }, { sparkPool: 1024 });
  rend.setSource(src);
  const r = rng(91);
  const bursts = Array.from({ length: 40 }, () => ({ pos: [(r() - 0.5) * 40, r() * 6, (r() - 0.5) * 40] as V3, dir: [0, 1, 0] as V3, strength: 1 + r() * 20 }));
  for (const b of bursts) rend.burst(b.pos, b.dir, b.strength);
  const cfg = rend.lights.config;
  const f = (time: number): FrameParams => ({ ...camera([0, 10, 30], [0, 0, 0]), groundY: 0, time });
  await rend.render(f(5));
  const flashes = new Float32Array(await readBuffer(device, rend.lights.flashes));
  const lights = new Float32Array(await readBuffer(device, rend.lights.lights));
  // CPU rule.
  const q = (s: number) => Math.floor(Math.fround(Math.min(1, Math.max(0, Math.fround(s) / cfg.flashFull)) * 4095));
  const best = new Map<number, number>();
  bursts.forEach((b, i) => {
    if (!q(b.strength)) return;
    const k = flashSlot(b.pos), key = q(b.strength) * 1048576 + i; // as the GPU's u32 (q << 20 | i), without JS's signed shift
    if (key > (best.get(k) ?? -1)) best.set(k, key);
  });
  let posErr = 0, iErr = 0, slotsLit = 0, wrongLit = 0;
  for (let k = 0; k < FLASHES; k++) {
    const key = best.get(k), i0 = flashes[k * 8 + 4]!;
    if (key === undefined) { if (i0 !== 0) wrongLit++; continue; }
    slotsLit++;
    const b = bursts[key % 1048576]!;
    posErr = Math.max(posErr, Math.abs(flashes[k * 8]! - b.pos[0]), Math.abs(flashes[k * 8 + 1]! - (b.pos[1] + 0.5)), Math.abs(flashes[k * 8 + 2]! - b.pos[2]));
    iErr = Math.max(iErr, Math.abs(i0 - (Math.floor(key / 1048576) / 4095) * cfg.flashIntensity), Math.abs(lights[(MAX_BALLS + k) * 8 + 7]! - i0));
  }
  // The packed list the scene shader loops over: exactly the lit raw slots, in slot order.
  const packed = (l: Float32Array) => {
    const want: number[] = [];
    for (let k = 0; k < LIGHTS; k++) if (l[k * 8 + 3]! > 0 && l[k * 8 + 7]! > 0) want.push(...l.slice(k * 8, k * 8 + 8));
    const n = l[LIGHT_META * 4 + 1]!, got = Array.from(l.slice(LIGHT_PACKED * 4, LIGHT_PACKED * 4 + n * 8));
    return { n, same: n * 8 === want.length && got.every((v, i) => v === want[i]) };
  };
  const pack = packed(lights);
  // One tau later: a weak bid in a lit slot does not replace it; the light has decayed by e.
  const [k0, key0] = [...best.entries()][0]!;
  const lit = bursts[key0 % 1048576]!;
  rend.burst(lit.pos, [0, 1, 0], 1.2); // weaker than what is left
  await rend.render(f(5 + cfg.flashTau));
  const flashes2 = new Float32Array(await readBuffer(device, rend.lights.flashes));
  const lights2 = new Float32Array(await readBuffer(device, rend.lights.lights));
  const kept = flashes2[k0 * 8 + 3] === flashes[k0 * 8 + 3] && flashes2[k0 * 8 + 4] === flashes[k0 * 8 + 4];
  const decay = lights2[(MAX_BALLS + k0) * 8 + 7]! / flashes[k0 * 8 + 4]!;
  // A strong bid replaces it.
  rend.burst(lit.pos, [0, 1, 0], 100);
  await rend.render(f(5 + 2 * cfg.flashTau));
  const flashes3 = new Float32Array(await readBuffer(device, rend.lights.flashes));
  const replaced = flashes3[k0 * 8 + 3] === Math.fround(5 + 2 * cfg.flashTau) && Math.abs(flashes3[k0 * 8 + 4]! - cfg.flashIntensity) < 1e-5;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { slotsLit, wrongLit, posErr, iErr, kept, decay, replaced, pack, error: err?.message ?? null };
}

/** The ball trail: samples newest first in time order at the drawn positions; the ribbon lights the path behind the ball, not ahead. */
export async function ballTrail(frames: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const at = (i: number): V3 => [-3 + i * 0.4, 1.5, 0];
  const descs = [ball(at(0), 0.25)];
  const src = new SnapshotSource(device);
  src.reset(descs);
  const rend = new Renderer(device, { size: [W, H] }, { sparkPool: 1024 });
  rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0 };
  rend.lights.config = { ...rend.lights.config, ballIntensity: 0 };
  rend.setSource(src);
  const f = (i: number): FrameParams => ({ ...camera([0, 2, 8], [0, 1.5, 0]), groundY: -2, time: 1 + i / 60, alpha: 1 });
  for (let i = 0; i < frames; i++) {
    descs[0] = { ...descs[0]!, pos: at(i) };
    src.update(snapshotOf(descs), descs);
    await rend.render(f(i));
  }
  const trail = new Float32Array(await readBuffer(device, rend.lights.trail));
  const head = (rend.lights.nextFrame + TRAIL - 1) % TRAIL;
  let ordered = true, posErr = 0, used = 0;
  for (let j = 0; j < Math.min(frames, TRAIL); j++) {
    const s = (head + TRAIL - j) % TRAIL, i = frames - 1 - j;
    const t = trail[s * 4 + 3]!;
    if (Math.abs(t - Math.fround(1 + i / 60)) > 1e-5) ordered = false;
    posErr = Math.max(posErr, ...at(i).map((v, k) => Math.abs(trail[s * 4 + k]! - v)));
    used++;
  }
  // The image: the last frame again with and without the ribbon.
  const last = f(frames - 1);
  const withTrail = (await rend.render(last, true, true))!.pixels!;
  rend.toggles.trail = false;
  const without = (await rend.render(last, true, true))!.pixels!;
  const ids = (await rend.renderIds(last)).ids;
  const project = (p: V3) => { const c = transform(last.viewProj, p); return [((c[0] / c[3]) * 0.5 + 0.5) * W, (0.5 - (c[1] / c[3]) * 0.5) * H] as const; };
  const [bx, by] = project(at(frames - 1)), [tx] = project(at(frames - 12)), [mx] = project(at(frames - 6));
  let behind = 0, ahead = 0, farBehind = 0;
  for (let y = Math.floor(by - 3); y <= by + 3; y++) for (let x = 0; x < W; x++) {
    if (ids[y * W + x]) continue;
    const o = y * withTrail.bytesPerRow + 4 * x;
    const d = Math.max(...[0, 1, 2].map((k) => withTrail.data[o + k]! - without.data[o + k]!));
    if (x > tx && x < bx - 4) behind += Math.max(d, 0);
    if (x > tx && x < mx) farBehind += Math.max(d, 0); // 6 to 12 frames back: the whole ribbon is drawn, not just its newest piece
    if (x > bx + 6) ahead += Math.max(d, 0);
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { ordered, posErr, used, behind, farBehind, ahead, error: err?.message ?? null };
}

// ---------------------------------------------------------------- heat

const heatOf = (state: ArrayBuffer) => Array.from(new Uint32Array(state)).filter((_, w) => w % 4 === 3).map((bits) => fromHalf(bits & 0xffff));

/**
 * Heat sources and decay, scripted: contact with a ball (exact point-box
 * distance, rotation included; static and lattice bodies never heat),
 * hard hits mapped linearly above heatDv, and exponential decay once the
 * source is gone.
 */
export async function heatScript() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const cap = 10, s = Math.sin(Math.PI / 8), c = Math.cos(Math.PI / 8);
  const base: RawBody[] = [
    { pos: [0, 1, 0], vel: [0, 0, 0], shape: 2 }, // 0: the ball, r 0.4 (reach 0.4 + contact 0.3)
    { pos: [1.1, 1, 0], vel: [0, 0, 0], shape: 0 }, // 1: gap 0.6, touching
    { pos: [1.25, 1, 0], vel: [0, 0, 0], shape: 0 }, // 2: gap 0.75, not
    { pos: [0, 1, 1.35], vel: [0, 0, 0], shape: 0, rot: [0, s, 0, c] }, // 3: 45 degrees about y: an edge 0.707 from the centre, gap 0.643 (0.85 unrotated)
    { pos: [20, 1, 0], vel: [0, 0, 0], shape: 0 }, // 4: far
    { pos: [-5, 1, 0], vel: [0, 0, 0], shape: 0 }, // 5: hit, dv 9
    { pos: [-8, 1, 0], vel: [0, 0, 0], shape: 0 }, // 6: hit, dv 4
    { pos: [-11, 1, 0], vel: [0, 0, 0], shape: 0 }, // 7: hit, dv 15
    { pos: [-1.1, 1, 0], vel: [0, 0, 0], shape: 0, invMass: 0 }, // 8: touching, static
    { pos: [0, 1, -1.1], vel: [0, 0, 0], shape: 0, tier: TIER.lattice }, // 9: touching, dormant
  ];
  const looks = new Uint32Array(cap);
  looks[0] = MATERIAL.ball << 12;
  const src = rawSource(device, bodyWords(base, cap), bodyWords(base, cap), sparkShapes(), looks, cap, cap) as BodySource & { balls?: number[] };
  src.balls = [0];
  const sp = new Sparks(device);
  const state = async () => heatOf(await readBuffer(device, sp.stateFor(src)));
  const a = await sparkFrame(device, sp, src); // first sight: contact only
  const seen = await state();
  const next = base.map((b) => ({ ...b, vel: [...b.vel] as V3 }));
  next[5]!.vel = [9, 0, 0]; next[6]!.vel = [0, 4, 0]; next[7]!.vel = [0, 0, -15];
  device.queue.writeBuffer(src.bodies, 0, bodyWords(next, cap));
  const b = await sparkFrame(device, sp, src);
  const hit = await state();
  await sparkFrame(device, sp, src, 0.25); // the hits are over, the ball stays
  const later = await state();
  src.balls = [];
  await sparkFrame(device, sp, src, 0.25); // the ball is gone too
  const gone = await state();
  const err = await device.popErrorScope();
  sp.destroy();
  device.destroy();
  return { seen, hit, later, gone, hot: [a.ctl[CTL.hot], b.ctl[CTL.hot]], cfg: sp.config, error: err?.message ?? null };
}

/** The glow gain against the hot count: 1 up to HOT_FULL hot bodies, HOT_FULL / hot beyond. */
export async function heatGain(n: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const bs: RawBody[] = Array.from({ length: n }, (_, i) => ({ pos: [(i % 300) * 1.1, 1 + Math.floor(i / 90000) * 2, Math.floor(i / 300) % 300] as V3, vel: [0, 0, 0] as V3, shape: 0 }));
  const src = rawSource(device, bodyWords(bs, n), bodyWords(bs, n), sparkShapes(), new Uint32Array(n), n, n);
  const records = device.createBuffer({ size: n * RenderRecord.size, usage: GPUBufferUsage.STORAGE });
  const sp = new Sparks(device, 1024), lights = new Lights(device);
  const frame = async () => {
    const enc = device.createCommandEncoder();
    const pass = enc.beginComputePass();
    sp.encode(pass, src, { dt: 0, groundY: -100 });
    lights.encode(pass, src, records, sp, { eye: [0, 0, 0], time: 1, ball: [1, 1, 1] });
    pass.end();
    device.queue.submit([enc.finish()]);
    const l = new Float32Array(await readBuffer(device, lights.lights));
    return { ctl: Array.from(new Uint32Array(await readBuffer(device, sp.ctl))), gain: l[LIGHT_META * 4]!, lit: l[LIGHT_META * 4 + 1]! };
  };
  const cold = await frame();
  device.queue.writeBuffer(src.bodies, 0, bodyWords(bs.map((b) => ({ ...b, vel: [15, 0, 0] as V3 })), n));
  const hot = await frame();
  const err = await device.popErrorScope();
  sp.destroy();
  lights.destroy();
  records.destroy();
  device.destroy();
  return { cold: { hot: cold.ctl[CTL.hot], gain: cold.gain, lit: cold.lit }, hot: { hot: hot.ctl[CTL.hot], gain: hot.gain }, error: err?.message ?? null };
}

/**
 * Heat in the image: a cube hit hard glows, its cold twin does not, and
 * the glow dims when a crowd of other bodies (out of view) is hot too.
 * Sparks, flashes, bloom and fog are off so only the glow changes pixels.
 */
export async function heatImage(crowd: number, crowdHot: boolean, dv = 15, heat = true) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([-1.5, 1, 0], [0.6, 0.6, 0.6], [0, 0, 0, 1]), box([1.5, 1, 0], [0.6, 0.6, 0.6], [0, 0, 0, 1])];
  for (let i = 0; i < crowd; i++) descs.push(box([(i % 80) * 1.2 - 48, 0.5, 60 + Math.floor(i / 80) * 1.2], [0.4, 0.4, 0.4], [0, 0, 0, 1]));
  const src = new SnapshotSource(device);
  src.reset(descs);
  const rend = new Renderer(device, { size: [W, H] }, { sparkPool: 1024 });
  rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0 };
  rend.sparks.config = { ...rend.sparks.config, perDv: 0 };
  rend.lights.config = { ...rend.lights.config, flashIntensity: 0 };
  rend.toggles.trail = false;
  rend.toggles.heat = heat;
  rend.setSource(src);
  const f: FrameParams = { ...camera([0, 2.5, 7], [0, 1, 0]), groundY: 0, time: 1, dt: 0, alpha: 1 };
  const snap = snapshotOf(descs);
  src.update(snap, descs);
  const cold = (await rend.render(f, true, true))!.pixels!;
  snap.linVel[1] = dv; // cube 0
  if (crowdHot) for (let i = 2; i < descs.length; i++) snap.linVel[3 * i] = 15;
  src.update(snap, descs);
  const hot = (await rend.render(f, true, true))!.pixels!;
  const ids = (await rend.renderIds(f)).ids;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  const m = (px: typeof cold, id: number) => meanOver(px, ids, id).mean;
  return { hit: [m(cold, 1), m(hot, 1)], twin: [m(cold, 2), m(hot, 2)], n: meanOver(hot, ids, 1).n, error: err?.message ?? null };
}

// ---------------------------------------------------------------- AO volume

/**
 * The occupancy splat against its CPU twin, fed the GPU's own records:
 * random boxes (slabs and rods too) and spheres, some straddling or
 * outside the grid, some lattice or free (never splatted), some hidden by
 * FX scale 0. Unrotated bodies must match exactly; rotated ones within the
 * f32 slack of the rotation and cube root. The same world with its slots
 * reversed gives the same grid (integer atomics: order-independent). The
 * frame before, every slot was drawable, so lattice and free slots hold
 * stale records the splat must not use.
 */
export async function aoSplat(seed: number, n: number, rotated: boolean) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const r = rng(seed);
  const grid = aoGrid({ center: [0, 4, 0], half: [20, 6, 20] });
  const eye: V3 = [3.3, 7.1, -12.6];
  interface W { pos: V3; rot: number[]; half: V3; sphere: boolean; tier: number; hidden: boolean }
  const world: W[] = Array.from({ length: n }, () => {
    const sphere = r() < 0.15, k = r();
    const half: V3 = sphere ? [0.2 + r() * 0.8, 0, 0] : k < 0.1 ? [2 + r() * 2, 0.1, 1 + r()] : k < 0.2 ? [0.1, 0.1, 1 + r() * 2] : [0.1 + r() * 0.9, 0.1 + r() * 0.9, 0.1 + r() * 0.9];
    const t = r();
    return {
      pos: [(r() - 0.5) * 44, -3 + r() * 16, (r() - 0.5) * 44], rot: rotated ? randomQuat(r) : [0, 0, 0, 1], half, sphere,
      tier: t < 0.05 ? TIER.lattice : t < 0.08 ? TIER.free : t < 0.3 ? TIER.rubble : TIER.active, hidden: r() < 0.03,
    };
  });
  const run = async (order: number[]) => {
    const words = (allDrawn: boolean) => {
      const out = new ArrayBuffer(n * Body.size), bf = new Float32Array(out), bu = new Uint32Array(out), BW = Body.size / 4;
      order.forEach((w, i) => {
        const b = world[w]!;
        bf.set(b.pos, i * BW); bf.set(b.rot, i * BW + 4); bf[i * BW + 3] = 1;
        bu[i * BW + 11] = 1 | ((allDrawn ? TIER.active : b.tier) << 8);
        bu[i * BW + 15] = i;
      });
      return out;
    };
    const bodies = words(true), shapes = new ArrayBuffer(n * Shape.size);
    const sf = new Float32Array(shapes), su = new Uint32Array(shapes);
    const fx = new Uint32Array(n * FX_WORDS);
    const SW = Shape.size / 4;
    order.forEach((w, i) => {
      const b = world[w]!;
      sf.set(b.sphere ? [b.half[0], b.half[0], b.half[0]] : b.half, i * SW);
      su[i * SW + 3] = b.sphere ? 1 : 0;
      if (b.hidden) packFx({ scale: 0 }, fx, i * FX_WORDS);
    });
    const src = rawSource(device, bodies, bodies, shapes, new Uint32Array(n), n, n);
    const fxBuf = device.createBuffer({ size: Math.max(16, fx.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(fxBuf, 0, fx);
    const culler = new Culler(device, src, { box: BOX_VERTS, sphere: SPHERE_VERTS }, fxBuf);
    const ao = new AoVolume(device, grid);
    const f: CullFrame = { viewProj: perspective(1, 1, 0.1, 100), lightViewProj: perspective(1, 1, 0.1, 100), eye, alpha: 1 };
    const frame = async () => {
      const enc = device.createCommandEncoder();
      ao.clear(enc);
      const pass = enc.beginComputePass();
      culler.encode(pass, f);
      ao.splat(pass, src, culler.records, eye);
      pass.end();
      device.queue.submit([enc.finish()]);
      return new Uint32Array(await readBuffer(device, ao.occ));
    };
    await frame(); // every slot drawn: records everywhere
    const real = words(false);
    device.queue.writeBuffer(src.bodies, 0, real);
    device.queue.writeBuffer(src.prev, 0, real);
    const occ = await frame();
    const again = await frame();
    const view = new DataView(await readBuffer(device, culler.records));
    const recs: SplatBody[] = [];
    order.forEach((w, i) => {
      const b = world[w]!;
      if (b.tier === TIER.lattice || b.tier === TIER.free) return;
      const rec = readStruct(view, RenderRecord, i);
      recs.push({ pos: rec.pos!, rot: rec.rot!, half: rec.half!, sphere: b.sphere });
    });
    culler.destroy();
    ao.destroy();
    for (const b of [src.bodies, src.prev, src.shapes, src.looks, fxBuf]) b.destroy();
    return { occ, again, recs };
  };
  const fwd = await run(world.map((_, i) => i));
  const rev = await run(world.map((_, i) => n - 1 - i));
  const want = splatReference(fwd.recs, grid, eye);
  let mismatched = 0, maxDiff = 0, total = 0, absDiff = 0;
  for (let v = 0; v < want.length; v++) {
    const d = Math.abs(fwd.occ[v]! - want[v]!);
    if (d) mismatched++;
    maxDiff = Math.max(maxDiff, d);
    absDiff += d;
    total += want[v]!;
  }
  const same = (a: Uint32Array, b: Uint32Array) => a.every((x, i) => x === b[i]);
  const err = await device.popErrorScope();
  device.destroy();
  return {
    voxels: want.length, touched: want.reduce((c, x) => c + (x ? 1 : 0), 0), mismatched, maxDiff, relDiff: absDiff / (total || 1),
    stable: same(fwd.occ, fwd.again), orderFree: same(fwd.occ, rev.occ), splatted: fwd.recs.length, error: err?.message ?? null,
  };
}

/** aoFoot on the GPU for given (rot, half, sphere) cases, to compare with aoFootReference. */
export async function aoFootGpu(cases: { rot: number[]; half: number[]; sphere: boolean }[]) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const module = device.createShaderModule({
    code: /* wgsl */ `
${AO_FOOT_WGSL}
@group(0) @binding(0) var<storage, read> inp: array<vec4f>;
@group(0) @binding(1) var<storage, read_write> out: array<vec4f>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&out)) { return; }
  let h = inp[2u * id.x + 1u];
  out[id.x] = vec4f(aoFoot(inp[2u * id.x], h.xyz, h.w > 0.5), 0.0);
}`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const data = new Float32Array(cases.length * 8);
  cases.forEach((c, i) => { data.set(c.rot, i * 8); data.set([c.half[0]!, c.half[1] ?? 0, c.half[2] ?? 0, c.sphere ? 1 : 0], i * 8 + 4); });
  const inp = device.createBuffer({ size: data.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(inp, 0, data);
  const out = device.createBuffer({ size: cases.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe);
  pass.setBindGroup(0, device.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: inp } }, { binding: 1, resource: { buffer: out } }] }));
  pass.dispatchWorkgroups(Math.ceil(cases.length / 64));
  pass.end();
  device.queue.submit([enc.finish()]);
  const res = new Float32Array(await readBuffer(device, out));
  const err = await device.popErrorScope();
  device.destroy();
  return { foot: cases.map((_, i) => Array.from(res.slice(i * 4, i * 4 + 3))), error: err?.message ?? null };
}

/** Read one level of an rgba8unorm 3D texture into tight RGBA bytes. */
async function readVolume(device: GPUDevice, tex: GPUTexture, level: number, dims: number[]): Promise<Uint8Array> {
  const [w, h, d] = dims as [number, number, number];
  const bytesPerRow = Math.ceil((w * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * h * d, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, mipLevel: level }, { buffer: buf, bytesPerRow, rowsPerImage: h }, [w, h, d]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const src = new Uint8Array(buf.getMappedRange()), out = new Uint8Array(w * h * d * 4);
  for (let z = 0; z < d; z++) for (let y = 0; y < h; y++) out.set(src.subarray((z * h + y) * bytesPerRow, (z * h + y) * bytesPerRow + w * 4), ((z * h + y) * w) * 4);
  buf.unmap();
  buf.destroy();
  return out;
}

/** Compose against its CPU twin on a random accumulator (sparse, some over-full voxels, some full layers). */
export async function aoCompose(seed: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const grid = aoGrid({ center: [0, 4, 0], half: [10, 6, 8] });
  const r = rng(seed);
  const [nx, ny, nz] = grid.dims;
  const occ = new Uint32Array(nx * ny * nz).map(() => (r() < 0.25 ? Math.floor(r() * 1.6 * AO_ONE) : 0));
  for (let z = 0; z < nz; z++) for (let x = 0; x < nx; x++) if (x < nx / 2) occ[(z * ny + 7) * nx + x] = AO_ONE; // a floor under half the grid
  const ao = new AoVolume(device, grid);
  device.queue.writeBuffer(ao.occ, 0, occ);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  ao.compose(pass);
  pass.end();
  device.queue.submit([enc.finish()]);
  const want = composeReference(occ, grid, ao.skyK);
  const levels = [];
  for (let l = 0; l < want.length; l++) {
    const got = await readVolume(device, ao.volume, l, want[l]!.dims);
    let maxR = 0, maxG = 0, fixed = 0;
    for (let v = 0; v < want[l]!.r.length; v++) {
      maxR = Math.max(maxR, Math.abs(got[v * 4]! - want[l]!.r[v]! * 255));
      maxG = Math.max(maxG, Math.abs(got[v * 4 + 1]! - want[l]!.g[v]! * 255));
      if (got[v * 4 + 2] !== 0 || got[v * 4 + 3] !== 255) fixed++;
    }
    levels.push({ dims: want[l]!.dims, maxR, maxG, fixed });
  }
  ao.destroy();
  const err = await device.popErrorScope();
  device.destroy();
  return { levels, error: err?.message ?? null };
}

/** A fixed scene's pixels, hashed: towers, rubble, a ball, the floor. For before/after checks of a change that must not alter the image. */
export async function sceneHash(toggles: Record<string, boolean> = {}, format?: GPUTextureFormat) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs: BodyDesc[] = [];
  for (let t = 0; t < 4; t++) for (let y = 0; y < 6; y++) descs.push(box([t * 3 - 4.5, 0.5 + y, -3], [0.5, 0.5, 0.5], [0, 0, 0, 1], t));
  const r = rng(3);
  for (let i = 0; i < 40; i++) descs.push(box([(r() - 0.5) * 10, 0.3, 1 + r() * 3], [0.3, 0.3, 0.3], randomQuat(r), 5));
  descs.push(ball([0, 2, 2], 0.4));
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] }, { format });
  Object.assign(rend.toggles, toggles);
  rend.setSource(src);
  const f: FrameParams = { ...camera([0, 4, 9], [0, 1, -1]), groundY: 0, time: 1, dt: 0, alpha: 1 };
  await rend.render(f);
  const px = (await rend.render(f, true, true))!.pixels!;
  let h = 2166136261;
  for (const b of px.data) h = Math.imul(h ^ b, 16777619) >>> 0;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { hash: h, error: err?.message ?? null };
}

/** Cameras of the golden images: eye, target, groundY. */
const GOLDEN_VIEWS: Record<string, [V3, V3]> = {
  near: [[0, 4, 9], [0, 1, -1]],
  far: [[18, 22, 40], [0, 2, -2]],
  low: [[2.2, 0.45, 2.4], [-1, 1.2, -3]],
};

/**
 * FNV-1a hash of the RGBA frame of each look and view, for the golden-image
 * gate (render.test.ts): towers, tumbled boxes, the ball, an overlay sphere
 * and a tinted, glowing slot, with the arena set, so most of the scene
 * shader's paths draw. Still bodies, so no spark lives and nothing depends on
 * timing.
 */
function goldenScene(device: GPUDevice): SnapshotSource {
  const descs: BodyDesc[] = [];
  for (let t = 0; t < 4; t++) for (let y = 0; y < 6; y++) descs.push(box([t * 3 - 4.5, 0.5 + y, -3], [0.5, 0.5, 0.5], [0, 0, 0, 1], t));
  const r = rng(3);
  for (let i = 0; i < 40; i++) descs.push(box([(r() - 0.5) * 10, 0.3, 1 + r() * 3], [0.3, 0.3, 0.3], randomQuat(r), 5));
  descs.push(ball([0, 2, 2], 0.4));
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  return src;
}

function goldenRenderer(device: GPUDevice, src: BodySource, look: LookParams, size: [number, number], opts: RendererOptions = {}): Renderer {
  const rend = new Renderer(device, { size }, { format: 'rgba8unorm', ...opts });
  rend.look = look;
  rend.setSource(src);
  rend.setShadowBounds([0, 3, -1], 14, [9, 7, 9]);
  rend.setFx(5, { tint: [1, 0.5, 0.25], emissive: 0.25 });
  rend.setOverlay(new Float32Array([1.5, 1, 3, 0.15]));
  return rend;
}

/**
 * FNV-1a hash of the RGBA frame of each look and view, for the golden-image
 * gate (render.test.ts): towers, tumbled boxes, the ball, an overlay sphere
 * and a tinted, glowing slot, with the arena set, so most of the scene
 * shader's paths draw. Still bodies, so no spark lives and nothing depends on
 * timing.
 */
export async function lookHashes(looks: string[], size: [number, number] = [320, 180]) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = goldenScene(device);
  const hashes: Record<string, number> = {};
  for (const name of looks) {
    const rend = goldenRenderer(device, src, LOOKS[name]!, size);
    for (const [view, [eye, target]] of Object.entries(GOLDEN_VIEWS)) {
      const f: FrameParams = { ...camera(eye, target, size[0] / size[1]), groundY: 0, time: 1, dt: 0, alpha: 1 };
      await rend.render(f);
      const px = (await rend.render(f, true, true))!.pixels!;
      let h = 2166136261;
      for (const b of px.data) h = Math.imul(h ^ b, 16777619) >>> 0;
      hashes[`${name}:${view}`] = h;
    }
    rend.destroy();
  }
  const err = await device.popErrorScope();
  device.destroy();
  return { hashes, error: err?.message ?? null };
}

/**
 * The golden scene in a look (a LOOKS name, or realLook options), as RGBA
 * rows: for image checks and screenshots. Also returns the mean colour of
 * the top and bottom rows of sky (looking up from the low view) when sky is set.
 */
export async function lookFrame(look: string | Partial<RealOptions>, eye: V3, target: V3, size: [number, number] = [320, 180], far = 400) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = goldenScene(device);
  const rend = goldenRenderer(device, src, typeof look === 'string' ? LOOKS[look]! : realLook(look), size);
  const f: FrameParams = { viewProj: multiply(perspective(0.9, size[0] / size[1], 0.1, far), lookAt(eye, target)), eye, groundY: 0, time: 1, dt: 0, alpha: 1 };
  await rend.render(f);
  const stats = (await rend.render(f, true, true))!;
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { width: size[0], height: size[1], data: stats.pixels!.data, bytesPerRow: stats.pixels!.bytesPerRow, meanLuma: stats.meanLuma, error: err?.message ?? null };
}

function fnv(data: ArrayLike<number>): number {
  let h = 2166136261;
  for (let i = 0; i < data.length; i++) h = Math.imul(h ^ data[i]!, 16777619) >>> 0;
  return h;
}

/**
 * The real look end to end: frames of the golden scene from a view with the
 * horizon in it, for each look given. Per frame: mean luma, the mean sRGB of
 * the top rows (high sky) and of a band just above the horizon, and the lit
 * count of the point lights (lights.ts meta) after the frame.
 */
export async function realChecks(looks: Array<string | (Partial<RealOptions> & Pick<RendererOptions, 'realDiag'>)>, size: [number, number] = [320, 180], view: [V3, V3] = [[0, 2, 9], [0, 2.6, -1]]) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const src = goldenScene(device);
  const [eye, target] = view;
  const viewProj = multiply(perspective(0.9, size[0] / size[1], 0.1, 400), lookAt(eye, target));
  // Row of the horizon: a far point at eye height.
  const far = [eye[0], eye[1], eye[2] - 1e5, 1];
  const clip = [0, 1, 2, 3].map((i) => far.reduce((acc, v, j) => acc + viewProj[j * 4 + i]! * v, 0));
  const horizonRow = Math.round(((1 - clip[1]! / clip[3]!) / 2) * size[1]);
  const out = [];
  for (const look of looks) {
    const { realDiag, ...real } = typeof look === 'string' ? {} : look;
    const rend = goldenRenderer(device, src, typeof look === 'string' ? LOOKS[look]! : realLook(real), size, { realDiag });
    const f: FrameParams = { viewProj, eye, groundY: 0, time: 1, dt: 0, alpha: 1 };
    await rend.render(f);
    const stats = (await rend.render(f, true, true))!;
    const { data, bytesPerRow } = stats.pixels!;
    const band = (r0: number, r1: number) => {
      const m = [0, 0, 0];
      for (let y = r0; y < r1; y++) for (let x = 0; x < size[0]; x++) for (let c = 0; c < 3; c++) m[c] = m[c]! + data[y * bytesPerRow + 4 * x + c]! / ((r1 - r0) * size[0]);
      return m;
    };
    const meta = new Float32Array(await readBuffer(device, rend.lights.lights)).slice(LIGHT_META * 4, LIGHT_META * 4 + 4);
    // Fine detail below the horizon: mean |luma - mean of its 4 neighbours|.
    const luma = (x: number, y: number) => { const o = y * bytesPerRow + 4 * x; return 0.2126 * data[o]! + 0.7152 * data[o + 1]! + 0.0722 * data[o + 2]!; };
    let detail = 0, cnt = 0;
    for (let y = Math.max(horizonRow + 2, 1); y < size[1] - 1; y++) for (let x = 1; x < size[0] - 1; x++) {
      detail += Math.abs(luma(x, y) - (luma(x - 1, y) + luma(x + 1, y) + luma(x, y - 1) + luma(x, y + 1)) / 4);
      cnt++;
    }
    out.push({ meanLuma: stats.meanLuma, top: band(0, 8), horizon: band(horizonRow - 8, horizonRow - 3), lit: meta[1]!, detail: detail / cnt, hash: fnv(data) });
    rend.destroy();
  }
  const err = await device.popErrorScope();
  device.destroy();
  return { frames: out, horizonRow, error: err?.message ?? null };
}

export interface AoProbeBody { pos: V3; half: V3; rot?: number[]; sphere?: boolean }
export interface AoProbe { p: V3; n: V3; own: number; /** For the seam cavity: the point in the body's frame, its face normal there, and metres per pixel (default 0: full strength). */ local?: V3; face?: V3; pxM?: number }

/**
 * aoAt (the scene shader's AO function) evaluated in a compute kernel at
 * world points, against a volume splatted and composed from these bodies.
 * own: the probe's body (its footprint is subtracted), or -1 (floor).
 */
export async function aoProbe(bodies: AoProbeBody[], probes: AoProbe[], center: V3 = [0, 4, 0], half: V3 = [12, 8, 12]) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const n = bodies.length;
  const bw = new ArrayBuffer(n * Body.size), sw = new ArrayBuffer(n * Shape.size);
  const bf = new Float32Array(bw), bu = new Uint32Array(bw), sf = new Float32Array(sw), su = new Uint32Array(sw);
  const BW = Body.size / 4, SW = Shape.size / 4;
  bodies.forEach((b, i) => {
    bf.set(b.pos, i * BW); bf.set(b.rot ?? [0, 0, 0, 1], i * BW + 4); bf[i * BW + 3] = 1;
    bu[i * BW + 11] = 1 | (TIER.active << 8);
    bu[i * BW + 15] = i;
    sf.set(b.sphere ? [b.half[0], b.half[0], b.half[0]] : b.half, i * SW);
    su[i * SW + 3] = b.sphere ? 1 : 0;
  });
  const src = rawSource(device, bw, bw, sw, new Uint32Array(n), n, n);
  const fxBuf = device.createBuffer({ size: Math.max(16, n * FX_WORDS * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  const culler = new Culler(device, src, { box: BOX_VERTS, sphere: SPHERE_VERTS }, fxBuf);
  const grid = aoGrid({ center, half });
  const ao = new AoVolume(device, grid);
  const eye: V3 = [1.7, 3.1, 9.4];
  const enc = device.createCommandEncoder();
  ao.clear(enc);
  const pass = enc.beginComputePass();
  culler.encode(pass, { viewProj: perspective(1, 1, 0.1, 100), lightViewProj: perspective(1, 1, 0.1, 100), eye, alpha: 1 });
  ao.splat(pass, src, culler.records, eye);
  ao.compose(pass);
  pass.end();
  device.queue.submit([enc.finish()]);
  const module = device.createShaderModule({
    code: /* wgsl */ `
${AO_FOOT_WGSL}
@group(0) @binding(0) var aoVol: texture_3d<f32>;
@group(0) @binding(1) var aoSamp: sampler;
${AO_SAMPLE_WGSL}
@group(0) @binding(2) var<uniform> av: AoView;
@group(0) @binding(3) var<storage, read> inp: array<vec4f>;  // per probe: p, n, own rotation, (own half extents, 0 floor / 1 box / 2 sphere)
@group(0) @binding(4) var<storage, read_write> out: array<vec4f>;
@group(0) @binding(5) var<storage, read> centres: array<vec4f>; // per probe: own centre; local point (w 1: seam probe); face normal (w metres per pixel)
${AO_SEAM_WGSL}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= arrayLength(&out)) { return; }
  let i = 4u * id.x;
  let f = inp[i + 3u];
  var foot = vec3f(0.0);
  if (f.w > 0.5) { foot = aoFoot(inp[i + 2u], f.xyz, f.w > 1.5); }
  let c = centres[3u * id.x].xyz;
  let lp = centres[3u * id.x + 1u];
  var seam = 1.0;
  if (lp.w > 0.5) { seam = aoSeam(av, lp.xyz, centres[3u * id.x + 2u].xyz, f.xyz, inp[i + 2u], c, foot, centres[3u * id.x + 2u].w); }
  out[id.x] = vec4f(aoAt(av, inp[i].xyz, inp[i + 1u].xyz, c, foot), seam, 0.0);
}
`,
  });
  const pipe = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } });
  const data = new Float32Array(probes.length * 16), cdata = new Float32Array(probes.length * 12);
  const rel = (p: readonly number[]) => [Math.fround(p[0]! - eye[0]), Math.fround(p[1]! - eye[1]), Math.fround(p[2]! - eye[2])];
  probes.forEach((q, k) => {
    const b = q.own >= 0 ? bodies[q.own]! : null;
    data.set(rel(q.p), k * 16);
    const l = Math.hypot(...q.n);
    data.set(q.n.map((x) => x / l), k * 16 + 4);
    data.set(b?.rot ?? [0, 0, 0, 1], k * 16 + 8);
    data.set([...(b ? (b.sphere ? [b.half[0], b.half[0], b.half[0]] : b.half) : [0, 0, 0]), b ? (b.sphere ? 2 : 1) : 0], k * 16 + 12);
    cdata.set(b ? rel(b.pos) : [0, 0, 0], k * 12);
    if (q.local && q.face) { cdata.set([...q.local, 1], k * 12 + 4); cdata.set([...q.face, q.pxM ?? 0], k * 12 + 8); }
  });
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST;
  const inp = device.createBuffer({ size: data.byteLength, usage }), cen = device.createBuffer({ size: cdata.byteLength, usage });
  device.queue.writeBuffer(inp, 0, data);
  device.queue.writeBuffer(cen, 0, cdata);
  const { originRel, invVoxel } = aoFrame(grid, eye);
  const avBuf = device.createBuffer({ size: 48, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(avBuf, 0, new Float32Array([...originRel, invVoxel, ...grid.dims, 1, ...ao.k]));
  const out = device.createBuffer({ size: probes.length * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
  const samp = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const enc2 = device.createCommandEncoder();
  const p2 = enc2.beginComputePass();
  p2.setPipeline(pipe);
  p2.setBindGroup(0, device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: ao.volume.createView() }, { binding: 1, resource: samp }, { binding: 2, resource: { buffer: avBuf } },
      { binding: 3, resource: { buffer: inp } }, { binding: 4, resource: { buffer: out } }, { binding: 5, resource: { buffer: cen } },
    ],
  }));
  p2.dispatchWorkgroups(Math.ceil(probes.length / 64));
  p2.end();
  device.queue.submit([enc2.finish()]);
  const res = new Float32Array(await readBuffer(device, out));
  const err = await device.popErrorScope();
  ao.destroy();
  culler.destroy();
  device.destroy();
  return { ao: probes.map((_, k) => [res[4 * k]!, res[4 * k + 1]!] as [number, number]), seam: probes.map((_, k) => res[4 * k + 2]!), error: err?.message ?? null };
}

/**
 * AO in the image: a tower on the floor and an isolated cube in the air,
 * rendered with the volume on and off, sun off so ambient (what AO
 * scales) is all the light. The floor around the tower's foot darkens;
 * the isolated cube and ball and the open floor do not change beyond f32
 * noise; a cube at the tower's foot darkens where the tower rises beside it.
 */
function aoScene(device: GPUDevice, opts: RendererOptions = {}) {
  const descs: BodyDesc[] = [];
  for (let y = 0; y < 6; y++) descs.push(box([-2, 0.5 + y, -2], [0.5, 0.5, 0.5], [0, 0, 0, 1], 1));
  descs.push(box([2.6, 2.2, -1], [0.5, 0.5, 0.5], [0, Math.sin(0.3), 0, Math.cos(0.3)], 2)); // isolated, slot 6
  descs.push(box([-1, 0.5, -2], [0.5, 0.5, 0.5], [0, 0, 0, 1], 3)); // against the tower's foot, slot 7
  const q = normalize([0.4, -0.7, 0.2]), sh = Math.sin(0.6);
  descs.push({ ...ball([-3.2, 1.2, 1.5], 0.55), rot: [q[0] * sh, q[1] * sh, q[2] * sh, Math.cos(0.6)], tag: 4 }); // isolated, turned, not a ball (balls are lights), slot 8
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] }, opts);
  rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0, sunColor: [0, 0, 0] };
  rend.setShadowBounds([0, 3, 0], 14, [14, 8, 14]);
  rend.setSource(src);
  const f: FrameParams = { ...camera([1, 5, 7], [0, 1, -2]), groundY: 0, time: 1, dt: 0, alpha: 1 };
  return { rend, f };
}

export async function aoImage() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const { rend, f } = aoScene(device);
  const on = (await rend.render(f, true, true))!.pixels!;
  rend.toggles.ao = false;
  const off = (await rend.render(f, true, true))!.pixels!;
  const ids = (await rend.renderIds(f)).ids;
  const luma = (px: typeof on, i: number) => 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
  let nearOn = 0, nearOff = 0, nn = 0, openDiff = 0, no = 0, cubeDiff = 0, nc = 0, footOn = 0, footOff = 0, nf = 0, ballDiff = 0, nb = 0;
  let openChanged = 0, cubeChanged = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * on.bytesPerRow + 4 * x, id = ids[y * W + x]!;
    if (id === 7) { const dd = Math.abs(luma(on, i) - luma(off, i)); cubeDiff = Math.max(cubeDiff, dd); nc++; if (dd) cubeChanged++; continue; }
    if (id === 8) { footOn += luma(on, i); footOff += luma(off, i); nf++; continue; }
    if (id === 9) { ballDiff = Math.max(ballDiff, Math.abs(luma(on, i) - luma(off, i))); nb++; continue; }
    if (id) continue;
    const { o, d } = rayAt(f, x, y);
    if (d[1] >= 0) continue;
    const t = -o[1] / d[1], gx = o[0] + d[0] * t, gz = o[2] + d[2] * t;
    const dt = Math.max(Math.abs(gx + 2), Math.abs(gz + 2)); // distance from the tower's axis (Chebyshev)
    if (dt > 0.55 && dt < 1.0) { nearOn += luma(on, i); nearOff += luma(off, i); nn++; }
    const clear = Math.hypot(gx + 2, gz + 2) > 5 && Math.hypot(gx - 2.6, gz + 1) > 5;
    if (clear) { const dd = Math.abs(luma(on, i) - luma(off, i)); openDiff = Math.max(openDiff, dd); no++; if (dd) openChanged++; }
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { foot: [footOn / nf, footOff / nf], nf, near: [nearOn / nn, nearOff / nn], nn, openDiff, openChanged, no, cubeDiff, cubeChanged, nc, ballDiff, nb, error: err?.message ?? null };
}


/**
 * The seam cavity in the image: a close-up of the front face (z = 0.5) of
 * two stacked unit cubes, ambient light only, AO on against off. Per class
 * of front-face pixel (|x| < 0.3), the luma ratio on / off: the shared edge
 * (within 0.08 m of y = 1, both cubes), mid-face (more than 0.3 m from any
 * horizontal edge) and the free top edge (within 0.08 m of y = 2).
 */
export async function seamImage(opts: RendererOptions = {}) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], 1), box([0, 1.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], 2)];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [W, H] }, opts);
  rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0, sunColor: [0, 0, 0] };
  rend.setShadowBounds([0, 2, 0], 8, [8, 6, 8]);
  rend.setSource(src);
  const f: FrameParams = { ...camera([0.2, 1.3, 2.6], [0, 1.2, 0]), groundY: 0, time: 1, dt: 0, alpha: 1 };
  const on = (await rend.render(f, true, true))!.pixels!;
  rend.toggles.ao = false;
  const off = (await rend.render(f, true, true))!.pixels!;
  const ids = (await rend.renderIds(f)).ids;
  const luma = (px: typeof on, i: number) => 0.2126 * px.data[i]! + 0.7152 * px.data[i + 1]! + 0.0722 * px.data[i + 2]!;
  const acc: Record<'shared' | 'mid' | 'top', [number, number, number]> = { shared: [0, 0, 0], mid: [0, 0, 0], top: [0, 0, 0] };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * on.bytesPerRow + 4 * x, id = ids[y * W + x]!;
    if (id !== 1 && id !== 2) continue;
    const { o, d } = rayAt(f, x, y);
    const t = (0.5 - o[2]) / d[2], hx = o[0] + d[0] * t, hy = o[1] + d[1] * t;
    if (!(t > 0) || Math.abs(hx) >= 0.3 || hy < 0 || hy > 2) continue;
    const e = Math.min(Math.abs(hy - 1), Math.abs(hy), Math.abs(hy - 2));
    const k = Math.abs(hy - 1) < 0.08 ? 'shared' : Math.abs(hy - 2) < 0.08 ? 'top' : e > 0.3 ? 'mid' : null;
    if (!k) continue;
    acc[k][0] += luma(on, i); acc[k][1] += luma(off, i); acc[k][2]++;
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  const r = (a: number[]) => ({ ratio: a[0]! / a[1]!, n: a[2]! });
  return { shared: r(acc.shared), mid: r(acc.mid), top: r(acc.top), error: err?.message ?? null };
}

/**
 * The AO grid the renderer fits as the floor moves: after a frame at each
 * groundY, the grid and whether the volume was reallocated.
 */
export async function aoFloorFit(floors: number[]) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], 1)];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const rend = new Renderer(device, { size: [32, 32] });
  rend.setShadowBounds([0, 2, 0], 10);
  rend.setSource(src);
  const out: { grid: { origin: number[]; voxel: number; dims: number[] }; realloc: boolean }[] = [];
  for (const groundY of floors) {
    const before = rend.ao.volume;
    await rend.render({ ...camera([3, 4, 6], [0, 0.5, 0]), groundY, time: 1, dt: 0, alpha: 1 });
    await device.queue.onSubmittedWorkDone();
    const g = rend.ao.grid;
    out.push({ grid: { origin: [...g.origin], voxel: g.voxel, dims: [...g.dims] }, realloc: rend.ao.volume !== before });
  }
  const err = await device.popErrorScope();
  rend.destroy();
  device.destroy();
  return { out, error: err?.message ?? null };
}

/**
 * The seam scene (two stacked cubes, ambient only) with the default box
 * shading and with aoDiag 'no-seam', the camera `scale` times as far from
 * the target as seamImage's: per-channel byte differences.
 */
export async function seamVsNone(scale: number) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const descs = [box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], 1), box([0, 1.5, 0], [0.5, 0.5, 0.5], [0, 0, 0, 1], 2)];
  const src = new SnapshotSource(device);
  src.reset(descs);
  src.update(snapshotOf(descs), descs);
  const target: V3 = [0, 1.2, 0], eye: V3 = [0.2 * scale, 1.2 + 0.1 * scale, 2.6 * scale];
  const f: FrameParams = { ...camera(eye, target), groundY: 0, time: 1, dt: 0, alpha: 1 };
  const draw = async (opts: RendererOptions) => {
    const rend = new Renderer(device, { size: [W, H] }, opts);
    rend.look = { ...rend.look, bloomMix: 0, fogDensity: 0, sunColor: [0, 0, 0] };
    rend.setShadowBounds([0, 2, 0], 8, [8, 6, 8]);
    rend.setSource(src);
    const px = (await rend.render(f, true, true))!.pixels!;
    const ids = (await rend.renderIds(f)).ids;
    rend.destroy();
    return { px, ids };
  };
  const a = await draw({}), b = await draw({ aoDiag: 'no-seam' });
  let maxDiff = 0, changed = 0, boxPx = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * a.px.bytesPerRow + 4 * x;
    if (a.ids[y * W + x]) boxPx++;
    let d = 0;
    for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(a.px.data[i + c]! - b.px.data[i + c]!));
    maxDiff = Math.max(maxDiff, d);
    if (d) changed++;
  }
  const err = await device.popErrorScope();
  device.destroy();
  return { maxDiff, changed, boxPx, error: err?.message ?? null };
}

// ---------------------------------------------------------------- atmosphere

/** An rgba16float texture read back as rgb tables plus the alpha channel. */
async function readLut(device: GPUDevice, tex: GPUTexture): Promise<{ rgb: { w: number; h: number; data: Float32Array }; alpha: Float32Array }> {
  const w = tex.width, h = tex.height, bytesPerRow = Math.ceil((w * 8) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * h, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex }, { buffer: buf, bytesPerRow }, [w, h]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint16Array(buf.getMappedRange().slice(0));
  buf.destroy();
  const data = new Float32Array(w * h * 3), alpha = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const o = (j * bytesPerRow) / 2 + i * 4;
    for (let k = 0; k < 3; k++) data[(j * w + i) * 3 + k] = fromHalf(raw[o + k]!);
    alpha[j * w + i] = fromHalf(raw[o + 3]!);
  }
  return { rgb: { w, h, data }, alpha };
}

/**
 * The atmosphere passes against their CPU twins, each pass in isolation:
 * the CPU recomputes a pass from the GPU's own inputs (the LUTs read back),
 * so an error is that pass's. Returns the worst relative error per pass
 * (texels sampled with a stride) and the ambient pair.
 */
export async function atmosphereTwins(sun: V3, eyeKm: number, visibility = CLEAR_DAY.visibility) {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const a = { ...CLEAR_DAY, visibility };
  const atmo = new Atmosphere(device);
  const enc = device.createCommandEncoder();
  const cp = enc.beginComputePass();
  atmo.encode(cp, a, sun, eyeKm, 1.3, 0.75);
  cp.end();
  device.queue.submit([enc.finish()]);
  const T = await readLut(device, atmo.transmittance), M = await readLut(device, atmo.multi), S = await readLut(device, atmo.skyView);
  const amb = new Float32Array(await readBuffer(device, atmo.ambient));
  const rel = (g: number, c: number) => Math.abs(g - c) / Math.max(Math.abs(c), 1e-4);
  const worst = { transmittance: 0, multi: 0, sky: 0, skyAlpha: 0, ambient: 0, exposure: 0 };
  let finite = true;
  const check = (vals: ArrayLike<number>) => { for (let i = 0; i < vals.length; i++) if (!Number.isFinite(vals[i]!)) finite = false; };
  [T.rgb.data, M.rgb.data, S.rgb.data, S.alpha, amb].forEach(check);
  for (let j = 0; j < T.rgb.h; j += 3) for (let i = 0; i < T.rgb.w; i += 5) {
    const want = transmittance(a, ...transmittanceHMu((i + 0.5) / T.rgb.w, (j + 0.5) / T.rgb.h));
    for (let k = 0; k < 3; k++) worst.transmittance = Math.max(worst.transmittance, rel(T.rgb.data[(j * T.rgb.w + i) * 3 + k]!, want[k]!));
  }
  for (let j = 0; j < M.rgb.h; j += 5) for (let i = 0; i < M.rgb.w; i += 5) {
    const muS = 2 * ((((i + 0.5) / M.rgb.w) - 0.5 / M.rgb.w) / (1 - 1 / M.rgb.w)) - 1;
    const h = ((((j + 0.5) / M.rgb.h) - 0.5 / M.rgb.h) / (1 - 1 / M.rgb.h)) * (R_TOP - R_GROUND);
    const want = multiScattering(a, T.rgb, muS, h);
    for (let k = 0; k < 3; k++) worst.multi = Math.max(worst.multi, rel(M.rgb.data[(j * M.rgb.w + i) * 3 + k]!, want[k]!));
  }
  const sunLocal: V3 = [Math.hypot(sun[0], sun[2]), sun[1], 0];
  let skyWorstAt: { dir: V3; gpu: number; cpu: number } | null = null;
  for (let j = 0; j < S.rgb.h; j += 7) for (let i = 0; i < S.rgb.w; i += 11) {
    const dir = skyViewDir((i + 0.5) / S.rgb.w, (j + 0.5) / S.rgb.h, eyeKm);
    const [L, t] = skyRadiance(a, T.rgb, M.rgb, sunLocal, dir, eyeKm);
    for (let k = 0; k < 3; k++) {
      // Relative, floored at 0.01 (zenith radiance is about 0.1-0.3): the dimmest below-horizon texels are 0.002.
      const e = Math.abs(S.rgb.data[(j * S.rgb.w + i) * 3 + k]! - L[k]!) / Math.max(L[k]!, 0.01);
      if (e > worst.sky) { worst.sky = e; skyWorstAt = { dir, gpu: S.rgb.data[(j * S.rgb.w + i) * 3 + k]!, cpu: L[k]! }; }
    }
    worst.skyAlpha = Math.max(worst.skyAlpha, Math.abs(S.alpha[j * S.rgb.w + i]! - t));
  }
  const skyAt = (dir: V3): V3 => {
    const [u, v] = skyViewUv(dir, sun, eyeKm);
    const x = Math.min(S.rgb.w - 1, Math.max(0, u * S.rgb.w - 0.5)), y = Math.min(S.rgb.h - 1, Math.max(0, v * S.rgb.h - 0.5));
    const x0 = Math.floor(x), y0 = Math.floor(y), x1 = Math.min(x0 + 1, S.rgb.w - 1), y1 = Math.min(y0 + 1, S.rgb.h - 1), fx = x - x0, fy = y - y0;
    const at = (i: number, j: number, k: number) => S.rgb.data[(j * S.rgb.w + i) * 3 + k]!;
    return [0, 1, 2].map((k) => (at(x0, y0, k) * (1 - fx) + at(x1, y0, k) * fx) * (1 - fy) + (at(x0, y1, k) * (1 - fx) + at(x1, y1, k) * fx) * fy) as V3;
  };
  const hEye = Math.max(eyeKm, 1e-4), lit = distanceToGround(hEye, sun[1]) >= 0 ? 0 : 1;
  const sunC = sampleTransmittance(T.rgb, hEye, sun[1]).map((x, k) => (lit * x * a.sunIlluminance[k]!) / Math.PI) as V3;
  const want = ambientOf(skyAt, sunC, sun, a.groundAlbedo);
  for (let k = 0; k < 3; k++) worst.ambient = Math.max(worst.ambient, rel(amb[k]!, want.sky[k]!), rel(amb[4 + k]!, want.ground[k]!));
  // Adaptation from the GPU's own ambient (its error is the ambient's, checked above).
  const I = meteredIlluminance([amb[0]!, amb[1]!, amb[2]!], [amb[4]!, amb[5]!, amb[6]!], sunC);
  worst.exposure = rel(amb[8]!, adaptedExposure(I, a.sunIlluminance, 1.3, 0.75));
  const err = await device.popErrorScope();
  atmo.destroy();
  device.destroy();
  return { worst, skyWorstAt, finite, ambient: { sky: Array.from(amb.slice(0, 3)), ground: Array.from(amb.slice(4, 7)) }, exposure: amb[8]!, illuminance: amb[9]!, sunIlluminanceLuma: LUMA.reduce((s, w, c) => s + w * a.sunIlluminance[c]!, 0), error: err?.message ?? null };
}

/** One mip level of one layer of an rgba8unorm array texture, as bytes (rows packed). */
async function readLayer(device: GPUDevice, tex: GPUTexture, layer: number, mip: number): Promise<{ n: number; data: Uint8Array }> {
  const n = Math.max(1, tex.width >> mip), bytesPerRow = Math.ceil((n * 4) / 256) * 256;
  const buf = device.createBuffer({ size: bytesPerRow * n, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST });
  const enc = device.createCommandEncoder();
  enc.copyTextureToBuffer({ texture: tex, mipLevel: mip, origin: [0, 0, layer] }, { buffer: buf, bytesPerRow }, [n, n, 1]);
  device.queue.submit([enc.finish()]);
  await buf.mapAsync(GPUMapMode.READ);
  const raw = new Uint8Array(buf.getMappedRange().slice(0));
  buf.destroy();
  const data = new Uint8Array(n * n * 4);
  for (let j = 0; j < n; j++) data.set(raw.subarray(j * bytesPerRow, j * bytesPerRow + n * 4), j * n * 4);
  return { n, data };
}

/**
 * The stone bake (materials.ts) against stoneSample, per layer: the worst
 * difference of sampled level-0 texels (albedo, roughness, normal from
 * central differences, cavity) from the CPU twin, in 8-bit steps, the mean
 * albedo multiplier, how far the level-0 normals are from unit length, tiling (the jump across the wrap against the mean jump between
 * neighbours inside), and the worst mip texel against the average of its
 * four parents.
 */
export async function materialBake() {
  const { device } = await createDevice({ timestamps: false });
  device.pushErrorScope('validation');
  const mats = new Materials(device);
  const out = [];
  for (let layer = 0; layer < STONES.length; layer++) {
    const d0 = await readLayer(device, mats.detail, layer, 0), n0 = await readLayer(device, mats.normal, layer, 0);
    const n = d0.n, at = (t: Uint8Array, i: number, j: number, c: number) => t[((j % n) * n + (i % n)) * 4 + c]!;
    let twin = 0, unit = 0, mean = [0, 0, 0];
    for (let j = 0; j < n; j += 37) for (let i = 0; i < n; i += 29) {
      const s = stoneSample(layer, (i + 0.5) / n, (j + 0.5) / n);
      const texel = MATERIAL_TILE / n, h = (di: number, dj: number) => stoneSample(layer, (((i + di + n) % n) + 0.5) / n, (((j + dj + n) % n) + 0.5) / n).height;
      const nrm = heightNormal(h(-1, 0), h(1, 0), h(0, -1), h(0, 1), texel);
      const want = [...s.albedo.map((x) => Math.min(Math.max(x * 0.5, 0), 1)), Math.min(Math.max(s.rough, 0), 1), ...nrm.map((x) => x * 0.5 + 0.5), Math.min(Math.max(s.cavity, 0), 1)];
      const got = [0, 1, 2, 3].map((c) => at(d0.data, i, j, c)).concat([0, 1, 2, 3].map((c) => at(n0.data, i, j, c)));
      for (let k = 0; k < 8; k++) twin = Math.max(twin, Math.abs(got[k]! - want[k]! * 255));
    }
    let jumpIn = 0, jumpWrap = 0, cnt = 0;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      for (let c = 0; c < 3; c++) mean[c] = mean[c]! + (2 * at(d0.data, i, j, c)) / 255 / (n * n);
      const v = [0, 1, 2].map((c) => at(n0.data, i, j, c) / 127.5 - 1);
      unit = Math.max(unit, Math.abs(Math.hypot(...v) - 1));
      if (i === n - 1) jumpWrap += Math.abs(at(d0.data, 0, j, 0) - at(d0.data, i, j, 0)) + Math.abs(at(n0.data, 0, j, 0) - at(n0.data, i, j, 0));
      else if (i === n - 2) { jumpIn += Math.abs(at(d0.data, i + 1, j, 0) - at(d0.data, i, j, 0)) + Math.abs(at(n0.data, i + 1, j, 0) - at(n0.data, i, j, 0)); cnt++; }
    }
    let mip = 0;
    for (const t of [mats.detail, mats.normal]) for (const m of [1, 4, 8]) {
      const hi = await readLayer(device, t, layer, m - 1), lo = await readLayer(device, t, layer, m);
      for (let j = 0; j < lo.n; j += Math.max(1, lo.n >> 4)) for (let i = 0; i < lo.n; i += Math.max(1, lo.n >> 4)) for (let c = 0; c < 4; c++) {
        const avg = [[0, 0], [1, 0], [0, 1], [1, 1]].reduce((s, [a, b]) => s + hi.data[((2 * j + b!) * hi.n + 2 * i + a!) * 4 + c]!, 0) / 4;
        mip = Math.max(mip, Math.abs(lo.data[(j * lo.n + i) * 4 + c]! - avg));
      }
    }
    out.push({ stone: STONES[layer]!, twin, mean, unit, tile: { wrap: jumpWrap / n, inside: jumpIn / cnt }, mip });
  }
  const err = await device.popErrorScope();
  mats.destroy();
  device.destroy();
  return { layers: out, error: err?.message ?? null };
}

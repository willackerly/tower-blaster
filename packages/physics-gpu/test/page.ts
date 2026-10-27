// Page-side drivers for the GPU physics tests (bundled by loadBundle).
import { createDevice, sharedDevice, isSoftwareAdapter, readBuffer, type Readback } from '@tb/gpu';
import { boundingRadius, groundManifold, NO_AXIS, quatNormalize, shapeManifold, spherePairs, supportArea, type Manifold as CpuManifold } from '@tb/geom';
import { Body, BodyProps, field, Manifold, readField, readStruct, Shape, SolverBody, SolverContact, SolverRecord, writeStruct } from '@tb/schema';
import type { BodyDesc, InputEvent, Quat, Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { bodiesAt } from '@tb/engine-api';
import { AvbdSolver, Broadphase, Coloring, DEFAULT_DISPATCH, GpuAvbdEngine, type GpuEngineOptions, type GpuRestitutionStats, type HessianForm, MAX_COLORS, Narrowphase, restitutionStatsOf } from '../src/index.ts';
import { type AvbdParams, DEFAULT_AVBD } from '@tb/physics-ref';
import type { SceneDesc } from '@tb/engine-api';
import { colorGraph } from '@tb/physics-ref';
import { axisSlack } from './sat-slack.ts';

export interface BroadCase {
  kind: 'scenario' | 'cloud' | 'pile';
  scenario?: string;
  params?: Record<string, number>;
  n?: number;
  margin: number;
  maxPairs?: number;
  seed?: number;
  tableBits?: number;
}

function input(c: BroadCase): { centers: Float64Array; radii: Float64Array } {
  if (c.kind === 'scenario') {
    const scene = buildScenario(c.scenario!, c.params ?? {}, c.seed ?? 1);
    const bodies = bodiesAt(scene, Number.MAX_SAFE_INTEGER);
    return { centers: Float64Array.from(bodies.flatMap((b) => b.pos)), radii: Float64Array.from(bodies.map((b) => boundingRadius(b.shape))) };
  }
  const n = c.n!;
  let s = (c.seed ?? 1) >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const centers = new Float64Array(3 * n), radii = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (let k = 0; k < 3; k++) centers[3 * i + k] = c.kind === 'pile' ? 0.001 * r() : -15 + 30 * r();
    radii[i] = c.kind === 'pile' ? 0.5 : 0.1 + 0.9 * r();
  }
  return { centers, radii };
}

/**
 * Run the GPU broadphase and check it against the double-precision oracle.
 * f32 rounding can flip pairs within about 1e-4 of touching, so the GPU set
 * must contain every pair at margin - eps and only pairs at margin + eps.
 */
export async function broadphase(c: BroadCase, repeat = 1) {
  const { centers, radii } = input(c);
  const n = radii.length;
  const { device } = await sharedDevice();
  const spheres = new Float32Array(4 * Math.max(1, n));
  let rmax = 0;
  for (let i = 0; i < n; i++) {
    spheres.set([centers[3 * i]!, centers[3 * i + 1]!, centers[3 * i + 2]!, radii[i]!], 4 * i);
    rmax = Math.max(rmax, radii[i]!);
  }
  const sb = device.createBuffer({ size: spheres.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(sb, 0, spheres);
  const oracleExact = spherePairs(centers, radii, c.margin);
  const maxPairs = c.maxPairs ?? Math.max(16, Math.ceil(oracleExact.length * 1.2) + 64);
  const bp = new Broadphase(device, sb, Math.max(1, n), maxPairs, c.tableBits);
  const runs: number[][] = [];
  let total: number[] = [];
  device.pushErrorScope('validation');
  for (let rep = 0; rep < repeat; rep++) {
    const enc = device.createCommandEncoder();
    bp.encode(enc, n, { cellSize: Math.max(1e-3, 2 * rmax + c.margin), margin: c.margin });
    device.queue.submit([enc.finish()]);
    total = Array.from(new Uint32Array(await readBuffer(device, bp.total)));
    runs.push(Array.from(new Uint32Array(await readBuffer(device, bp.pairs, Math.max(8, total[3]! * 8)))).slice(0, 2 * total[3]!));
  }
  const error = await device.popErrorScope();
  const flat = runs[0]!;
  const got: Array<[number, number]> = [];
  for (let k = 0; k < flat.length; k += 2) got.push([flat[k]!, flat[k + 1]!]);
  const eps = 1e-4;
  const key = (p: [number, number]) => p[0] * 1e7 + p[1];
  const gotKeys = new Set(got.map(key));
  const lo = spherePairs(centers, radii, c.margin - eps), hi = new Set(spherePairs(centers, radii, c.margin + eps).map(key));
  const groupedByI = got.every((p, k) => k === 0 || got[k - 1]![0] <= p[0]);
  const res = {
    n, error: error?.message ?? null,
    written: total[3], required: total[5], indirectGroups: total[0], oracle: oracleExact.length,
    duplicates: got.length - gotKeys.size,
    ordered: got.every((p) => p[0] < p[1]),
    groupedByI,
    missing: lo.filter((p) => !gotKeys.has(key(p))).length,
    extra: got.filter((p) => !hi.has(key(p))).length,
    deterministic: runs.every((r) => r.length === flat.length && r.every((x, k) => x === flat[k])),
  };
  bp.destroy();
  sb.destroy();
  return res;
}

// ---------- narrowphase ----------

/** Upload bodies as Body records plus a Shape table (one shape per body, for simplicity). */
function uploadBodies(device: GPUDevice, bodies: BodyDesc[]) {
  const n = Math.max(1, bodies.length);
  const bv = new DataView(new ArrayBuffer(Body.size * n)), sv = new DataView(new ArrayBuffer(Shape.size * n));
  bodies.forEach((b, i) => {
    writeStruct(bv, Body, i, { pos: b.pos, rot: b.rot, invMass: 1, linVel: [0, 0, 0], angVel: [0, 0, 0], flags: 1, shape: i });
    writeStruct(sv, Shape, i, b.shape.kind === 'box' ? { half: b.shape.half, kind: 0 } : { half: [b.shape.radius, 0, 0], kind: 1 });
  });
  const mk = (v: DataView) => {
    const buf = device.createBuffer({ size: v.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(buf, 0, v.buffer);
    return buf;
  };
  return { bodies: mk(bv), shapes: mk(sv) };
}

/** The reference manifold for pair (a, b), normal from a to b. */
function cpuPair(a: BodyDesc, b: BodyDesc, margin: number, reduce = true, prevAxis = NO_AXIS): CpuManifold | null {
  return shapeManifold(a.shape, a.pos, a.rot, b.shape, b.pos, b.rot, margin, reduce, prevAxis);
}

interface Gpu { count: number; normal: number[]; feature: number; axis: number; points: number[][] }
function decode(view: DataView, i: number): Gpu {
  const r = readStruct(view, Manifold, i);
  return { count: r.count![0]!, normal: r.normal!, feature: r.feature![0]!, axis: r.axis![0]!, points: [r.p0!, r.p1!, r.p2!, r.p3!].slice(0, r.count![0]!) };
}

/**
 * A reduction tie, not an error: same count, normal and deepest depth as the
 * reference, and every GPU point is one of the reference's unreduced
 * candidates. f32 noise can then legitimately keep a different point among
 * near-equal scores. The reduction scores spread exactly, so a true tie also
 * keeps (within 1%) the reference's support area; anything less is a bug.
 */
function tieOnly(g: Gpu, c: CpuManifold | null, all: CpuManifold | null, tol: number): boolean {
  if (!c || !all || g.count !== c.points.length) return false;
  const dn = g.normal[0]! * c.normal[0] + g.normal[1]! * c.normal[1] + g.normal[2]! * c.normal[2];
  if (dn < 1 - 5e-7) return false;
  const deep = Math.max(...c.points.map((q) => q.depth)), gdeep = Math.max(...g.points.map((p) => p[3]!));
  if (Math.abs(deep - gdeep) > tol) return false;
  if (!g.points.every((p) => all.points.some((q) => Math.hypot(q.point[0] - p[0]!, q.point[1] - p[1]!, q.point[2] - p[2]!) < tol && Math.abs(q.depth - p[3]!) < tol))) return false;
  // A tie must keep the support as well spread as the reference does.
  return supportArea(g.points.map((p) => [p[0]!, p[1]!, p[2]!] as Vec3), c.normal) >= 0.99 * supportArea(c.points.map((q) => q.point), c.normal) - 1e-6;
}

/** Match GPU against CPU: same count and SAT axis, normal within 1e-3 rad, every point paired within tol. */
function agrees(g: Gpu, c: CpuManifold | null, tol: number): boolean {
  const cc = c ? c.points.length : 0;
  if (g.count !== cc) return false;
  if (!c || cc === 0) return true;
  if (g.axis !== c.axis) return false;
  const dn = g.normal[0]! * c.normal[0] + g.normal[1]! * c.normal[1] + g.normal[2]! * c.normal[2];
  if (dn < 1 - 5e-7) return false;
  const left = [...c.points];
  for (const p of g.points) {
    const k = left.findIndex((q) => Math.hypot(q.point[0] - p[0]!, q.point[1] - p[1]!, q.point[2] - p[2]!) < tol && Math.abs(q.depth - p[3]!) < tol);
    if (k < 0) return false;
    left.splice(k, 1);
  }
  return true;
}

export interface NarrowCase {
  kind: 'random' | 'scenario'; pairs?: number; spheres?: number; scenario?: string; params?: Record<string, number>; margin: number; seed?: number;
  /** per-body sweep drawn from [0, sweep) */ sweep?: number;
  /** give each pair a random last-step SAT axis (0..14, or none), as AvbdSolver.match would */ prevAxes?: boolean;
}

function randomPairs(c: NarrowCase): { bodies: BodyDesc[]; pairs: Array<[number, number]> } {
  let s = (c.seed ?? 1) >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const u = (lo: number, hi: number) => lo + (hi - lo) * r();
  const quat = (): Quat => quatNormalize([u(-1, 1), u(-1, 1), u(-1, 1), u(0.05, 1)]);
  const body = (pos: Vec3, sphere: boolean): BodyDesc => ({
    shape: sphere ? { kind: 'sphere', radius: u(0.1, 1) } : { kind: 'box', half: [u(0.1, 1), u(0.1, 1), u(0.1, 1)] },
    pos, rot: quat(), linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0,
  });
  const bodies: BodyDesc[] = [], pairs: Array<[number, number]> = [];
  for (let k = 0; k < c.pairs!; k++) {
    // Each side independently a sphere with probability `spheres`, so all
    // four shape orders (box-box, box-sphere, sphere-box, sphere-sphere) occur.
    bodies.push(body([u(-50, 50), u(0, 5), u(-50, 50)], r() < (c.spheres ?? 0)));
    const a = bodies[bodies.length - 1]!.pos;
    bodies.push(body([a[0] + u(-1.6, 1.6), a[1] + u(-1.6, 1.6), a[2] + u(-1.6, 1.6)], r() < (c.spheres ?? 0)));
    pairs.push([2 * k, 2 * k + 1]);
  }
  return { bodies, pairs };
}

/**
 * Run the narrowphase on explicit pairs (random) or on broadphase output
 * (scenario) and compare every manifold with the double-precision oracle.
 */
export async function narrowphase(c: NarrowCase) {
  const { device } = await sharedDevice();
  let bodies: BodyDesc[];
  let pairs: Array<[number, number]>;
  if (c.kind === 'random') ({ bodies, pairs } = randomPairs(c));
  else {
    const scene = buildScenario(c.scenario!, c.params ?? {}, c.seed ?? 1);
    bodies = bodiesAt(scene, Number.MAX_SAFE_INTEGER);
    const centers = bodies.flatMap((b) => b.pos), radii = bodies.map((b) => boundingRadius(b.shape));
    pairs = spherePairs(centers, radii, c.margin);
  }
  const n = bodies.length;
  const { bodies: bb, shapes: sb } = uploadBodies(device, bodies);
  const pb = device.createBuffer({ size: Math.max(8, pairs.length * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(pb, 0, Uint32Array.from(pairs.flat()));
  const tb = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(tb, 0, Uint32Array.from([Math.ceil(pairs.length / 64), 1, 1, pairs.length, 0, pairs.length, 0, 0]));
  let sw = 7;
  const sweeps = bodies.map(() => (c.sweep ?? 0) * ((sw = (Math.imul(sw, 1664525) + 1013904223) >>> 0) / 2 ** 32));
  const sweepBuf = device.createBuffer({ size: Math.max(16, n * 4), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(sweepBuf, 0, Float32Array.from(sweeps));
  // The oracle sees the margins the GPU computes in f32.
  const f32 = (x: number) => Math.fround(x);
  const pairMargin = (i: number, j: number) => f32(f32(f32(c.margin) + f32(sweeps[i]!)) + f32(sweeps[j]!));
  const groundMargin = (i: number) => f32(f32(c.margin) + f32(sweeps[i]!));
  let ps = 5;
  const hints = pairs.map(() => (c.prevAxes ? Math.floor(16 * ((ps = (Math.imul(ps, 1664525) + 1013904223) >>> 0) / 2 ** 32)) : 15)).map((h) => (h === 15 ? NO_AXIS : h));
  const prevBuf = device.createBuffer({ size: Math.max(16, pairs.length * 8), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  device.queue.writeBuffer(prevBuf, 0, Uint32Array.from(hints.flatMap((h) => [0, h])));
  const np = new Narrowphase(device, bb, sb, pb, tb, Math.max(1, n), Math.max(1, pairs.length), sweepBuf, prevBuf);
  device.pushErrorScope('validation');
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  np.encode(pass, n, { margin: c.margin, ground: { y: 0 } });
  pass.end();
  device.queue.submit([enc.finish()]);
  const error = await device.popErrorScope();
  const mv = new DataView(await readBuffer(device, np.manifolds));
  const gv = new DataView(await readBuffer(device, np.groundManifolds));
  const tol = 2e-4 * (1 + 0); // f32 vs f64 on coordinates of magnitude <= 50
  let pairMismatch = 0, pairTies = 0, contacts = 0, groundMismatch = 0, groundTies = 0, groundContacts = 0;
  const examples: unknown[] = [];
  pairs.forEach(([i, j], k) => {
    const g = decode(mv, k), cpu = cpuPair(bodies[i]!, bodies[j]!, pairMargin(i, j), true, hints[k]);
    if (cpu) contacts++;
    const t = tol * (1 + Math.abs(bodies[i]!.pos[0]) / 25);
    if (!agrees(g, cpu, t)) {
      if (g.axis === cpu?.axis && tieOnly(g, cpu, cpuPair(bodies[i]!, bodies[j]!, pairMargin(i, j), false, hints[k]), t)) { pairTies++; return; }
      pairMismatch++;
      if (examples.length < 3) examples.push({ k, gpu: g, cpu });
    }
  });
  bodies.forEach((b, i) => {
    const g = decode(gv, i);
    const cpu = groundManifold(b.shape, b.pos, b.rot, 0, groundMargin(i));
    if (cpu) groundContacts++;
    if (!agrees(g, cpu, tol * 4)) {
      const all = groundManifold(b.shape, b.pos, b.rot, 0, groundMargin(i), false);
      if (tieOnly(g, cpu, all, tol * 4)) { groundTies++; return; }
      groundMismatch++;
      if (examples.length < 6) examples.push({ ground: i, gpu: g, cpu, y: b.pos[1] });
    }
  });
  np.destroy();
  for (const b of [bb, sb, pb, tb, sweepBuf, prevBuf]) b.destroy();
  return { error: error?.message ?? null, pairs: pairs.length, contacts, pairMismatch, pairTies, groundContacts, groundMismatch, groundTies, examples };
}

export interface ColorCase {
  kind: 'random' | 'scenario';
  /** random: nodes, edges (some slots left empty), seed */
  n?: number;
  edges?: number;
  seed?: number;
  scenario?: string;
  params?: Record<string, number>;
  margin?: number;
  rounds?: number;
}

/**
 * Colour a contact graph on the GPU and compare with the reference colouring
 * (physics-ref colorGraph) of the same graph. Random graphs are written as
 * fake manifolds (only count, a and b matter); scenarios run the GPU
 * broadphase and narrowphase first and take the graph from their output.
 */
export async function coloring(c: ColorCase) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  let n: number, slots: number, manifolds: GPUBuffer, total: GPUBuffer;
  const owned: Array<{ destroy(): void }> = [];
  if (c.kind === 'random') {
    n = c.n!;
    slots = c.edges!;
    let s = (c.seed ?? 1) >>> 0;
    const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
    const view = new DataView(new ArrayBuffer(Math.max(96, slots * Manifold.size)));
    const seen = new Set<string>();
    for (let k = 0; k < slots; k++) {
      let a = Math.floor(r() * n), b = Math.floor(r() * n);
      if (a > b) [a, b] = [b, a];
      // Every 7th slot is empty (count 0), as for pairs whose shapes do not touch.
      const ok = a !== b && !seen.has(`${a},${b}`) && k % 7 !== 3;
      if (ok) seen.add(`${a},${b}`);
      writeStruct(view, Manifold, k, { count: [ok ? 1 : 0], a: [a], b: [b] });
    }
    manifolds = device.createBuffer({ size: view.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    device.queue.writeBuffer(manifolds, 0, view.buffer);
    total = device.createBuffer({ size: 32, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.INDIRECT | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(total, 0, Uint32Array.from([Math.ceil(slots / 64), 1, 1, slots, 0, slots, 0, 0]));
    owned.push(manifolds, total);
  } else {
    const scene = buildScenario(c.scenario!, c.params ?? {}, c.seed ?? 1);
    const bodies = bodiesAt(scene, Number.MAX_SAFE_INTEGER);
    n = bodies.length;
    const margin = c.margin ?? 0.05;
    const { bodies: bb, shapes: sb } = uploadBodies(device, bodies);
    const spheres = device.createBuffer({ size: Math.max(16, n * 16), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(spheres, 0, Float32Array.from(bodies.flatMap((b) => [...b.pos, boundingRadius(b.shape)])));
    const rmax = Math.max(...bodies.map((b) => boundingRadius(b.shape)));
    const maxPairs = 16 * n;
    const bp = new Broadphase(device, spheres, n, maxPairs);
    const np = new Narrowphase(device, bb, sb, bp.pairs, bp.total, n, maxPairs);
    const enc = device.createCommandEncoder();
    bp.encode(enc, n, { cellSize: 2 * rmax + margin, margin });
    const pass = enc.beginComputePass();
    np.encode(pass, n, { margin, ground: { y: 0 } });
    pass.end();
    device.queue.submit([enc.finish()]);
    manifolds = np.manifolds;
    total = bp.total;
    slots = new Uint32Array(await readBuffer(device, total))[3]!;
    owned.push(bp, np, spheres, bb, sb);
  }
  const col = new Coloring(device, manifolds, total, Math.max(1, n), Math.max(1, slots), c.rounds ?? 64);
  const t0 = performance.now();
  const enc = device.createCommandEncoder();
  col.encode(enc, n);
  device.queue.submit([enc.finish()]);
  const [colorsB, orderB, startB, dispB, infoB, manB, rsB, rlB, adjB, slotB] = await Promise.all([col.colors, col.order, col.colorStart, col.dispatch, col.info, manifolds, col.rowStart, col.rowLength, col.adj, col.adjSlot].map((b) => readBuffer(device, b)));
  const wallMs = performance.now() - t0;
  const error = await device.popErrorScope();
  const colors = [...new Uint32Array(colorsB!).slice(0, n)];
  const order = [...new Uint32Array(orderB!).slice(0, n)];
  const start = [...new Uint32Array(startB!)];
  const disp = [...new Uint32Array(dispB!)];
  const info = [...new Uint32Array(infoB!)];
  // Reference colouring of the graph the GPU saw.
  const mv = new DataView(manB!);
  const adj: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  let edges = 0;
  for (let k = 0; k < slots; k++) {
    const m = readStruct(mv, Manifold, k);
    if (!m.count![0]) continue;
    adj[m.a![0]!]!.add(m.b![0]!); adj[m.b![0]!]!.add(m.a![0]!);
    edges++;
  }
  const ref = [...colorGraph(adj.map((s) => [...s]))];
  // Rows: every slot with points touching body i, ascending, with the right neighbour.
  const rs = new Uint32Array(rsB!), rl = new Uint32Array(rlB!), ga = new Uint32Array(adjB!), gs = new Uint32Array(slotB!);
  const expectRows: Array<Array<[number, number]>> = Array.from({ length: n }, () => []);
  for (let k = 0; k < slots; k++) {
    const m = readStruct(mv, Manifold, k);
    if (!m.count![0]) continue;
    expectRows[m.a![0]!]!.push([k, m.b![0]!]);
    expectRows[m.b![0]!]!.push([k, m.a![0]!]);
  }
  const rowsMatch = expectRows.every((row, i) => rl[i] === row.length && row.every(([k, j], q) => gs[rs[i]! + q] === k && ga[rs[i]! + q] === j));
  const used = n ? Math.max(...ref) + 1 : 0;
  const expectOrder = Array.from({ length: n }, (_, i) => i).sort((i, j) => ref[i]! - ref[j]! || i - j);
  const expectStart = Array.from({ length: MAX_COLORS + 1 }, (_, k) => ref.filter((x) => x < k).length);
  const firstMismatch = colors.findIndex((x, i) => x !== ref[i]);
  col.destroy();
  for (const o of owned) o.destroy();
  return {
    error: error?.message ?? null, n, edges, colorsUsed: info[0], uncolored: info[1], overflow: info[2], refColors: used,
    colorsMatch: firstMismatch < 0, firstMismatch, rowsMatch, orderMatch: order.every((x, k) => x === expectOrder[k]),
    startMatch: start.every((x, k) => x === expectStart[k]),
    dispatchMatch: Array.from({ length: MAX_COLORS }, (_, k) => disp[3 * k] === Math.ceil((expectStart[k + 1]! - expectStart[k]!) / 64) && disp[3 * k + 1] === 1 && disp[3 * k + 2] === 1).every(Boolean),
    maxDegree: adj.reduce((m, s) => Math.max(m, s.size), 0), wallMs,
  };
}

export interface PlainSnapshot { step: number; pos: number[]; rot: number[]; linVel: number[]; angVel: number[] }

/** Body `body`'s velocities set to these after `step` steps, as a reference test sets them mid-run (the engine has no setter). */
export interface Kick { step: number; body: number; linVel: Vec3; angVel: Vec3 }

/**
 * Run a scene on the GPU engine; snapshot every `every` steps (and at the end).
 * withContacts: also an FNV-1a digest of the whole contact buffer (both history
 * halves: every point's record, dual state included) after the last step, and
 * how many points of the last step's half are in use.
 */
export async function simulateGpu(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}, every = 0, opts: Omit<GpuEngineOptions, 'device'> = {}, kicks: Kick[] = [], withContacts = false) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  await e.init(scene);
  const bodyBuf = (e as unknown as { parts: { bodies: GPUBuffer } }).parts.bodies;
  // Queue writes run in order with the submitted steps.
  const kick = (k: Kick) => {
    device.queue.writeBuffer(bodyBuf, k.body * Body.size + field(Body, 'linVel').offset, Float32Array.from(k.linVel));
    device.queue.writeBuffer(bodyBuf, k.body * Body.size + field(Body, 'angVel').offset, Float32Array.from(k.angVel));
  };
  const snaps: PlainSnapshot[] = [];
  const take = async () => {
    const s = await e.snapshot();
    snaps.push({ step: e.stepIndex, pos: [...s.pos], rot: [...s.rot], linVel: [...s.linVel], angVel: [...s.angVel] });
  };
  await take();
  const t0 = performance.now();
  let maxColors = 0, worst = { pairsRequired: 0, pairsWritten: 0, uncolored: 0, colorOverflow: 0 };
  for (let i = 0; i < steps; i++) {
    for (const k of kicks) if (k.step === i) kick(k);
    e.step();
    if (every && (i + 1) % every === 0 && i + 1 < steps) {
      await take();
      const d = await e.diagnostics();
      maxColors = Math.max(maxColors, d.colors);
      if (d.pairsRequired > d.pairsWritten || d.uncolored || d.colorOverflow) worst = d;
    }
  }
  await take();
  const wallMs = performance.now() - t0;
  const d = await e.diagnostics();
  maxColors = Math.max(maxColors, d.colors);
  if (d.pairsRequired > d.pairsWritten || d.uncolored || d.colorOverflow) worst = d;
  let contacts: { digest: number; used: number } | null = null;
  if (withContacts) {
    const { solver } = e.probeParts();
    const words = new Uint32Array(await readBuffer(device, solver.contacts));
    let h = 0x811c9dc5;
    for (const w of words) h = Math.imul(h ^ w, 0x01000193) >>> 0;
    const counts = await solver.slotPoints(solver.maxPairs, solver.capacity);
    contacts = { digest: h, used: [...counts.pairs, ...counts.ground].reduce((a, b) => a + b, 0) };
  }
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, snaps, maxColors, worst, wallMs, contacts };
}

/**
 * A run with a snapshot after every step (snaps[0] is the start) and, if
 * `stats`, the restitution pass's stats after every step (as
 * GpuAvbdEngine.restitutionStats; null while it is off), and `live`, what
 * GpuAvbdEngine.restitutionStats() itself reads after the last step. Each step's bodies
 * (and the pass's state) are copied on the GPU into a history read once at
 * the end, so the steps are not held up by a read each.
 */
export async function steppedRun(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'> = {}, stats = false) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  await e.init(scene);
  const inner = e as unknown as { n: number; capacity: number; parts: { bodies: GPUBuffer; bp: { total: GPUBuffer }; solver: AvbdSolver } };
  const { bodies, bp, solver } = inner.parts;
  const bodyBytes = inner.capacity * Body.size;
  const slots = stats ? solver.restSlots : null;
  const slotBytes = slots ? slots.size : 0;
  const mk = (size: number) => device.createBuffer({ size: Math.max(16, size), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const hist = mk((steps + 1) * bodyBytes), shist = slots ? mk(steps * slotBytes) : null, thist = slots ? mk(steps * 32) : null;
  const ns = [inner.n];
  const copy = (k: number) => {
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(bodies, 0, hist, k * bodyBytes, bodyBytes);
    if (slots && k > 0) {
      enc.copyBufferToBuffer(slots, 0, shist!, (k - 1) * slotBytes, slotBytes);
      enc.copyBufferToBuffer(bp.total, 0, thist!, (k - 1) * 32, 32);
    }
    device.queue.submit([enc.finish()]);
  };
  copy(0);
  for (let k = 1; k <= steps; k++) {
    e.step();
    copy(k);
    ns.push(inner.n);
  }
  const h = await readBuffer(device, hist);
  const snaps: PlainSnapshot[] = ns.map((n, k) => {
    const buf = h.slice(k * bodyBytes, k * bodyBytes + Math.max(1, n) * Body.size);
    const get = (name: string, c: number) => Array.from(readField(buf, Body, name, n, new Float64Array(c * n)));
    return { step: k, pos: get('pos', 3), rot: get('rot', 4), linVel: get('linVel', 3), angVel: get('angVel', 3) };
  });
  const st: Array<GpuRestitutionStats | null> = [];
  if (stats) {
    if (shist) {
      const [sh, th] = [await readBuffer(device, shist), new Uint32Array(await readBuffer(device, thist!))];
      for (let k = 0; k < steps; k++) st.push(restitutionStatsOf(sh.slice(k * slotBytes, (k + 1) * slotBytes), th[8 * k + 3]!, solver.maxPairs, ns[k + 1]!));
    } else for (let k = 0; k < steps; k++) st.push(null);
  }
  // The engine's own readback of the last step's pass, to hold against the history's.
  const live = stats ? await e.restitutionStats() : null;
  const diagnostics = await e.diagnostics();
  const error = await device.popErrorScope();
  for (const b of [hist, shist, thist]) b?.destroy();
  e.dispose();
  return { error: error?.message ?? null, snaps, stats: st, live, diagnostics };
}

/**
 * A run poked once after `at` steps, as the reference's tests poke a world
 * mid-run: every body's linear velocity gains dv[body] (read back, added and
 * written as f32), and each body in `lift` is raised by `by` m. Then
 * steps - at more steps. Returns the largest linear speed over the last `win`
 * steps, the largest rise of a lifted body above where it was before the lift
 * after each step from the poke on, up to `riseSteps` (both read every step,
 * there only), and the final snapshot.
 */
export async function pokedRun(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>,
  poke: { at: number; dv?: Vec3[]; lift?: number[]; by?: number; win?: number; riseSteps?: number }) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  await e.init(scene);
  const bodyBuf = (e as unknown as { parts: { bodies: GPUBuffer } }).parts.bodies;
  const { at, dv = [], lift = [], by = 0, win = 0, riseSteps = 0 } = poke;
  let maxV = 0, y0: number[] = [];
  const rise: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) {
    if (i === at) {
      const s = await e.snapshot();
      dv.forEach((d, b) => {
        const v = [0, 1, 2].map((k) => s.linVel[3 * b + k]! + d[k]!);
        device.queue.writeBuffer(bodyBuf, b * Body.size + field(Body, 'linVel').offset, Float32Array.from(v));
      });
      y0 = lift.map((b) => s.pos[3 * b + 1]!);
      lift.forEach((b, k) => device.queue.writeBuffer(bodyBuf, b * Body.size + field(Body, 'pos').offset + 4, Float32Array.of(y0[k]! + by)));
    }
    e.step();
    const inWin = i >= steps - win, inRise = lift.length > 0 && i >= at && i < at + riseSteps;
    if (inWin || inRise) {
      const s = await e.snapshot();
      if (inWin) for (let b = 0; b < s.count; b++) maxV = Math.max(maxV, Math.hypot(s.linVel[3 * b]!, s.linVel[3 * b + 1]!, s.linVel[3 * b + 2]!));
      if (inRise) rise.push(Math.max(...lift.map((b, k) => s.pos[3 * b + 1]! - y0[k]!)));
    }
  }
  const s = await e.snapshot();
  const wallMs = performance.now() - t0;
  const final: PlainSnapshot = { step: e.stepIndex, pos: [...s.pos], rot: [...s.rot], linVel: [...s.linVel], angVel: [...s.angVel] };
  const d = await e.diagnostics();
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, maxV, rise, final, diagnostics: d, wallMs };
}


/**
 * The Rapier push() test on the GPU engine: inputs pushed mid-run (one for a
 * past step, two for the same step around it) against the same events
 * recorded into scene.inputs. Returns both final snapshots.
 */
export async function pushReplay(steps: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const ball = (x: number, radius = 0.4): BodyDesc => ({ shape: { kind: 'sphere', radius }, pos: [x, 3, -6], rot: [0, 0, 0, 1], linVel: [0, 0, 12], angVel: [0, 0, 0], density: 5, friction: 0.5, restitution: 0.1, tag: -1 });
  const base = buildScenario('S1', { F: 2, H: 4, gap: 0.02 });
  // Room for the three pushes; the replay is created with the same options.
  const opts = { device, capacity: base.bodies.length + 4 };
  // Rejections leave the queue untouched: beyond capacity, a body larger than
  // the cells were sized for, and (no options) any push past the scene.
  const rejects = async (o: object, evs: InputEvent[]) => {
    const e = new GpuAvbdEngine({}, { device, ...o });
    await e.init(base);
    let message: string | null = null;
    try { e.push(evs); } catch (err) { message = (err as Error).message; }
    for (let i = 0; i < 6; i++) e.step();
    const count = (await e.snapshot()).count;
    e.dispose();
    return { message, count };
  };
  const rejected = {
    capacity: await rejects({ capacity: base.bodies.length + 2 }, [0, 1, 2].map((k) => ({ step: 5, kind: 'spawn', body: ball(k) }))),
    radius: await rejects({ capacity: base.bodies.length + 1 }, [{ step: 5, kind: 'spawn', body: ball(0, 2) }]),
    noRoom: await rejects({}, [{ step: 5, kind: 'spawn', body: ball(0) }]),
    // spare reserves room beyond the scene without naming a capacity.
    spare: await rejects({ spare: 2 }, [0, 1, 2].map((k) => ({ step: 5, kind: 'spawn', body: ball(k) }))),
    spareFits: await rejects({ spare: 3 }, [0, 1, 2].map((k) => ({ step: 5, kind: 'spawn', body: ball(k) }))),
  };
  const live = new GpuAvbdEngine({}, opts);
  await live.init({ ...base, inputs: [{ step: 30, kind: 'spawn', body: ball(0) }] });
  const pushedAt: InputEvent[] = [{ step: 30, kind: 'spawn', body: ball(0) }];
  for (let i = 0; i < steps; i++) {
    if (i === 10) {
      const evs: InputEvent[] = [{ step: 20, kind: 'spawn', body: ball(10) }, { step: 3, kind: 'spawn', body: ball(-10) }, { step: 20, kind: 'spawn', body: ball(20) }];
      live.push(evs);
      pushedAt.push(...evs.map((e) => ({ ...e, step: Math.max(e.step, i) })));
    }
    live.step();
  }
  const a = await live.snapshot();
  live.dispose();
  const replay = new GpuAvbdEngine({}, opts);
  await replay.init({ ...base, inputs: [...pushedAt].sort((x, y) => x.step - y.step) });
  for (let i = 0; i < steps; i++) replay.step();
  const b = await replay.snapshot();
  replay.dispose();
  const error = await device.popErrorScope();
  const plain = (s: typeof a) => ({ count: s.count, pos: [...s.pos], rot: [...s.rot] });
  return { error: error?.message ?? null, n: base.bodies.length, live: plain(a), replay: plain(b), rejected };
}

/**
 * Step a scene and check the solver's pair history (AvbdSolver.match): for
 * every pair this step, prev must name its slot in last step's pair list
 * (or NONE when the pair is new) and that slot's manifold axis. Then check
 * the narrowphase used it: each box-box pair's axis must be the reference
 * manifold's from the same f32 state given that hint (hinted counts the
 * pairs where the hint changed the reference's answer). presenceMismatch
 * counts pairs where only one side found a manifold: rounding at a clip
 * plane, which the narrowphase tests bound. axisTies counts the axis
 * mismatches where the GPU's axis is one the reference's own choice was
 * within AXIS_TIE of flipping to (axisSlack).
 */
export async function pairHistory(scene: SceneDesc, steps: number, opts: { pairsPerBody?: number } = {}) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine({}, { device, pairsPerBody: opts.pairsPerBody });
  await e.init(scene);
  type Parts = { bodies: GPUBuffer; sweep: GPUBuffer; bp: { pairs: GPUBuffer; total: GPUBuffer }; np: { manifolds: GPUBuffer }; prev: GPUBuffer };
  const parts = (e as unknown as { parts: Parts }).parts;
  const descs = bodiesAt(scene, Number.MAX_SAFE_INTEGER), shapes = descs.map((b) => b.shape);
  const margin = Math.fround((e as unknown as { params: AvbdParams }).params.margin);
  const state = async () => {
    const v = new DataView(await readBuffer(device, parts.bodies));
    return Array.from({ length: (e as unknown as { n: number }).n }, (_, i) => { const b = readStruct(v, Body, i); return { pos: [...b.pos!] as Vec3, rot: [...b.rot!] as Quat }; });
  };
  const read = async () => {
    const [pairs, total, mf, prev, sw] = await Promise.all([parts.bp.pairs, parts.bp.total, parts.np.manifolds, parts.prev, parts.sweep].map((b) => readBuffer(device, b)));
    const t = new Uint32Array(total!), count = t[3]!, pv = new Uint32Array(pairs!), mv = new DataView(mf!), hv = new Uint32Array(prev!);
    const list = Array.from({ length: count }, (_, k) => {
      const m = readStruct(mv, Manifold, k);
      return { a: pv[2 * k]!, b: pv[2 * k + 1]!, count: m.count![0]!, axis: m.axis![0]!, prevSlot: hv[2 * k]!, prevAxis: hv[2 * k + 1]! };
    });
    return { list, sweep: new Float32Array(sw!), overflow: t[5]! > t[3]! };
  };
  let wrong = 0, found = 0, missed = 0, axes = 0, checked = 0, axisMismatch = 0, axisTies = 0, presenceMismatch = 0, hinted = 0, overflowSteps = 0, spawnPairs = 0;
  const examples: unknown[] = [];
  let last = (await read()).list;
  for (let s = 0; s < steps; s++) {
    const before = await state();
    e.step();
    const { list: cur, sweep, overflow } = await read();
    if (overflow) overflowSteps++;
    spawnPairs += cur.filter((p) => Math.max(p.a, p.b) >= before.length).length;
    // The narrowphase's axis given its hint, against the reference given the same hint.
    for (const p of cur) {
      if (shapes[p.a]!.kind !== 'box' || shapes[p.b]!.kind !== 'box') continue;
      // A body spawned in this step is not in `before` yet: the GPU has its pose as authored, in f32.
      const pose = (i: number) => before[i] ?? { pos: descs[i]!.pos.map(Math.fround) as Vec3, rot: descs[i]!.rot.map(Math.fround) as Quat };
      const A = pose(p.a), B = pose(p.b), m = Math.fround(Math.fround(margin + sweep[p.a]!) + sweep[p.b]!);
      const ref = shapeManifold(shapes[p.a]!, A.pos, A.rot, shapes[p.b]!, B.pos, B.rot, m, true, p.prevAxis);
      const plain = shapeManifold(shapes[p.a]!, A.pos, A.rot, shapes[p.b]!, B.pos, B.rot, m, true, NO_AXIS);
      const want = ref ? ref.axis : NONE_U32, got = p.count > 0 ? p.axis : NONE_U32;
      checked++;
      if (got !== want) {
        let slack: number | null = null;
        if (got === NONE_U32 || want === NONE_U32) presenceMismatch++;
        else {
          const r = axisSlack((shapes[p.a] as { half: Vec3 }).half, A, (shapes[p.b] as { half: Vec3 }).half, B, p.prevAxis);
          slack = r.slack;
          if (r.alternatives.includes(got)) axisTies++; else axisMismatch++;
        }
        if (examples.length < 3) examples.push({ step: s, a: p.a, b: p.b, got, want, hint: p.prevAxis, slack, margin: m, A, B });
      }
      if (want !== (plain ? plain.axis : NONE_U32)) hinted++;
    }
    if (s > 0) { // the first step has no history
      const index = new Map(last.map((p, k) => [`${p.a},${p.b}`, k]));
      for (const p of cur) {
        const k = index.get(`${p.a},${p.b}`);
        if (k === undefined) { if (p.prevSlot !== NONE_U32) wrong++; continue; }
        if (p.prevSlot === NONE_U32) { missed++; continue; }
        const q = last[p.prevSlot]!;
        const axis = q.count > 0 ? q.axis : NONE_U32;
        if (p.prevSlot !== k || q.a !== p.a || q.b !== p.b || p.prevAxis !== axis) wrong++;
        else { found++; if (axis !== NONE_U32) axes++; }
      }
    }
    last = cur;
  }
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, wrong, found, missed, axes, checked, axisMismatch, axisTies, presenceMismatch, hinted, overflowSteps, spawnPairs, examples };
}
const NONE_U32 = 0xffffffff;

/**
 * The largest tangential start-of-step drift |c0.yz| of any used contact point, over every step of a run: in the
 * engine's layout, points (SolverContact) or the exact record (SolverRecord, its points q < count); records 2 keeps
 * no per-point friction.
 */
export async function anchorDrift(scene: SceneDesc, steps: number, params: Partial<AvbdParams> = {}) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { device });
  await e.init(scene);
  const contacts = (e as unknown as { parts: { solver: { contacts: GPUBuffer } } }).parts.solver.contacts;
  let worst = 0;
  for (let s = 0; s < steps; s++) {
    e.step();
    // Both halves (this step's contacts and last step's): each was a step's contacts once.
    const v = new DataView(await readBuffer(device, contacts));
    if (e.records === 2) throw new Error('anchorDrift: records 2 keeps no per-point c0.yz');
    if (e.records === 0) {
      for (let k = 0; k < v.byteLength / SolverContact.size; k++) {
        const c = readStruct(v, SolverContact, k);
        if (c.used![0]) worst = Math.max(worst, Math.hypot(c.c0![1]!, c.c0![2]!));
      }
    } else {
      for (let k = 0; k < v.byteLength / SolverRecord.size; k++) {
        const r = readStruct(v, SolverRecord, k);
        for (let q = 0; q < r.count![0]!; q++) worst = Math.max(worst, Math.hypot(r.c0T1![q]!, r.c0T2![q]!));
      }
    }
  }
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, worst };
}

/** init() with a pair buffer too large for the device: the error it throws (null if none). */
export async function initError(scene: SceneDesc, pairsPerBody: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine({}, { device, pairsPerBody });
  let message: string | null = null;
  try { await e.init(scene); } catch (err) { message = (err as Error).message; }
  const validation = await device.popErrorScope();
  e.dispose();
  return { message, validation: validation?.message ?? null };
}

/**
 * finish() on a healthy run, after a GPU validation error, and after the
 * device is lost under the engine; then re-init after a failure-free dispose.
 */
export async function finishFailures(scene: SceneDesc) {
  const settle = (p: Promise<void>) => p.then(() => 'resolved', (err: Error) => err.message);
  // Fail with a name instead of hanging if an event never comes.
  const within = <T>(p: Promise<T>, what: string) =>
    Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), 10_000))]);
  const a = (await createDevice()).device;
  const e = new GpuAvbdEngine({}, { device: a });
  await e.init(scene);
  e.step();
  const healthy = await settle(e.finish());
  const fired = new Promise((r) => a.addEventListener('uncapturederror', r, { once: true }));
  a.createBuffer({ size: 4, usage: 0 }); // invalid: a validation error
  // Chrome delivers the error event only once the device next talks to the GPU process.
  await a.queue.onSubmittedWorkDone();
  await within(fired, 'uncapturederror');
  const afterError = await settle(e.finish());
  let stepAfterError = 'no throw';
  try { e.step(); } catch (err) { stepAfterError = (err as Error).message; }
  e.dispose(); a.destroy();

  const b = (await createDevice()).device;
  const e2 = new GpuAvbdEngine({}, { device: b });
  await e2.init(scene);
  e2.step();
  b.destroy();
  await within(b.lost, 'device b lost');
  const afterLoss = await settle(e2.finish());
  e2.dispose();

  // init() again disposes the engine's own first device; that loss is not a failure.
  const e3 = new GpuAvbdEngine();
  await e3.init(scene);
  const first = (e3 as unknown as { device: GPUDevice }).device;
  await e3.init(scene);
  await within(first.lost, 'first device lost');
  e3.step();
  const reinit = await settle(e3.finish());
  e3.dispose();
  return { healthy, afterError, stepAfterError, afterLoss, reinit };
}

type SnapshotParts = { parts: { bodies: GPUBuffer; readback: Readback; bp: { total: GPUBuffer }; col: { info: GPUBuffer } }; n: number };

/**
 * snapshot() called after `steps` steps, with another step() issued before it
 * resolves, against a readBuffer + readStruct decode of the bodies buffer (the
 * old path) issued at the same point, compared with Object.is; then the awake
 * bit: body `flagged` given flags 0x100 (tier bits set, awake clear), kept
 * through a step, then 0x101, 0xfffffffe and 0xff. Six snapshots in all, on
 * one staging buffer.
 */
export async function snapshotDecode(scene: SceneDesc, steps: number, flagged: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine({}, { device });
  await e.init(scene);
  const { parts } = e as unknown as SnapshotParts;
  for (let i = 0; i < steps; i++) e.step();
  // Both reads are issued before the step, so both must see the state after `steps` steps.
  const pending = e.snapshot();
  const old = readBuffer(device, parts.bodies);
  e.step();
  const [s, oldBytes] = await Promise.all([pending, old]);
  const v = new DataView(oldBytes);
  let mismatches = 0, compared = 0;
  const examples: unknown[] = [];
  for (let i = 0; i < s.count; i++) {
    const b = readStruct(v, Body, i);
    for (const [k, c] of [['pos', 3], ['rot', 4], ['linVel', 3], ['angVel', 3]] as const) {
      for (let j = 0; j < c; j++, compared++) {
        if (Object.is(s[k][c * i + j], b[k]![j])) continue;
        mismatches++;
        if (examples.length < 3) examples.push({ i, k, j, got: s[k][c * i + j], want: b[k]![j] });
      }
    }
    compared++;
    if (s.awake[i] !== (b.flags![0]! & 1)) mismatches++;
  }
  // That step changed the state, so a read issued after it would not have matched.
  const next = await e.snapshot();
  let changedByStep = 0;
  for (const k of ['pos', 'rot', 'linVel', 'angVel'] as const) s[k].forEach((x, j) => { if (!Object.is(x, next[k][j])) changedByStep++; });
  const setFlags = (f: number) => device.queue.writeBuffer(parts.bodies, flagged * Body.size + field(Body, 'flags').offset, Uint32Array.from([f]));
  const awakeWith = async (f: number) => (setFlags(f), [...(await e.snapshot()).awake]);
  setFlags(0x100);
  e.step();
  const tierBits = [...(await e.snapshot()).awake];
  // Every bit but bit 0, then bits 0-7: a Uint8Array store without the mask would read 254 and 255.
  const awake = { start: [...s.awake], tierBits, woken: await awakeWith(0x101), highBits: await awakeWith(0xfffffffe), lowByte: await awakeWith(0xff) };
  const error = await device.popErrorScope();
  const res = { error: error?.message ?? null, count: s.count, compared, mismatches, examples, changedByStep, awake, created: parts.readback.created };
  e.dispose();
  return res;
}

/**
 * The engine's Readback outside snapshot(): diagnostics() reads through it
 * (two reads at once, so two buffers, which the second call reuses), and
 * dispose() destroys it, rejecting a snapshot still in flight.
 */
export async function engineReadback(scene: SceneDesc, steps: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine({}, { device });
  await e.init(scene);
  const { parts } = e as unknown as SnapshotParts;
  const rb = parts.readback;
  for (let i = 0; i < steps; i++) e.step();
  await e.diagnostics();
  await e.diagnostics();
  const diagnostics = { created: rb.created, bytesRead: rb.bytesRead, perCall: parts.bp.total.size + parts.col.info.size };
  const inFlight = e.snapshot();
  const buffers = [...(rb as unknown as { all: Set<GPUBuffer> }).all];
  e.dispose();
  const fails = async (f: () => Promise<unknown>) => { try { await f(); return 'no error'; } catch (err) { return (err as Error).message; } };
  const snapshotInFlight = await fails(() => inFlight);
  // Copying into a destroyed buffer is a validation error; into a live, unmapped one it is not.
  const probe = device.createBuffer({ size: 16, usage: GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
  const isDestroyed = async (b: GPUBuffer) => {
    if (b.mapState !== 'unmapped') return false;
    device.pushErrorScope('validation');
    const enc = device.createCommandEncoder();
    enc.copyBufferToBuffer(probe, 0, b, 0, 4);
    device.queue.submit([enc.finish()]);
    return (await device.popErrorScope()) !== null;
  };
  const destroyed = await Promise.all(buffers.map(isDestroyed));
  const readAfterDispose = await fails(() => rb.read(probe));
  probe.destroy();
  const error = await device.popErrorScope();
  return { error: error?.message ?? null, diagnostics, snapshotInFlight, destroyed, readAfterDispose };
}

/** Bodies counted and bytes read by snapshot() at each of `at` (step counts, ascending), with the buffer's capacity. */
export async function snapshotSpawn(scene: SceneDesc, at: number[]) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine({}, { device });
  await e.init(scene);
  const { parts } = e as unknown as SnapshotParts;
  const reads = [];
  for (const step of at) {
    while (e.stepIndex < step) e.step();
    const before = parts.readback.bytesRead;
    const s = await e.snapshot();
    reads.push({ step, count: s.count, posLength: s.pos.length, bytes: parts.readback.bytesRead - before });
  }
  const error = await device.popErrorScope();
  const res = { error: error?.message ?? null, capacityBytes: parts.bodies.size, reads };
  e.dispose();
  return res;
}

/**
 * Dispatch calls in one step, after `warm` steps: counted by wrapping the
 * compute pass encoder's dispatch methods while step() encodes.
 */
export async function dispatchCounts(scene: SceneDesc, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'>, warm = 3) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const e = new GpuAvbdEngine(params, { ...opts, device });
  await e.init(scene);
  for (let i = 0; i < warm; i++) e.step();
  const proto = GPUComputePassEncoder.prototype;
  const original = { direct: proto.dispatchWorkgroups, indirect: proto.dispatchWorkgroupsIndirect };
  const counts = { direct: 0, indirect: 0 };
  proto.dispatchWorkgroups = function (this: GPUComputePassEncoder, ...a: Parameters<GPUComputePassEncoder['dispatchWorkgroups']>) { counts.direct++; return original.direct.apply(this, a); };
  proto.dispatchWorkgroupsIndirect = function (this: GPUComputePassEncoder, ...a: Parameters<GPUComputePassEncoder['dispatchWorkgroupsIndirect']>) { counts.indirect++; return original.indirect.apply(this, a); };
  try { e.step(); } finally { proto.dispatchWorkgroups = original.direct; proto.dispatchWorkgroupsIndirect = original.indirect; }
  await e.finish();
  const d = await e.diagnostics();
  const error = await device.popErrorScope();
  e.dispose();
  return { error: error?.message ?? null, ...counts, colors: d.colors };
}

/** The dispatch init() chose, and whether the adapter is software (which sets the tail width's default). */
export async function dispatchPlan(scene: SceneDesc, opts: Omit<GpuEngineOptions, 'device'>) {
  const { device } = await sharedDevice();
  const e = new GpuAvbdEngine({}, { ...opts, device });
  const before = e.dispatch;
  await e.init(scene);
  const info = (device as GPUDevice & { adapterInfo?: GPUAdapterInfo }).adapterInfo;
  const out = { before, dispatch: e.dispatch, software: info ? isSoftwareAdapter(info) : null, adapter: info ? `${info.vendor}/${info.architecture}/${info.description}` : null };
  e.dispose();
  return out;
}

/** The code of the 'avbd solve' shader module the engine built at init (and of every module, by label), and the dispatch it chose. */
export async function solveShader(scene: SceneDesc, opts: Omit<GpuEngineOptions, 'device'>, params: Partial<AvbdParams> = {}) {
  const { device } = await sharedDevice();
  const codes: string[] = [];
  const modules: Record<string, string> = {};
  // The device is shared by the page's drivers: the hook comes off again however init() ends.
  const create = device.createShaderModule;
  device.createShaderModule = (d: GPUShaderModuleDescriptor) => { if (d.label === 'avbd solve') codes.push(d.code); modules[d.label ?? ''] = d.code; return create.call(device, d); };
  try {
    const e = new GpuAvbdEngine(params, { ...opts, device });
    await e.init(scene);
    const out = { codes, modules, dispatch: e.dispatch, variant: e.info.variant };
    e.dispose();
    return out;
  } finally {
    device.createShaderModule = create;
  }
}

/**
 * step(), push() and probeParts() called while init() is pending: right after
 * init() returns its promise, then on every task until it settles. First on a
 * fresh engine, then on the same engine re-initialised with a second scene
 * after `steps` steps of the first (so its body count, pending inputs and step
 * index are set). Then init() overtaken: by dispose(), and by another init()
 * of the second scene. Returns what each call did, how the overtaken inits
 * settled, and the second scene after `steps` steps (after either re-init)
 * against a fresh engine's.
 */
export async function callsDuringInit(first: SceneDesc, second: SceneDesc, steps: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const uncaptured: string[] = [];
  device.addEventListener('uncapturederror', (ev) => uncaptured.push((ev as GPUUncapturedErrorEvent).error.message));
  const e = new GpuAvbdEngine({}, { device });
  const calls: string[][] = [];
  const state = async (x: GpuAvbdEngine) => {
    const s = await x.snapshot();
    return { count: s.count, pos: [...s.pos], rot: [...s.rot], linVel: [...s.linVel], angVel: [...s.angVel] };
  };
  for (const scene of [first, second]) {
    const did: string[] = [];
    const attempt = () => {
      const tries: Array<[string, () => unknown]> = [['step', () => e.step()], ['push', () => e.push([])], ['probeParts', () => e.probeParts()]];
      for (const [name, f] of tries) {
        try { f(); did.push(`${name}: ran`); } catch (err) { did.push(`${name}: ${(err as Error).message}`); }
      }
    };
    let settled = false;
    const done = e.init(scene).finally(() => { settled = true; });
    while (!settled) { attempt(); await new Promise((r) => setTimeout(r, 0)); }
    await done;
    calls.push(did);
    for (let k = 0; k < steps; k++) e.step();
    await e.finish();
  }
  const after = await state(e);
  const settle = (p: Promise<void>) => p.then(() => 'resolved', (err: Error) => err.message);
  const disposed = settle(e.init(first));
  e.dispose();
  const superseded = settle(e.init(first));
  const last = settle(e.init(second));
  const overtaken = { disposed: await disposed, superseded: await superseded, last: await last };
  for (let k = 0; k < steps; k++) e.step();
  await e.finish();
  const reinit = await state(e);
  e.dispose();
  const c = new GpuAvbdEngine({}, { device });
  await c.init(second);
  for (let k = 0; k < steps; k++) c.step();
  await c.finish();
  const clean = await state(c);
  c.dispose();
  const error = await device.popErrorScope();
  await new Promise((r) => setTimeout(r, 50));
  return { error: error?.message ?? null, uncaptured, calls, count: after.count, after, overtaken, reinit, clean };
}

/**
 * init() when a solve pipeline cannot be built: the tail entry point's
 * workgroup is made twice as tall, so 256 tail threads become 512, past the
 * device's maxComputeInvocationsPerWorkgroup (256), as a kernel whose register
 * use lowers Metal's maxTotalThreadsPerThreadgroup would be. Then a step()
 * and an init() of a healthy engine on the same device.
 */
export async function solvePipelineFailure(scene: SceneDesc) {
  const { device } = await createDevice();
  const uncaptured: string[] = [];
  device.addEventListener('uncapturederror', (ev) => uncaptured.push((ev as GPUUncapturedErrorEvent).error.message));
  const create = device.createShaderModule.bind(device);
  let broken = true;
  device.createShaderModule = (d: GPUShaderModuleDescriptor) =>
    create(broken && d.label === 'avbd solve' ? { ...d, code: d.code.replace('@workgroup_size(tailThreads)', '@workgroup_size(tailThreads, 2)') } : d);
  const e = new GpuAvbdEngine({}, { device, tailThreads: 256, hessian: 'registers' });
  const message = await e.init(scene).then(() => null, (err: Error) => err.message);
  let stepAfter: string | null = null;
  try { e.step(); } catch (err) { stepAfter = (err as Error).message; }
  broken = false;
  const healthy = await e.init(scene).then(async () => { e.step(); await e.finish(); return 'resolved'; }, (err: Error) => err.message);
  await new Promise((r) => setTimeout(r, 50));
  e.dispose();
  device.destroy();
  return { message, stepAfter, healthy, uncaptured, maxInvocations: device.limits.maxComputeInvocationsPerWorkgroup };
}

/**
 * One primal dispatch (colour 0, a main iteration) of the real solve kernel in
 * the given hessian form, on synthetic inputs written straight into its
 * buffers. Bodies 0 .. n-1 form colour 0; their contacts are with bodies n ..
 * 2n-1, which are only read, and with the ground. Bodies 0 and 1 are the
 * signed-zero cases (engine.test.ts says why); the rest are random, including axis-aligned
 * normals (exact and signed zeros in the Jacobian) and zero stiffnesses.
 * Returns the bits of dp and phi of bodies 0 .. n-1 after the dispatch.
 */
export async function primalKernel(hessian: HessianForm, n: number, seed: number) {
  const { device } = await sharedDevice();
  device.pushErrorScope('validation');
  const total = 2 * n, perBody = 3, maxPairs = n * perBody;
  const usage = GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC;
  const mk = (bytes: number) => device.createBuffer({ size: Math.max(64, bytes), usage });
  const B = {
    bodies: mk(total * Body.size), props: mk(total * BodyProps.size), spheres: mk(16 * total), sweep: mk(4 * total),
    manifolds: mk(maxPairs * Manifold.size), groundManifolds: mk(total * Manifold.size), prev: mk(8 * maxPairs), pairs: mk(8 * maxPairs),
    total: mk(32), offsets: mk(4 * total), order: mk(4 * total), colorStart: mk(4 * (MAX_COLORS + 1)), dispatch: mk(12 * MAX_COLORS),
    rowStart: mk(4 * total), rowLength: mk(4 * total), adjSlot: mk(4 * maxPairs),
  };
  const solver = new AvbdSolver(device, total, maxPairs, B, { ...DEFAULT_DISPATCH, tailThreads: 64, hessian });
  solver.writeParams(total, 1 / 60, [0, -9.81, 0], { y: 0, friction: 0.5 }, DEFAULT_AVBD);
  let s = seed >>> 0 || 1;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const u = (a: number) => a * (2 * r() - 1);
  const unit = (v: number[]) => { const l = Math.hypot(...v) || 1; return v.map((x) => x / l); };
  const cross = (a: number[], b: number[]) => [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
  // Axis-aligned a quarter of the time, with signed zeros.
  const direction = () => {
    if (r() < 0.25) { const k = Math.floor(3 * r()); return [0, 1, 2].map((j) => (j === k ? (r() < 0.5 ? -1 : 1) : r() < 0.5 ? -0 : 0)); }
    return unit([u(1), u(1), u(1)]);
  };
  const stiffness = () => (r() < 0.15 ? 0 : 10 ** (2 + 4 * r()));
  const bodyView = new DataView(new ArrayBuffer(total * SolverBody.size));
  const propView = new DataView(new ArrayBuffer(total * BodyProps.size));
  for (let i = 0; i < total; i++) {
    const q = unit([u(1), u(1), u(1), u(1)]);
    writeStruct(bodyView, SolverBody, i, { q0: q, dp: [u(0.05), u(0.05), u(0.05)], phi: [u(0.05), u(0.05), u(0.05)], tp: [u(0.05), u(0.05), u(0.05)], tphi: [u(0.05), u(0.05), u(0.05)] });
    writeStruct(propView, BodyProps, i, { inertia: [0.05 + 2 * r(), 0.05 + 2 * r(), 0.05 + 2 * r()], mass: 0.5 + 4.5 * r(), friction: 0.5, radius: 1 });
  }
  const contactView = new DataView(new ArrayBuffer(AvbdSolver.contactBytes(total, maxPairs) / 2));
  let points = 0, zeroRows = 0;
  const contact = (at: number, a: number, b: number) => {
    const nn = direction();
    const t1 = unit(cross(nn, Math.abs(nn[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0]));
    const kN = stiffness(), kT = stiffness();
    zeroRows += (kN === 0 ? 1 : 0) + (kT === 0 ? 2 : 0);
    points++;
    writeStruct(contactView, SolverContact, at, {
      n: nn, t1, mu: r(), used: 1, raw: a === NONE_U32 ? [0, 0, 0] : [u(1), u(1), u(1)], rbw: [u(1), u(1), u(1)],
      c0: [u(0.05), u(0.05), u(0.05)], lambdaN: r() < 0.3 ? 0 : -100 * r(), lt: r() < 0.3 ? [0, 0] : [u(50), u(50)], kN, kT, a, b,
    });
  };
  const rowStart = new Uint32Array(total), rowLength = new Uint32Array(total), adjSlot = new Uint32Array(maxPairs);
  for (let i = 2; i < n; i++) {
    rowStart[i] = perBody * i;
    rowLength[i] = Math.floor(r() * (perBody + 1));
    for (let k = 0; k < rowLength[i]!; k++) {
      const slot = perBody * i + k, other = n + Math.floor(r() * n), m = 1 + Math.floor(4 * r());
      adjSlot[slot] = slot;
      for (let q = 0; q < m; q++) { const onB = r() < 0.5; contact(4 * slot + q, onB ? other : i, onB ? i : other); }
    }
    const m = Math.floor(5 * r());
    for (let q = 0; q < m; q++) contact(4 * (maxPairs + i) + q, NONE_U32, i);
  }
  // Bodies 0 and 1: one ground contact each with kN = kT = 0 (every row
  // skipped) under a -0 seed in the rotational block (negative inertia at the
  // identity rotation). Body 0's normal is y, so its output shows a tangent
  // row not skipped; body 1's is x, so its output shows the normal row not
  // skipped. No pair contacts (rowLength 0).
  for (const [i, nn, t1] of [[0, [0, 1, 0], [1, 0, 0]], [1, [1, 0, 0], [0, 1, 0]]] as const) {
    writeStruct(bodyView, SolverBody, i, { q0: [0, 0, 0, 1], dp: [0.1, 0.2, 0.3], phi: [-0, 0.01, 0.02], tp: [0, 0, 0], tphi: [0, 0, 0] });
    writeStruct(propView, BodyProps, i, { inertia: [-1, -1, -1], mass: 1, friction: 0.5, radius: 1 });
    writeStruct(contactView, SolverContact, 4 * (maxPairs + i), {
      n: [...nn], t1: [...t1], mu: 0.5, used: 1, raw: [0, 0, 0], rbw: [1, 1, 1], c0: [0, 0, 0], lambdaN: 0, lt: [0, 0], kN: 0, kT: 0, a: NONE_U32, b: i,
    });
  }
  const colorStart = new Uint32Array(MAX_COLORS + 1).fill(n);
  colorStart[0] = 0;
  const q = device.queue;
  q.writeBuffer(solver.solver, 0, bodyView.buffer);
  q.writeBuffer(B.props, 0, propView.buffer);
  q.writeBuffer(solver.contacts, 0, contactView.buffer);
  q.writeBuffer(B.order, 0, Uint32Array.from({ length: total }, (_, k) => k));
  q.writeBuffer(B.colorStart, 0, colorStart);
  q.writeBuffer(B.rowStart, 0, rowStart);
  q.writeBuffer(B.rowLength, 0, rowLength);
  q.writeBuffer(B.adjSlot, 0, adjSlot);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  solver.encodeProbe(pass, total, { primal: 0 }, 1);
  pass.end();
  q.submit([enc.finish()]);
  const out = new DataView(await readBuffer(device, solver.solver, n * SolverBody.size));
  const bits: number[] = [], before: number[] = [];
  let nonFinite = 0;
  for (let i = 0; i < n; i++) for (const f of ['dp', 'phi'] as const) for (let c = 0; c < 3; c++) {
    const at = i * SolverBody.size + field(SolverBody, f).offset + 4 * c;
    bits.push(out.getUint32(at, true));
    before.push(bodyView.getUint32(at, true));
    if (!Number.isFinite(out.getFloat32(at, true))) nonFinite++;
  }
  const error = await device.popErrorScope();
  solver.destroy();
  for (const b of Object.values(B)) b.destroy();
  return { error: error?.message ?? null, bits, changed: bits.filter((b, k) => b !== before[k]).length, nonFinite, points, zeroRows };
}

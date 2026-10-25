// Page-side drivers for the GPU physics tests (bundled by loadBundle).
import { createDevice, readBuffer } from '@tb/gpu';
import { boundingRadius, groundManifold, quatNormalize, shapeManifold, spherePairs, supportArea, type Manifold as CpuManifold } from '@tb/geom';
import { Body, Manifold, readStruct, Shape, writeStruct } from '@tb/schema';
import type { BodyDesc, Quat, Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { bodiesAt } from '@tb/engine-api';
import { Broadphase, Coloring, MAX_COLORS, Narrowphase } from '../src/index.ts';
import { colorGraph } from '@tb/physics-ref';

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
  const { device } = await createDevice();
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
  device.destroy();
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
function cpuPair(a: BodyDesc, b: BodyDesc, margin: number, reduce = true): CpuManifold | null {
  return shapeManifold(a.shape, a.pos, a.rot, b.shape, b.pos, b.rot, margin, reduce);
}

interface Gpu { count: number; normal: number[]; feature: number; points: number[][] }
function decode(view: DataView, i: number): Gpu {
  const r = readStruct(view, Manifold, i);
  return { count: r.count![0]!, normal: r.normal!, feature: r.feature![0]!, points: [r.p0!, r.p1!, r.p2!, r.p3!].slice(0, r.count![0]!) };
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

/** Match GPU against CPU: same count, normal within 1e-3 rad, every point paired within tol. */
function agrees(g: Gpu, c: CpuManifold | null, tol: number): boolean {
  const cc = c ? c.points.length : 0;
  if (g.count !== cc) return false;
  if (!c || cc === 0) return true;
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

export interface NarrowCase { kind: 'random' | 'scenario'; pairs?: number; spheres?: number; scenario?: string; params?: Record<string, number>; margin: number; seed?: number }

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
  const { device } = await createDevice();
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
  const np = new Narrowphase(device, bb, sb, pb, tb, Math.max(1, n), Math.max(1, pairs.length));
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
    const g = decode(mv, k), cpu = cpuPair(bodies[i]!, bodies[j]!, c.margin);
    if (cpu) contacts++;
    const t = tol * (1 + Math.abs(bodies[i]!.pos[0]) / 25);
    if (!agrees(g, cpu, t)) {
      if (tieOnly(g, cpu, cpuPair(bodies[i]!, bodies[j]!, c.margin, false), t)) { pairTies++; return; }
      pairMismatch++;
      if (examples.length < 3) examples.push({ k, gpu: g, cpu });
    }
  });
  bodies.forEach((b, i) => {
    const g = decode(gv, i);
    const cpu = groundManifold(b.shape, b.pos, b.rot, 0, c.margin);
    if (cpu) groundContacts++;
    if (!agrees(g, cpu, tol * 4)) {
      const all = groundManifold(b.shape, b.pos, b.rot, 0, c.margin, false);
      if (tieOnly(g, cpu, all, tol * 4)) { groundTies++; return; }
      groundMismatch++;
      if (examples.length < 6) examples.push({ ground: i, gpu: g, cpu, y: b.pos[1] });
    }
  });
  np.destroy();
  device.destroy();
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
  const { device } = await createDevice();
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
  device.destroy();
  return {
    error: error?.message ?? null, n, edges, colorsUsed: info[0], uncolored: info[1], overflow: info[2], refColors: used,
    colorsMatch: firstMismatch < 0, firstMismatch, rowsMatch, orderMatch: order.every((x, k) => x === expectOrder[k]),
    startMatch: start.every((x, k) => x === expectStart[k]),
    dispatchMatch: Array.from({ length: MAX_COLORS }, (_, k) => disp[3 * k] === Math.ceil((expectStart[k + 1]! - expectStart[k]!) / 64) && disp[3 * k + 1] === 1 && disp[3 * k + 2] === 1).every(Boolean),
    maxDegree: Math.max(0, ...adj.map((s) => s.size)), wallMs,
  };
}

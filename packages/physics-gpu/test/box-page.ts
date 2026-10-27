// Page-side drivers for the broadphase's box test (box-broadphase.test.ts; Kapla step K2.1).
import { readBuffer, sharedDevice } from '@tb/gpu';
import { boundingRadius, boxBoxSeparation, obb, quatNormalize, shapeManifold, spherePairs } from '@tb/geom';
import { Body, Manifold, readStruct, Shape, writeStruct } from '@tb/schema';
import { bodiesAt, type BodyDesc, type Quat, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { Broadphase, GpuAvbdEngine, type GpuEngineOptions, Narrowphase } from '../src/index.ts';

export interface BoxCase {
  /**
   * cloud: n bodies in a cube of side `side`, boxes (cubes and Kapla planks) and a share of spheres;
   * boundary: n pairs, each placed where the f64 narrowphase's contact starts or stops (within 2e-5);
   * scenario: a scenario's bodies at step 0.
   */
  kind: 'cloud' | 'boundary' | 'scenario';
  n?: number;
  side?: number;
  spheres?: number;
  scenario?: string;
  params?: Record<string, number>;
  margin: number;
  /** Per-body sweep drawn from [0, sweep). */
  sweep?: number;
  seed?: number;
}

const PLANKS: Vec3[] = [[2.5, 0.5, 1 / 6], [0.5, 1 / 6, 2.5], [1 / 6, 2.5, 0.5]];

function rng(seed: number) {
  let s = seed >>> 0;
  const r = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  const u = (lo: number, hi: number) => lo + (hi - lo) * r();
  const quat = (): Quat => quatNormalize([u(-1, 1), u(-1, 1), u(-1, 1), u(0.05, 1)]);
  const half = (): Vec3 => (r() < 0.5 ? PLANKS[Math.floor(3 * r())]! : [u(0.1, 1), u(0.1, 1), u(0.1, 1)]);
  return { r, u, quat, half };
}

const desc = (pos: Vec3, rot: Quat, shape: BodyDesc['shape']): BodyDesc => ({ shape, pos, rot, linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });
const f32v = (v: Vec3): Vec3 => [Math.fround(v[0]), Math.fround(v[1]), Math.fround(v[2])];
const f32q = (q: Quat): Quat => [Math.fround(q[0]), Math.fround(q[1]), Math.fround(q[2]), Math.fround(q[3])];

function bodiesFor(c: BoxCase): { bodies: BodyDesc[]; sweeps: number[] } {
  const g = rng(c.seed ?? 1);
  let bodies: BodyDesc[] = [];
  if (c.kind === 'scenario') {
    bodies = bodiesAt(buildScenario(c.scenario!, c.params ?? {}, c.seed ?? 1), Number.MAX_SAFE_INTEGER);
  } else if (c.kind === 'cloud') {
    const side = c.side ?? 10;
    for (let i = 0; i < c.n!; i++) {
      const pos: Vec3 = [g.u(-side / 2, side / 2), g.u(0, side), g.u(-side / 2, side / 2)];
      bodies.push(desc(pos, g.quat(), g.r() < (c.spheres ?? 0) ? { kind: 'sphere', radius: g.u(0.1, 1) } : { kind: 'box', half: g.half() }));
    }
  }
  const sweeps = bodies.map(() => (c.sweep ?? 0) * g.r());
  if (c.kind !== 'boundary') return { bodies, sweeps };
  // Pairs on a grid 16 apart (coordinates under 200, f32 ulp under 2e-5), each
  // B moved along a random direction to where the f64 narrowphase (margin plus
  // both sweeps) starts to find a contact, give or take 2e-5.
  const k = Math.ceil(Math.cbrt(c.n!));
  for (let p = 0; p < c.n!; p++) {
    const base: Vec3 = [16 * (p % k), 16 * (Math.floor(p / k) % k), 16 * Math.floor(p / (k * k))];
    const ha = g.half(), hb = g.half(), qa = f32q(g.quat()), qb = f32q(g.quat());
    const sa = (c.sweep ?? 0) * g.r(), sb = (c.sweep ?? 0) * g.r();
    const m = Math.fround(Math.fround(Math.fround(c.margin) + Math.fround(sa)) + Math.fround(sb));
    const dir = (() => { const v: Vec3 = [g.u(-1, 1), g.u(-1, 1), g.u(-1, 1)]; const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l] as Vec3; })();
    const at = (t: number): Vec3 => [base[0] + t * dir[0], base[1] + t * dir[1], base[2] + t * dir[2]];
    const touch = (t: number) => shapeManifold({ kind: 'box', half: ha }, base, qa, { kind: 'box', half: hb }, at(t), qb, m) !== null;
    let lo = 0, hi = 12;
    for (let it = 0; it < 60; it++) { const mid = 0.5 * (lo + hi); if (touch(mid)) lo = mid; else hi = mid; }
    bodies.push(desc(base, qa, { kind: 'box', half: ha }), desc(f32v(at(lo + g.u(-2e-5, 2e-5))), qb, { kind: 'box', half: hb }));
    sweeps.push(sa, sb);
  }
  return { bodies, sweeps };
}

function upload(device: GPUDevice, data: ArrayBufferView | ArrayBuffer, usage = 0) {
  const bytes = data instanceof ArrayBuffer ? data : data.buffer;
  const buf = device.createBuffer({ size: Math.max(16, bytes.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | usage });
  device.queue.writeBuffer(buf, 0, bytes);
  return buf;
}

const key = (i: number, j: number) => i * 1e7 + j;

/**
 * The box test against the narrowphase and the f64 separation. Runs the
 * broadphase without and with the box test on the same bodies, the
 * narrowphase on every sphere pair, and reports:
 * - lostContacts: pairs whose GPU manifold has a point but that the box test dropped (must be 0);
 * - notSphere: kept pairs that are not sphere pairs; reordered: kept pairs out of the sphere pairs' order;
 * - looseKeeps: kept box pairs the f64 separation puts more than tol beyond the margin;
 * - wrongDrops: dropped box pairs the f64 separation puts more than tol inside it.
 */
export async function boxBroadphase(c: BoxCase, repeat = 2) {
  const { bodies, sweeps } = bodiesFor(c);
  const n = bodies.length;
  const { device } = await sharedDevice();
  const bv = new DataView(new ArrayBuffer(Body.size * Math.max(1, n))), sv = new DataView(new ArrayBuffer(Shape.size * Math.max(1, n)));
  const spheres = new Float32Array(4 * Math.max(1, n));
  let rmax = 0, smax = 0;
  bodies.forEach((b, i) => {
    writeStruct(bv, Body, i, { pos: b.pos, rot: b.rot, invMass: 1, linVel: [0, 0, 0], angVel: [0, 0, 0], flags: 1, shape: i });
    writeStruct(sv, Shape, i, b.shape.kind === 'box' ? { half: b.shape.half, kind: 0 } : { half: [b.shape.radius, 0, 0], kind: 1 });
    const r = boundingRadius(b.shape);
    spheres.set([...b.pos, r + sweeps[i]!], 4 * i);
    rmax = Math.max(rmax, r);
    smax = Math.max(smax, sweeps[i]!);
  });
  const bodiesBuf = upload(device, bv), shapesBuf = upload(device, sv), spheresBuf = upload(device, spheres), sweepBuf = upload(device, Float32Array.from(sweeps));
  // Room for every sphere pair (spherePairs counts them as the GPU does, up to f32 rounding near touching).
  const maxPairs = Math.max(64, Math.ceil(1.1 * spherePairs(spheres.subarray(0, 4 * n).filter((_, k) => k % 4 !== 3), Array.from({ length: n }, (_, i) => spheres[4 * i + 3]!), c.margin).length) + 64);
  const params = { cellSize: Math.max(1e-3, 2 * (rmax + smax) + c.margin), margin: c.margin };
  device.pushErrorScope('validation');
  const run = async (bp: Broadphase) => {
    const enc = device.createCommandEncoder();
    bp.encode(enc, n, params);
    device.queue.submit([enc.finish()]);
    const total = new Uint32Array(await readBuffer(device, bp.total));
    const flat = Array.from(new Uint32Array(await readBuffer(device, bp.pairs, Math.max(8, total[3]! * 8)))).slice(0, 2 * total[3]!);
    return { written: total[3]!, required: total[5]!, flat };
  };
  const off = new Broadphase(device, spheresBuf, Math.max(1, n), maxPairs);
  const on = new Broadphase(device, spheresBuf, Math.max(1, n), maxPairs, undefined, { bodies: bodiesBuf, shapes: shapesBuf, sweep: sweepBuf });
  const rOff = await run(off);
  const runs = [];
  for (let k = 0; k < repeat; k++) runs.push(await run(on));
  const rOn = runs[0]!;
  // The narrowphase on every sphere pair, with the same sweeps (no last-step axes).
  const np = new Narrowphase(device, bodiesBuf, shapesBuf, off.pairs, off.total, Math.max(1, n), maxPairs, sweepBuf);
  const enc = device.createCommandEncoder();
  const pass = enc.beginComputePass();
  np.encode(pass, n, { margin: c.margin, ground: null });
  pass.end();
  device.queue.submit([enc.finish()]);
  const mv = new DataView(await readBuffer(device, np.manifolds, Math.max(Manifold.size, rOff.written * Manifold.size)));
  const error = await device.popErrorScope();

  const offPairs: Array<[number, number]> = [];
  for (let k = 0; k < rOff.flat.length; k += 2) offPairs.push([rOff.flat[k]!, rOff.flat[k + 1]!]);
  const onKeys = rOn.flat.reduce<number[]>((a, x, k) => (k % 2 ? (a.push(key(rOn.flat[k - 1]!, x)), a) : a), []);
  const onSet = new Set(onKeys);
  const offKeys = offPairs.map(([i, j]) => key(i, j));
  const offSet = new Set(offKeys);
  // The kept pairs must be the sphere pairs in their order, less the dropped ones.
  const kept = offKeys.filter((k) => onSet.has(k));
  const reordered = kept.length !== onKeys.length || kept.some((k, t) => k !== onKeys[t]);
  let contacts = 0, lostContacts = 0, looseKeeps = 0, wrongDrops = 0, boxPairs = 0, nearMargin = 0;
  const examples: unknown[] = [];
  const f32 = Math.fround;
  const tol = 1e-4;
  offPairs.forEach(([i, j], k) => {
    const count = readStruct(mv, Manifold, k).count![0]!;
    if (count > 0) contacts++;
    if (count > 0 && !onSet.has(key(i, j))) { lostContacts++; if (examples.length < 4) examples.push({ i, j, a: bodies[i], b: bodies[j], sa: sweeps[i], sb: sweeps[j] }); }
    const a = bodies[i]!, b = bodies[j]!;
    if (a.shape.kind !== 'box' || b.shape.kind !== 'box') return;
    boxPairs++;
    const s = boxBoxSeparation(obb(f32v(a.pos), f32q(a.rot), a.shape.half), obb(f32v(b.pos), f32q(b.rot), b.shape.half));
    const m = f32(f32(f32(c.margin) + f32(sweeps[i]!)) + f32(sweeps[j]!));
    if (Math.abs(s - m) < 1e-3) nearMargin++;
    if (onSet.has(key(i, j)) && s > m + tol) looseKeeps++;
    if (!onSet.has(key(i, j)) && s < m - tol) wrongDrops++;
  });
  const res = {
    n, error: error?.message ?? null,
    spherePairs: rOff.written, sphereRequired: rOff.required, kept: rOn.written, keptRequired: rOn.required, contacts, boxPairs, nearMargin,
    lostContacts, notSphere: onKeys.filter((k) => !offSet.has(k)).length, reordered, looseKeeps, wrongDrops,
    deterministic: runs.every((r) => r.written === rOn.written && r.flat.every((x, k) => x === rOn.flat[k])),
    examples,
  };
  off.destroy(); on.destroy(); np.destroy();
  for (const b of [bodiesBuf, shapesBuf, spheresBuf, sweepBuf]) b.destroy();
  return res;
}

/**
 * A scenario run twice, with and without the box test, on one device: every
 * `every` steps, are the bodies' states the same bit for bit? Also the pair
 * slots each run needed at its last step.
 */
export async function boxEngine(scenario: string, params: Record<string, number>, steps: number, every: number, opts: GpuEngineOptions = {}, gravityScale = 1) {
  const { device } = await sharedDevice();
  const base = buildScenario(scenario, params, 1);
  const scene: SceneDesc = { ...base, gravity: base.gravity.map((g) => g * gravityScale) as Vec3 };
  const states: Array<Array<number[]>> = [[], []];
  const diag = [];
  for (const [r, box] of [[0, false], [1, true]] as const) {
    const e = new GpuAvbdEngine({}, { ...opts, device, boxBroadphase: box });
    await e.init(scene);
    for (let s = 1; s <= steps; s++) {
      e.step();
      if (s % every === 0) {
        const snap = await e.snapshot();
        states[r]!.push([...snap.pos, ...snap.rot, ...snap.linVel, ...snap.angVel]);
      }
    }
    diag.push(await e.diagnostics());
    e.dispose();
  }
  let firstDiff = -1, maxDiff = 0;
  states[0]!.forEach((a, k) => {
    const b = states[1]![k]!;
    const d = a.reduce((m, x, t) => Math.max(m, Math.abs(x - b[t]!)), 0);
    if (d > 0 && firstDiff < 0) firstDiff = (k + 1) * every;
    maxDiff = Math.max(maxDiff, d);
  });
  return { n: scene.bodies.length, firstDiff, maxDiff, off: diag[0]!, on: diag[1]! };
}

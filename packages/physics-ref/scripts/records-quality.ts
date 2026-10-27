// Quality family for manifold records (perf-competition round 2, "records") on the f64 reference:
// AvbdParams.records = 2 (centre friction) against points (0), at one iteration count.
//   npx tsx packages/physics-ref/scripts/records-quality.ts <case> '<params json>' [arg...]
// Cases (one JSON line each):
//   topple H deg          S13 column of H cubes released at deg (above its tipping angle): topple time
//                         against the rigid column, and the largest bend before it.
//   rock H deg steps      S13 column released below its tipping angle: upright time and far side against
//                         the rigid column (readColumn), every swing extreme, and whether and when it topples.
//   Q4                    S12: the cubes over the hole fall freely, the rest of the wall stays.
//   Q5 | Q5b              resting S1 4x4x20 / small city S4 N=1000 F=4 H=20 street 4, 300 steps:
//                         deepest penetration, largest drift, largest kinetic energy of a body after step 30
//                         and in the last 30 steps.
//   spread H deg steps seeds amp first   rounding sensitivity of a rocking column: start positions moved by
//                         up to amp, upright time and far side (degrees) per seed.
//   S5 '<scene json>' steps   a ball into a tower (S5): debris settling (kinetic energy, cubes at rest, NaNs),
//                         and how often a pair's record changes its point count with a warm start.
// Wall time is printed as wallMsNotEvidence: it comes from a shared VM and is not performance evidence.
import { freeFlight, type Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, type ColumnSample, leanDeg, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { type AvbdParams, AvbdReferenceEngine, colorGraph, GROUND } from '../src/index.ts';

const [cs = 'Q1', paramsArg = '{}', ...rest] = process.argv.slice(2);
const params = JSON.parse(paramsArg) as Partial<AvbdParams>;
const t0 = Date.now();

async function column(H: number, deg: number, steps: number, stopAtDeg = Infinity) {
  const scene = buildScenario('S13', { H, deg }, 1);
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const samples: ColumnSample[] = [{ t: 0, pos: [...e.snapshot().pos] }];
  for (let i = 1; i <= steps; i++) {
    e.step();
    const pos = [...e.snapshot().pos];
    samples.push({ t: i * scene.dt, pos });
    if (Math.abs(leanDeg(pos, H)) >= stopAtDeg) break;
  }
  return samples;
}

/** Signed lean at every turn of the swing (a reversal by more than turnDeg from the running extreme). */
function swings(samples: ColumnSample[], H: number, turnDeg = 0.02) {
  const out: Array<{ step: number; deg: number }> = [];
  let ext = leanDeg(samples[0]!.pos, H), extStep = 0, dir = 0;
  samples.forEach((s, step) => {
    const a = leanDeg(s.pos, H);
    if (dir === 0) {
      if (Math.abs(a - ext) > turnDeg) dir = Math.sign(a - ext);
      if (dir !== 0) { ext = a; extStep = step; }
      return;
    }
    if ((a - ext) * dir > 0) { ext = a; extStep = step; } else if (Math.abs(a - ext) > turnDeg) {
      out.push({ step: extStep, deg: ext });
      dir = -dir; ext = a; extStep = step;
    }
  });
  return out;
}

async function main() {
  let out: Record<string, unknown> = {};
  if (cs === 'topple') {
    const H = Number(rest[0] ?? 20), deg = Number(rest[1] ?? 4);
    const rod = rodToppleTime(H, deg, 30);
    const steps = Math.ceil(rod * 1.4 * 60);
    const r = readColumn(await column(H, deg, steps, 31), H);
    out = { H, deg, rod, topple: r.topple, err: r.topple === null ? null : r.topple / rod - 1, bend: r.bend };
  } else if (cs === 'rock') {
    const H = Number(rest[0] ?? 20), deg = Number(rest[1] ?? 2), steps = Number(rest[2] ?? 300);
    const rod = rodRock(H, deg);
    const s = await column(H, deg, steps, 30);
    const r = readColumn(s, H);
    const last = s[s.length - 1]!;
    const toppled = Math.abs(leanDeg(last.pos, H)) >= 30;
    out = {
      H, deg, steps, rodUpright: rod.upright, rodFar: rod.farSide, tipping: tippingAngle(H),
      upright: r.upright, err: r.upright === null ? null : r.upright / rod.upright - 1, before: r.before, turned: r.turned, far: r.farSide / rod.farSide,
      swings: swings(s, H).map((x) => [x.step, Number(x.deg.toFixed(3))]), toppleStep: toppled ? s.length - 1 : null, endLean: leanDeg(last.pos, H),
    };
  } else if (cs === 'spread') {
    // How far rounding alone moves a rocking column: every start position moved by up to amp per coordinate
    // (uniform, seeded; seed 0 is the unmoved run), sampled every 5 steps as the GPU tests read it.
    const H = Number(rest[0] ?? 20), deg = Number(rest[1] ?? 2), steps = Number(rest[2] ?? 300);
    const seeds = Number(rest[3] ?? 60), amp = Number(rest[4] ?? 1e-6), first = Number(rest[5] ?? 0);
    const base = buildScenario('S13', { H, deg }, 1);
    const runs: Array<[number, number | null, number]> = [];
    for (let k = first; k < first + seeds; k++) {
      let x = Math.imul(k + 1, 0x9e3779b9) >>> 0;
      const rnd = () => {
        x = (x + 0x6d2b79f5) >>> 0;
        let t = Math.imul(x ^ (x >>> 15), x | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const bodies = base.bodies.map((b) => ({ ...b, pos: (k === 0 ? b.pos : b.pos.map((v) => v + amp * (2 * rnd() - 1))) as Vec3 }));
      const e = new AvbdReferenceEngine(params);
      await e.init({ ...base, bodies });
      const s: ColumnSample[] = [{ t: 0, pos: [...e.snapshot().pos] }];
      for (let i = 1; i <= steps; i++) {
        e.step();
        if (i % 5 === 0 || i === steps) s.push({ t: i * base.dt, pos: [...e.snapshot().pos] });
      }
      const r = readColumn(s, H);
      runs.push([k, r.upright, r.farSide]);
    }
    out = { H, deg, steps, amp, runs };
  } else if (cs === 'Q4') {
    const scene = buildScenario('S12', {}, 1);
    const above = aboveHole(scene);
    const steps = 30;
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    for (let i = 0; i < steps; i++) e.step();
    const end = e.snapshot().pos;
    let minRatio = Infinity, worst = 0;
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      minRatio = Math.min(minRatio, (scene.bodies[i]!.pos[1] - end[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free));
    }
    scene.bodies.forEach((b, i) => {
      if (!above.includes(i)) worst = Math.max(worst, Math.hypot(end[3 * i]! - b.pos[0], end[3 * i + 1]! - b.pos[1], end[3 * i + 2]! - b.pos[2]));
    });
    out = { minRatio, worst, pass: minRatio >= 0.99 && worst < 0.03 };
  } else if (cs === 'Q5' || cs === 'Q5b') {
    const scene = cs === 'Q5' ? buildScenario('S1', { F: 4, H: 20 }, 1) : buildScenario('S4', { N: 1000, F: 4, H: 20, street: 4 }, 1);
    const steps = 300;
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    const p0 = [...e.snapshot().pos];
    let pen = 0, drift = 0, keMax30 = 0, keLast = 0;
    for (let i = 1; i <= steps; i++) {
      e.step();
      const w = e.world!;
      // Penetration at the start of this step (= the end of the last): the deepest point.
      for (const c of w.contacts) pen = Math.max(pen, -c.c0[0]);
      const pos = e.snapshot().pos;
      for (let k = 0; k < pos.length / 3; k++) drift = Math.max(drift, Math.hypot(pos[3 * k]! - p0[3 * k]!, pos[3 * k + 1]! - p0[3 * k + 1]!, pos[3 * k + 2]! - p0[3 * k + 2]!));
      let ke = 0;
      for (const b of w.bodies) ke = Math.max(ke, 0.5 * b.mass * (b.linVel[0] ** 2 + b.linVel[1] ** 2 + b.linVel[2] ** 2));
      if (i > 30) keMax30 = Math.max(keMax30, ke);
      if (i > steps - 30) keLast = Math.max(keLast, ke);
    }
    out = { pen, drift, keMax30, keLast };
  } else if (cs === 'S5') {
    // Debris: a cube is at rest below 0.05 m/s and 0.1 rad/s (a sleep-like test; the reference does not sleep).
    const ov = JSON.parse(rest[0] ?? '{"N":400,"F":4,"H":25,"street":6,"fireStep":10}') as Record<string, number>;
    const steps = Number(rest[1] ?? 600);
    const scene = buildScenario('S5', ov, 1);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    let nan = 0, keMax = 0, ncChanges = 0, records = 0;
    const lastNc = new Map<string, number>();
    const rows: unknown[] = [];
    let settled: number | null = null;
    for (let s = 1; s <= steps; s++) {
      e.step();
      const w = e.world!;
      let ke = 0, rest0 = 0, cubes = 0, vMax = 0;
      for (const b of w.bodies) {
        const v2 = b.linVel[0] ** 2 + b.linVel[1] ** 2 + b.linVel[2] ** 2, w2 = b.angVel[0] ** 2 + b.angVel[1] ** 2 + b.angVel[2] ** 2;
        if (!Number.isFinite(v2) || !Number.isFinite(w2) || !b.pos.every(Number.isFinite)) nan++;
        if (b.desc.shape.kind !== 'box') continue;
        cubes++;
        ke += 0.5 * b.mass * v2 + 0.5 * (b.inertia[0] + b.inertia[1] + b.inertia[2]) / 3 * w2;
        vMax = Math.max(vMax, Math.sqrt(v2));
        if (v2 < 0.05 ** 2 && w2 < 0.1 ** 2) rest0++;
      }
      keMax = Math.max(keMax, ke);
      const now = new Map<string, number>();
      for (const q of w.records) {
        const key = `${q.a},${q.b}`, prev = lastNc.get(key);
        if (prev !== undefined && prev !== q.nc) ncChanges++;
        now.set(key, q.nc);
      }
      records += w.records.length;
      lastNc.clear();
      for (const [k, v] of now) lastNc.set(k, v);
      if (s > ov.fireStep! + 30 && settled === null && ke < 1e-3 * keMax) settled = s;
      if (s % 30 === 0) rows.push({ step: s, cubeKE: Number(ke.toPrecision(4)), atRest: rest0, cubes, vMax: Number(vMax.toPrecision(3)) });
    }
    out = { scene: ov, steps, nan, keMax, settled, ncChanges, recordsWalked: records, rows };
  } else if (cs === 'structure') {
    // Colours (K), points (sum W_c) and records (sum R_c) of the colour chains at one step of a scene, on this
    // variant's own trajectory: W_c / R_c is the most points / manifolds on one body of colour c.
    const [id = 'S4', ov = '{}', stepsArg = '60'] = rest;
    const scene = buildScenario(id, JSON.parse(ov) as Record<string, number>, 1);
    const e = new AvbdReferenceEngine(params);
    await e.init(scene);
    const at = stepsArg.split(',').map(Number);
    const rows: unknown[] = [];
    for (let s = 1; s <= Math.max(...at); s++) {
      e.step();
      if (!at.includes(s)) continue;
      const w = e.world!, n = w.bodies.length;
      const pts = new Int32Array(n), man = new Int32Array(n);
      const adj: Array<Set<number>> = Array.from({ length: n }, () => new Set());
      const pairs = new Set<string>();
      for (const c of w.contacts) {
        pts[c.b]!++;
        if (c.a !== GROUND) { pts[c.a]!++; adj[c.a]!.add(c.b); adj[c.b]!.add(c.a); }
        const key = `${c.a},${c.b}`;
        if (!pairs.has(key)) { pairs.add(key); man[c.b]!++; if (c.a !== GROUND) man[c.a]!++; }
      }
      const color = colorGraph(adj.map((x) => [...x].sort((u, v) => u - v)));
      const K = Math.max(...color) + 1;
      const W = new Int32Array(K), R = new Int32Array(K);
      for (let i = 0; i < n; i++) { W[color[i]!] = Math.max(W[color[i]!]!, pts[i]!); R[color[i]!] = Math.max(R[color[i]!]!, man[i]!); }
      rows.push({ step: s, K, sumW: W.reduce((x, y) => x + y, 0), sumR: R.reduce((x, y) => x + y, 0), W: [...W], R: [...R], points: w.contacts.length, manifolds: pairs.size });
    }
    out = { scene: id, ov: JSON.parse(ov), rows };
  } else throw new Error(`unknown case ${cs}`);
  console.log(JSON.stringify({ case: cs, params, ...out, wallMsNotEvidence: Date.now() - t0 }));
}
void main();

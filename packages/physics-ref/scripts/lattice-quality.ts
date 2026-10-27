// Quality of the lattice-preferred colouring (AvbdParams.colorMode) on the f64
// reference, against the default order: the perf-competition protocol Q1-Q6
// (as the ordering entrant's order-lib.ts), the judges' struck rows and
// KNOCKT (the clusters and chunked physics judges' row.ts, knockt-long.ts), a
// packed tower pushed over (the preference active while it falls), and a
// 1600-cube city run for 450 steps. Not used by tests.
//   npx tsx packages/physics-ref/scripts/lattice-quality.ts <out.jsonl> <cases comma list> '<json array of params>'
import { appendFileSync } from 'node:fs';
import { type BodyDesc, freeFlight, type SceneDesc, type Snapshot } from '@tb/engine-api';
import { drift, penetration } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, type ColumnSample, leanDeg, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { AvbdReferenceEngine, type AvbdParams } from '../src/index.ts';

/** shuffle: KNOCKT's body order (a seed); nudge: every start position moved by up to 1e-6 m (a seed), for run-to-run spread. */
type P = Partial<AvbdParams> & { iterations: number; shuffle?: number; nudge?: number };

/** Colours used per step, and ΣW (the most contact points a body of each colour walks, summed). */
function structure(e: AvbdReferenceEngine) {
  const w = e.world!, color = w.stats.colorOf!, pts = new Int32Array(w.bodies.length);
  for (const c of w.contacts) { pts[c.b]!++; if (c.a >= 0) pts[c.a]!++; }
  const W = new Array<number>(w.stats.colors).fill(0);
  color.forEach((c, i) => { W[c] = Math.max(W[c]!, pts[i]!); });
  return { K: w.stats.colors, sumW: W.reduce((a, b) => a + b, 0) };
}
class Agg {
  K: number[] = []; sumW: number[] = [];
  add(e: AvbdReferenceEngine) { const s = structure(e); this.K.push(s.K); this.sumW.push(s.sumW); }
  get out() {
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
    return { maxK: Math.max(...this.K), meanK: +mean(this.K).toFixed(2), meanSumW: +mean(this.sumW).toFixed(1), maxSumW: Math.max(...this.sumW) };
  }
}
async function engine(scene: SceneDesc, p: P) {
  const { shuffle: _s, nudge, ...params } = p;
  const e = new AvbdReferenceEngine(params);
  if (nudge) {
    let t = nudge >>> 0;
    const rnd = () => { t = (Math.imul(t, 1664525) + 1013904223) >>> 0; return t / 2 ** 32 - 0.5; };
    scene = { ...scene, bodies: scene.bodies.map((b) => ({ ...b, pos: [b.pos[0] + 2e-6 * rnd(), b.pos[1] + 2e-6 * rnd(), b.pos[2] + 2e-6 * rnd()] })) };
  }
  await e.init(scene);
  return e;
}
function shuffled(scene: SceneDesc, seed?: number): SceneDesc {
  if (!seed) return scene;
  const bodies = [...scene.bodies];
  let t = seed >>> 0;
  const rnd = () => { t = (t + 0x6d2b79f5) >>> 0; let x = Math.imul(t ^ (t >>> 15), 1 | t); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  for (let i = bodies.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [bodies[i], bodies[j]] = [bodies[j]!, bodies[i]!]; }
  return { ...scene, bodies };
}

async function runColumn(scene: SceneDesc, steps: number, p: P, stopDeg = Infinity, H = 0) {
  const e = await engine(scene, p), agg = new Agg();
  const samples: ColumnSample[] = [{ t: 0, pos: [...e.snapshot().pos] }];
  for (let i = 1; i <= steps; i++) {
    e.step(); agg.add(e);
    const pos = [...e.snapshot().pos];
    samples.push({ t: i * scene.dt, pos });
    if (H && leanDeg(pos, H) > stopDeg) break;
  }
  return { samples, agg: agg.out };
}

const CASES: Record<string, (p: P) => Promise<Record<string, unknown>>> = {
  /** S13 H=20, 4 deg, 330 steps: topple within 3% of the rigid column, bend < 0.1 m. */
  async Q1(p) {
    const H = 20, rod = rodToppleTime(H, 4, 30);
    const { samples, agg } = await runColumn(buildScenario('S13', { H, deg: 4 }, 1), 330, p);
    const r = readColumn(samples, H), err = r.topple === null ? null : r.topple / rod - 1;
    return { topple: r.topple, err, bend: r.bend, pass: err !== null && Math.abs(err) < 0.03 && r.bend < 0.1, agg };
  },
  /** S13 H=20, 2 deg, 300 steps: upright within 3%, far side / rigid in (0.85, 1.02), turned, never past tipping. */
  async Q2(p) {
    const H = 20, rod = rodRock(H, 2);
    const { samples, agg } = await runColumn(buildScenario('S13', { H, deg: 2 }, 1), 300, p);
    const r = readColumn(samples, H), err = r.upright === null ? null : r.upright / rod.upright - 1, far = r.farSide / rod.farSide;
    return { upright: r.upright, err, farRatio: far, pass: err !== null && Math.abs(err) < 0.03 && far > 0.85 && far < 1.02 && r.turned && r.before < tippingAngle(H), agg };
  },
  /** S12 wall, 30 steps: above-hole cubes >= 0.99 of free fall, the rest move < 0.03 m. */
  async Q4(p) {
    const scene = buildScenario('S12', {}, 1), above = aboveHole(scene), steps = 30;
    const e = await engine(scene, p), agg = new Agg();
    for (let i = 0; i < steps; i++) { e.step(); agg.add(e); }
    const end = e.snapshot().pos;
    let minFall = Infinity, worst = 0;
    for (const i of above) {
      const free = freeFlight(scene.bodies[i]!.pos, [0, 0, 0], scene.gravity, scene.dt, 1, steps).pos[1];
      minFall = Math.min(minFall, (scene.bodies[i]!.pos[1] - end[3 * i + 1]!) / (scene.bodies[i]!.pos[1] - free));
    }
    scene.bodies.forEach((b, i) => { if (!above.includes(i)) worst = Math.max(worst, Math.hypot(end[3 * i]! - b.pos[0], end[3 * i + 1]! - b.pos[1], end[3 * i + 2]! - b.pos[2])); });
    return { minFall, restMoveMm: +(worst * 1000).toFixed(2), pass: minFall >= 0.99 && worst < 0.03, agg: agg.out };
  },
  /** S1 F=4 H=20 at rest, 300 steps: max penetration (every 10 steps), max drift, sag. */
  async Q5(p) {
    const scene = buildScenario('S1', { F: 4, H: 20, gap: 0 }, 1);
    return rest(scene, p, 300);
  },
  /** A 2x2x20 tower tilted 8 deg: when its columns pass 30 deg, and the lean at 1 s. */
  async Q6(p) {
    const W = 2, H = 20, deg = 8, steps = 270;
    const base = buildScenario('S1', { F: W, H, gap: 0 }, 1);
    const th = (deg * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), e0 = W / 2;
    const bodies: BodyDesc[] = base.bodies.map((b, i) => {
      const layer = Math.floor(i / (W * W)), xr = b.pos[0] - e0, y = b.pos[1];
      return { ...b, pos: [e0 + xr * c + y * sn, -xr * sn + y * c + 1e-6 * (layer + 1), b.pos[2]], rot: [0, 0, -Math.sin(th / 2), Math.cos(th / 2)] };
    });
    const scene = { ...base, bodies };
    const e = await engine(scene, p), agg = new Agg();
    const cols: number[][] = [];
    for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) cols.push(Array.from({ length: H }, (_, y) => y * W * W + x * W + z));
    const colPos = (pos: ArrayLike<number>, col: number[]) => Float64Array.from(col.flatMap((i) => [pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!]));
    const at30: Array<number | null> = cols.map(() => null), prev = cols.map((cl) => leanDeg(colPos(e.snapshot().pos, cl), H)), lean1s: number[] = [];
    for (let i = 1; i <= steps; i++) {
      e.step(); agg.add(e);
      const pos = e.snapshot().pos, t = i * scene.dt;
      cols.forEach((cl, k) => {
        const a = leanDeg(colPos(pos, cl), H);
        if (at30[k] === null && prev[k]! < 30 && a >= 30) at30[k] = t - (scene.dt * (a - 30)) / (a - prev[k]!);
        prev[k] = a;
      });
      if (i === 60) for (const cl of cols) lean1s.push(leanDeg(colPos(pos, cl), H));
    }
    const t30 = at30.filter((x): x is number => x !== null);
    return { t30min: t30.length ? Math.min(...t30) : null, t30max: t30.length ? Math.max(...t30) : null, lean1sMin: Math.min(...lean1s), lean1sMax: Math.max(...lean1s), agg: agg.out };
  },
  ROW16x1: (p) => row(16, 1, 1, p),
  ROW16x3: (p) => row(16, 3, 1, p),
  ROW8x1: (p) => row(8, 1, 1, p),
  SLAB8x8x2: (p) => row(8, 8, 2, p, 4),
  /** A ball (mass 10, radius 1, 10 m/s) into a 4x4x20 tower, 360 steps: onset (tower KE > 100 J after step 100), cubes moved, mean height. */
  async KNOCKT(p) {
    const scene = shuffled(buildScenario('S5', { N: 320, F: 4, H: 20, radius: 1, speed: 10, massRatio: 10, fireStep: 10 }, 1), p.shuffle);
    const e = await engine(scene, p), agg = new Agg(), steps = 360;
    let onset: number | null = null, maxPen = 0, p99 = 0, sumMax = 0, samples = 0;
    const at: Record<number, { moved: number; ymean: number }> = {};
    for (let i = 1; i <= steps; i++) {
      e.step(); agg.add(e);
      if (i % 10) continue;
      const s = e.snapshot();
      let kin = 0, mv = 0, ym = 0;
      scene.bodies.forEach((b, k) => {
        kin += 0.5 * (s.linVel[3 * k]! ** 2 + s.linVel[3 * k + 1]! ** 2 + s.linVel[3 * k + 2]! ** 2);
        if (Math.hypot(s.pos[3 * k]! - b.pos[0], s.pos[3 * k + 1]! - b.pos[1], s.pos[3 * k + 2]! - b.pos[2]) > 0.5) mv++;
        ym += s.pos[3 * k + 1]! / scene.bodies.length;
      });
      const pen = penetration(scene.bodies, { ...s, count: scene.bodies.length } as Snapshot, 0);
      maxPen = Math.max(maxPen, pen.max); p99 = Math.max(p99, pen.p99); sumMax += pen.max; samples++;
      if (onset === null && i >= 100 && kin > 100) onset = i;
      if (i === 90 || i === 240 || i === 360) at[i] = { moved: mv, ymean: +ym.toFixed(3) };
    }
    return { onset, at, maxPenMm: +(maxPen * 1000).toFixed(2), p99PenMm: +(p99 * 1000).toFixed(2), meanMaxPenMm: +((sumMax / samples) * 1000).toFixed(2), agg: agg.out };
  },
  /**
   * An aligned 4x4x30 packed tower, its top 10 layers pushed sideways at 2 m/s after 60 steps of rest,
   * 240 steps: so the preference is active while it falls. When the tower's lean passes 30 deg, max penetration.
   */
  async PUSH(p) {
    const scene = buildScenario('S1', { F: 4, H: 30, gap: 0 }, 1);
    const e = await engine(scene, p), agg = new Agg(), H = 30, F = 4;
    const col = (pos: ArrayLike<number>) => {
      // The tower's centre line: the mean of each layer.
      const out = new Float64Array(3 * H);
      for (let y = 0; y < H; y++) for (let k = 0; k < F * F; k++) for (let a = 0; a < 3; a++) out[3 * y + a]! += pos[3 * (y * F * F + k) + a]! / (F * F);
      return out;
    };
    let t30: number | null = null, prev = 0, maxPen = 0, took = 0, p99 = 0, sumMax = 0, samples = 0;
    for (let i = 1; i <= 300; i++) {
      if (i === 61) for (let k = 20 * F * F; k < H * F * F; k++) e.world!.bodies[k]!.linVel = [2, 0, 0];
      e.step(); agg.add(e);
      const s = e.snapshot(), a = leanDeg(col(s.pos), H);
      if (t30 === null && prev < 30 && a >= 30) t30 = (i - 60) * scene.dt;
      prev = a;
      if (i % 10 === 0) { const pen = penetration(scene.bodies, s, 0); maxPen = Math.max(maxPen, pen.max); p99 = Math.max(p99, pen.p99); sumMax += pen.max; samples++; }
      if (i === 120) took = structure(e).K;
    }
    return { t30, maxPenMm: +(maxPen * 1000).toFixed(2), p99PenMm: +(p99 * 1000).toFixed(2), meanMaxPenMm: +((sumMax / samples) * 1000).toFixed(2), Kat120: took, agg: agg.out };
  },
  /** S4 N=1600 (one 8x8x25 tower), 450 steps at rest: max penetration and drift, K and ΣW by window. */
  async CITY1600(p) {
    const scene = buildScenario('S4', { N: 1600 }, 1);
    return rest(scene, p, 450, [[0, 150], [150, 300], [300, 450]]);
  },
};

async function rest(scene: SceneDesc, p: P, steps: number, windows: Array<[number, number]> = []) {
  const e = await engine(scene, p), agg = new Agg(), s0 = e.snapshot();
  const win = windows.map(() => new Agg());
  let maxPen = 0, maxDrift = 0;
  for (let i = 1; i <= steps; i++) {
    e.step(); agg.add(e);
    windows.forEach(([a, b], k) => { if (i > a && i <= b) win[k]!.add(e); });
    if (i % 10 === 0) {
      const snap = e.snapshot();
      maxPen = Math.max(maxPen, penetration(scene.bodies, snap, scene.ground?.y ?? null).max);
      maxDrift = Math.max(maxDrift, drift(s0, snap));
    }
  }
  const s1 = e.snapshot();
  let sag = 0;
  for (let i = 0; i < s1.count; i++) sag = Math.max(sag, s0.pos[3 * i + 1]! - s1.pos[3 * i + 1]!);
  return { maxPenMm: +(maxPen * 1000).toFixed(3), maxDriftMm: +(maxDrift * 1000).toFixed(4), sagMm: +(sag * 1000).toFixed(3), agg: agg.out, ...(windows.length ? { windows: Object.fromEntries(windows.map(([a, b], k) => [`${a}-${b}`, win[k]!.out])) } : {}) };
}

/**
 * An L x layers x D block of cubes struck end-on by one cube at 6 m/s along +x, 45 steps (the judges' row.ts):
 * the sum of x velocities peaks above the striker's 5.90 only if momentum is created; the far end's slide.
 */
async function row(L: number, layers: number, D: number, p: P, strikeLayer = 0) {
  const proto = buildScenario('S1', { F: 1, H: 1, gap: 0 }, 1);
  const cube = proto.bodies[0]!;
  const bodies: BodyDesc[] = [];
  for (let y = 0; y < layers; y++) for (let z = 0; z < D; z++) for (let i = 0; i < L; i++) bodies.push({ ...cube, pos: [0.5 + i, 0.5 + y + 1e-6 * (y + 1), 0.5 + z], linVel: [0, 0, 0] });
  bodies.push({ ...cube, pos: [-1.0, 0.5 + strikeLayer + 1e-6 * (strikeLayer + 1), 0.5 + Math.floor(D / 2)], linVel: [6, 0, 0] });
  const scene: SceneDesc = { ...proto, id: 'row', params: { L, layers, D }, bodies };
  const e = await engine(scene, p), agg = new Agg();
  let peak = -Infinity, peakStep = 0, maxPen = 0;
  for (let k = 1; k <= 45; k++) {
    e.step(); agg.add(e);
    const s = e.snapshot();
    let px = 0;
    for (let i = 0; i < s.count; i++) px += s.linVel[3 * i]!;
    if (px > peak) { peak = px; peakStep = k; }
    maxPen = Math.max(maxPen, penetration(bodies, s, 0).max);
  }
  const s = e.snapshot();
  const far = s.pos[3 * (L - 1)]! - (L - 0.5);
  return { peak: +peak.toFixed(3), peakStep, farSlideMm: +(far * 1000).toFixed(1), maxPenMm: +(maxPen * 1000).toFixed(2), agg: agg.out };
}

const [out, caseList, json] = process.argv.slice(2);
if (!out || !caseList || !json) throw new Error('usage: lattice-quality.ts <out.jsonl> <cases> <params json array>');
for (const p of JSON.parse(json) as P[]) {
  for (const c of caseList.split(',')) {
    const f = CASES[c];
    if (!f) throw new Error(`unknown case ${c}; known: ${Object.keys(CASES).join(', ')}`);
    const t0 = performance.now();
    const r = await f(p);
    appendFileSync(out, JSON.stringify({ case: c, params: p, ...r, wallMsNotEvidence: Math.round(performance.now() - t0) }) + '\n');
    console.error(`${c} ${JSON.stringify(p)} done`);
  }
}

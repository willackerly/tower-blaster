// npx tsx packages/physics-gpu/scripts/lattice-quality-gpu.ts --out f.jsonl [--cases Q5,Q6,PUSH,ROW16x1,ROW16x3,KNOCKT]
//   [--variants 'iterations=20|iterations=20+colorMode=3'] [--channel chrome]
// The lattice colouring's quality cases (physics-ref scripts/lattice-quality.ts)
// on the GPU engine, in f32: the resting stack Q5, the tilted 2x2x20 tower Q6, a packed tower pushed over
// (the preference active while it falls), the judges' struck rows and KNOCKT.
// Variants are AvbdParams separated by '+'. The scenes and metrics are the f64
// script's; the GPU is sampled through snapshots (every step for the rows and
// the push, every 10 for Q5 and KNOCKT, as the f64 script samples them), and
// the push's velocity change is a kick written before step 61. Not timings.
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BodyDesc, SceneDesc, Snapshot } from '@tb/engine-api';
import { drift, penetration } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { exitNow, leanDeg, loadBundle, openWebGPU } from '@tb/testkit';
import type { Kick } from '../test/page.ts';

const argv = process.argv.slice(2);
const value = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const out = value('out');
if (!out) throw new Error('--out f.jsonl is required');
const cases = (value('cases') ?? 'Q5,PUSH,ROW16x1,ROW16x3,KNOCKT').split(',');
const variants = (value('variants') ?? 'iterations=20|iterations=20+colorMode=3').split('|');
const parseVariant = (v: string) => Object.fromEntries(v.split('+').filter((kv) => kv !== 'base').map((kv) => {
  const [k, x] = kv.split('=');
  if (!k || x === undefined || !Number.isFinite(Number(x))) throw new Error(`bad variant piece "${kv}" in "${v}"`);
  return [k, Number(x)];
}));

interface Snap { step: number; pos: number[]; rot: number[]; linVel: number[]; angVel: number[] }
type Run = (scene: SceneDesc, steps: number, params: Record<string, number>, every: number, kicks?: Kick[]) => Promise<Snap[]>;
const asSnapshot = (s: Snap, n: number) => ({ count: n, pos: Float32Array.from(s.pos), rot: Float32Array.from(s.rot), linVel: Float32Array.from(s.linVel), angVel: Float32Array.from(s.angVel) }) as unknown as Snapshot;

// An L x layers x D block of cubes struck end-on by one cube at 6 m/s (as the f64 script's row()).
function rowScene(L: number, layers: number, D: number, strikeLayer = 0): { scene: SceneDesc; L: number } {
  const proto = buildScenario('S1', { F: 1, H: 1, gap: 0 }, 1);
  const cube = proto.bodies[0]!;
  const bodies: BodyDesc[] = [];
  for (let y = 0; y < layers; y++) for (let z = 0; z < D; z++) for (let i = 0; i < L; i++) bodies.push({ ...cube, pos: [0.5 + i, 0.5 + y + 1e-6 * (y + 1), 0.5 + z], linVel: [0, 0, 0] });
  bodies.push({ ...cube, pos: [-1.0, 0.5 + strikeLayer + 1e-6 * (strikeLayer + 1), 0.5 + Math.floor(D / 2)], linVel: [6, 0, 0] });
  return { scene: { ...proto, id: 'row', params: { L, layers, D }, bodies }, L };
}

const CASES: Record<string, (run: Run, p: Record<string, number>) => Promise<Record<string, unknown>>> = {
  /** S1 F=4 H=20 at rest, 300 steps: max penetration (every 10 steps), max drift, sag. */
  async Q5(run, p) {
    const scene = buildScenario('S1', { F: 4, H: 20, gap: 0 }, 1), n = scene.bodies.length;
    const snaps = await run(scene, 300, p, 10);
    const s0 = asSnapshot(snaps[0]!, n), s1 = asSnapshot(snaps[snaps.length - 1]!, n);
    let maxPen = 0, maxDrift = 0, sag = 0;
    for (const s of snaps.slice(1)) { const sn = asSnapshot(s, n); maxPen = Math.max(maxPen, penetration(scene.bodies, sn, scene.ground?.y ?? null).max); maxDrift = Math.max(maxDrift, drift(s0, sn)); }
    for (let i = 0; i < n; i++) sag = Math.max(sag, s0.pos[3 * i + 1]! - s1.pos[3 * i + 1]!);
    return { maxPenMm: +(maxPen * 1000).toFixed(3), maxDriftMm: +(maxDrift * 1000).toFixed(4), sagMm: +(sag * 1000).toFixed(3) };
  },
  /** A 4x4x30 packed tower, its top 10 layers kicked to 2 m/s sideways before step 61, 300 steps: when the lean passes 30 deg, penetration. */
  async PUSH(run, p) {
    const F = 4, H = 30, scene = buildScenario('S1', { F, H, gap: 0 }, 1), n = scene.bodies.length;
    const kicks: Kick[] = [];
    for (let k = 20 * F * F; k < H * F * F; k++) kicks.push({ step: 60, body: k, linVel: [2, 0, 0], angVel: [0, 0, 0] });
    const snaps = await run(scene, 300, p, 1, kicks);
    const col = (pos: ArrayLike<number>) => {
      const o = new Float64Array(3 * H);
      for (let y = 0; y < H; y++) for (let k = 0; k < F * F; k++) for (let a = 0; a < 3; a++) o[3 * y + a]! += pos[3 * (y * F * F + k) + a]! / (F * F);
      return o;
    };
    let t30: number | null = null, prev = 0, maxPen = 0, p99 = 0, sumMax = 0, samples = 0;
    for (const s of snaps.slice(1)) {
      const a = leanDeg(col(s.pos), H);
      if (t30 === null && prev < 30 && a >= 30) t30 = (s.step - 60) * scene.dt;
      prev = a;
      if (s.step % 10 === 0) { const pen = penetration(scene.bodies, asSnapshot(s, n), 0); maxPen = Math.max(maxPen, pen.max); p99 = Math.max(p99, pen.p99); sumMax += pen.max; samples++; }
    }
    return { t30, maxPenMm: +(maxPen * 1000).toFixed(2), p99PenMm: +(p99 * 1000).toFixed(2), meanMaxPenMm: +((sumMax / samples) * 1000).toFixed(2) };
  },
  /** A 2x2x20 tower tilted 8 deg (as the f64 script's Q6), 270 steps: when its columns pass 30 deg, and the lean at 1 s. */
  async Q6(run, p) {
    const W = 2, H = 20, deg = 8, steps = 270;
    const base = buildScenario('S1', { F: W, H, gap: 0 }, 1);
    const th = (deg * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th), e0 = W / 2;
    const bodies: BodyDesc[] = base.bodies.map((b, i) => {
      const layer = Math.floor(i / (W * W)), xr = b.pos[0] - e0, y = b.pos[1];
      return { ...b, pos: [e0 + xr * c + y * sn, -xr * sn + y * c + 1e-6 * (layer + 1), b.pos[2]], rot: [0, 0, -Math.sin(th / 2), Math.cos(th / 2)] };
    });
    const scene = { ...base, bodies };
    const snaps = await run(scene, steps, p, 1);
    const cols: number[][] = [];
    for (let x = 0; x < W; x++) for (let z = 0; z < W; z++) cols.push(Array.from({ length: H }, (_, y) => y * W * W + x * W + z));
    const colPos = (pos: ArrayLike<number>, col: number[]) => Float64Array.from(col.flatMap((i) => [pos[3 * i]!, pos[3 * i + 1]!, pos[3 * i + 2]!]));
    const at30: Array<number | null> = cols.map(() => null), prev = cols.map((cl) => leanDeg(colPos(snaps[0]!.pos, cl), H)), lean1s: number[] = [];
    for (const s of snaps.slice(1)) {
      const t = s.step * scene.dt;
      cols.forEach((cl, k) => {
        const a = leanDeg(colPos(s.pos, cl), H);
        if (at30[k] === null && prev[k]! < 30 && a >= 30) at30[k] = t - (scene.dt * (a - 30)) / (a - prev[k]!);
        prev[k] = a;
      });
      if (s.step === 60) for (const cl of cols) lean1s.push(leanDeg(colPos(s.pos, cl), H));
    }
    const t30 = at30.filter((x): x is number => x !== null);
    return { t30min: t30.length ? Math.min(...t30) : null, t30max: t30.length ? Math.max(...t30) : null, lean1sMin: Math.min(...lean1s), lean1sMax: Math.max(...lean1s) };
  },
  ROW16x1: (run, p) => row(run, p, rowScene(16, 1, 1)),
  ROW16x3: (run, p) => row(run, p, rowScene(16, 3, 1)),
  /** A ball (mass 10, radius 1, 10 m/s) into a 4x4x20 tower, 360 steps: onset (tower KE > 100 J after step 100), cubes moved, mean height, penetration. */
  async KNOCKT(run, p) {
    const scene = buildScenario('S5', { N: 320, F: 4, H: 20, radius: 1, speed: 10, massRatio: 10, fireStep: 10 }, 1), n = scene.bodies.length;
    const snaps = await run(scene, 360, p, 10);
    let onset: number | null = null, maxPen = 0, p99 = 0, sumMax = 0, samples = 0;
    const at: Record<number, { moved: number; ymean: number }> = {};
    for (const s of snaps.slice(1)) {
      let kin = 0, mv = 0, ym = 0;
      scene.bodies.forEach((b, k) => {
        kin += 0.5 * (s.linVel[3 * k]! ** 2 + s.linVel[3 * k + 1]! ** 2 + s.linVel[3 * k + 2]! ** 2);
        if (Math.hypot(s.pos[3 * k]! - b.pos[0], s.pos[3 * k + 1]! - b.pos[1], s.pos[3 * k + 2]! - b.pos[2]) > 0.5) mv++;
        ym += s.pos[3 * k + 1]! / n;
      });
      const pen = penetration(scene.bodies, asSnapshot(s, n), 0);
      maxPen = Math.max(maxPen, pen.max); p99 = Math.max(p99, pen.p99); sumMax += pen.max; samples++;
      if (onset === null && s.step >= 100 && kin > 100) onset = s.step;
      if (s.step === 90 || s.step === 240 || s.step === 360) at[s.step] = { moved: mv, ymean: +ym.toFixed(3) };
    }
    return { onset, at, maxPenMm: +(maxPen * 1000).toFixed(2), p99PenMm: +(p99 * 1000).toFixed(2), meanMaxPenMm: +((sumMax / samples) * 1000).toFixed(2) };
  },
};

/** The sum of x velocities peaks above the striker's 5.90 only if momentum is created; the far end's slide. */
async function row(run: Run, p: Record<string, number>, { scene, L }: { scene: SceneDesc; L: number }) {
  const n = scene.bodies.length, snaps = await run(scene, 45, p, 1);
  let peak = -Infinity, peakStep = 0, maxPen = 0;
  for (const s of snaps.slice(1)) {
    let px = 0;
    for (let i = 0; i < n; i++) px += s.linVel[3 * i]!;
    if (px > peak) { peak = px; peakStep = s.step; }
    maxPen = Math.max(maxPen, penetration(scene.bodies, asSnapshot(s, n), 0).max);
  }
  const far = snaps[snaps.length - 1]!.pos[3 * (L - 1)]! - (L - 0.5);
  return { peak: +peak.toFixed(3), peakStep, farSlideMm: +(far * 1000).toFixed(1), maxPenMm: +(maxPen * 1000).toFixed(2) };
}

const channel = value('channel');
const gpu = await openWebGPU([], channel ? { channel } : {});
if (!gpu) throw new Error('no WebGPU adapter in this browser');
let stuck: string[] = [];
try {
  await loadBundle(gpu.page, fileURLToPath(new URL('../test/page.ts', import.meta.url)), '__page');
  const run: Run = async (scene, steps, params, every, kicks = []) => {
    const r = await gpu.page.evaluate(([s, n, pp, e, k]) => (window as unknown as { __page: { simulateGpu: (...x: unknown[]) => Promise<{ error: string | null; snaps: Snap[]; worst: { uncolored: number; colorOverflow: number } }> } }).__page.simulateGpu(s, n, pp, e, {}, k), [scene, steps, params, every, kicks] as const);
    if (r.error) throw new Error(r.error);
    if (r.worst.uncolored || r.worst.colorOverflow) throw new Error(`colouring incomplete: ${JSON.stringify(r.worst)}`);
    return r.snaps;
  };
  for (const v of variants) {
    const p = parseVariant(v);
    for (const c of cases) {
      const f = CASES[c];
      if (!f) throw new Error(`unknown case ${c}; known: ${Object.keys(CASES).join(', ')}`);
      const t0 = performance.now();
      const r = await f(run, p);
      appendFileSync(out, JSON.stringify({ case: c, engine: 'avbd-gpu', params: p, ...r, wallMsNotEvidence: Math.round(performance.now() - t0) }) + '\n');
      console.error(`${c} ${v} done`);
    }
  }
} finally {
  stuck = await gpu.close();
}
if (stuck.length) await exitNow();

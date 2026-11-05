// X3: do towers fall as dominoes? (modes-roadmap.md section 7; gates M6
// Wavefront's Steer verb, where a skyline is the domino layout.)
//
// A chain of slender towers about 4 m tall (h_t), each 1 m square, spaced
// SPACING h_t centre to centre along +z, in three designs:
//   cubes   2 x 2 columns of 0.5 m cubes on the game's lattice (2 % gap), 8
//           courses: the game's own towers, unbonded (four loose columns);
//   bricks  a bonded pier of 1 x 0.5 x 0.5 m bricks, two a course, each
//           course turned 90 deg to the one below (8 courses);
//   kapla   a crib of 1 x 0.3 x 0.1 m planks on edge (Kapla's 1:3:10-ish
//           proportions at game scale), two a layer, each layer turned 90 deg
//           (14 layers), friction 0.45 as S15's planks.
// The world pre-settles PRESETTLE steps, then a 0.4 m ball (2,000 kg/m^3) at
// PUSH_SPEED (3 m/s) hits the first tower at 0.75 h_t. Nudges jitter the push (+-10 %
// speed, +-10 cm height, +-5 cm sideways) and every body's placement (+-1 mm,
// +-0.2 deg), from their own seed.
//
// A tower has fallen once its centre of mass has moved FELL h_t along the
// chain or dropped FELL h_t (0.15: a pier tipped 17 deg onto its neighbour,
// as a domino past X1's 15 deg). Reach: how many towers from the first fell in an
// unbroken run. The run ends when nothing new has fallen for STALL_STEPS, or
// every tower has fallen and TAIL_STEPS more have passed.
//
// The roadmap names chains of 6, 12 and 24; the probe runs chains of 24 and
// reads reach >= 6, >= 12 and = 24 off each (the first 12 towers of a chain of
// 24 move exactly as a chain of 12 until the twelfth falls).
import type { BodyDesc, Snapshot, Vec3 } from '@tb/engine-api';
import { ball, box, GAME_PARAMS, gameScene, rng, sym, yaw } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const TOWER_H = 4;
export const SPACING = 0.55;
export const PRESETTLE = 300;
/** The push: a bonded pier rocks back from 1.5 m/s (it tips 0.23 m at the top on the f64 reference and recovers). */
export const PUSH_SPEED = 3;
export const FELL = 0.15;
const STALL_STEPS = 240, TAIL_STEPS = 120, SAMPLE = 10;
export const DESIGNS = ['cubes', 'bricks', 'kapla'] as const;
export type TowerDesign = (typeof DESIGNS)[number];

export interface X3Case { design: TowerDesign; towers: number; nudge: number; presettle: number }

/** One tower's bodies standing on the ground, centred on (0, z). */
export function tower(design: TowerDesign, z: number, r: () => number, jitter: boolean): { bodies: BodyDesc[]; height: number } {
  const j = (s: number) => (jitter ? sym(r) * s : 0), out: BodyDesc[] = [];
  const at = (p: Vec3, half: Vec3, turn: number, friction?: number) => out.push(box([p[0] + j(1e-3), p[1], p[2] + z + j(1e-3)], half, yaw(turn + j((0.2 * Math.PI) / 180)), friction === undefined ? {} : { friction }));
  if (design === 'cubes') {
    const pitch = 0.51;
    for (let k = 0; k < 8; k++) for (const x of [-pitch / 2, pitch / 2]) for (const zz of [-pitch / 2, pitch / 2]) at([x, 0.25 + 0.5 * k, zz], [0.25, 0.25, 0.25], 0);
    return { bodies: out, height: 4 };
  }
  if (design === 'bricks') {
    // Two bricks side by side, 1 cm apart: long along x on even courses, along z (turned) on odd ones.
    for (let k = 0; k < 8; k++) for (const s of [-0.2525, 0.2525]) at(k % 2 ? [s, 0.25 + 0.5 * k, 0] : [0, 0.25 + 0.5 * k, s], [0.5, 0.25, 0.25], k % 2 ? Math.PI / 2 : 0);
    return { bodies: out, height: 4 };
  }
  // Kapla crib: planks on edge (0.3 m tall, 0.1 m thick, 1 m long) at the square's two edges, turned each layer.
  for (let k = 0; k < 14; k++) for (const s of [-0.45, 0.45]) at(k % 2 ? [s, 0.15 + 0.3 * k, 0] : [0, 0.15 + 0.3 * k, s], [0.5, 0.15, 0.05], k % 2 ? Math.PI / 2 : 0, 0.45);
  return { bodies: out, height: 4.2 };
}

export interface Chain { bodies: BodyDesc[]; towerOf: number[]; towers: number; height: number; pitch: number }

export function chain(c: X3Case): Chain {
  const r = rng(3000 + c.nudge), jit = c.nudge > 0, bodies: BodyDesc[] = [], towerOf: number[] = [];
  const height = tower(c.design, 0, r, false).height, pitch = SPACING * TOWER_H;
  for (let t = 0; t < c.towers; t++) for (const b of tower(c.design, t * pitch, r, jit).bodies) { bodies.push(b); towerOf.push(t); }
  return { bodies, towerOf, towers: c.towers, height, pitch };
}

export function x3Spec(c: X3Case): RunSpec {
  const ch = chain(c), r = rng(3500 + c.nudge), jit = c.nudge > 0, radius = 0.4;
  const v = PUSH_SPEED * (1 + (jit ? 0.1 * sym(r) : 0)), y = 0.75 * ch.height + (jit ? 0.1 * sym(r) : 0), x = jit ? 0.05 * sym(r) : 0;
  const push = ball([x, y, -0.5 - radius - 0.05], radius, [0, 0, v], { density: 2000 });
  const scene = gameScene(`X3-${c.design}`, { ...c }, ch.bodies, [{ step: c.presettle, kind: 'spawn', body: push }]);
  // Room for the fall to cross the chain at 1 m/s, then the stall window and the tail.
  const steps = c.presettle + Math.ceil((c.towers * ch.pitch) / 1 * 60) + STALL_STEPS + TAIL_STEPS;
  return { scene, steps, params: GAME_PARAMS, opts: { capacity: ch.bodies.length + 1, pairsPerBody: 24, boxBroadphase: true } };
}

export interface X3Result { towers: number; reach: number; fallen: number; lastFallStep: number; fallStep: number[]; /** Each tower's centre of mass at the end: moved along the chain and dropped, m. */ moved: number[]; drop: number[] }

function x3Meter(c: X3Case, spec: RunSpec): Meter<X3Result> {
  const ch = chain(c), n = ch.bodies.length, mass = spec.scene.bodies.map((b) => (b.shape.kind === 'box' ? b.shape.half[0] * b.shape.half[1] * b.shape.half[2] : 0));
  const c0 = centroids(spec.scene.bodies.map((b) => b.pos), ch, mass), fellAt = new Array<number>(ch.towers).fill(-1);
  let lastNew = c.presettle, tail = -1, last: Vec3[] = c0;
  return {
    every: SAMPLE,
    sample(step, s: Snapshot) {
      if (step < c.presettle) return;
      const pos: Vec3[] = Array.from({ length: n }, (_, i) => [s.pos[3 * i]!, s.pos[3 * i + 1]!, s.pos[3 * i + 2]!]);
      const cs = centroids(pos, ch, mass);
      last = cs;
      for (let t = 0; t < ch.towers; t++) {
        if (fellAt[t]! >= 0) continue;
        const moved = cs[t]![2] - c0[t]![2], drop = c0[t]![1] - cs[t]![1];
        if (moved > FELL * ch.height || drop > FELL * ch.height) { fellAt[t] = step - c.presettle; lastNew = step; }
      }
      if (tail < 0 && fellAt.every((x) => x >= 0)) tail = step;
      if ((tail >= 0 && step - tail >= TAIL_STEPS) || step - lastNew >= STALL_STEPS) return 'stop';
    },
    result() {
      let reach = 0;
      while (reach < ch.towers && fellAt[reach]! >= 0) reach++;
      const r2 = (x: number) => Math.round(x * 100) / 100;
      return { towers: ch.towers, reach, fallen: fellAt.filter((x) => x >= 0).length, lastFallStep: lastNew - c.presettle, fallStep: fellAt, moved: last.map((p, t) => r2(p[2] - c0[t]![2])), drop: last.map((p, t) => r2(c0[t]![1] - p[1])) };
    },
  };
}

/** Each tower's centre of mass (bodies weighted by volume; one density per design). */
function centroids(pos: Vec3[], ch: Chain, w: number[]): Vec3[] {
  const acc = Array.from({ length: ch.towers }, () => [0, 0, 0, 0]);
  for (let i = 0; i < ch.bodies.length; i++) { const a = acc[ch.towerOf[i]!]!; for (let k = 0; k < 3; k++) a[k]! += w[i]! * pos[i]![k]!; a[3]! += w[i]!; }
  return acc.map((a) => [a[0]! / a[3]!, a[1]! / a[3]!, a[2]! / a[3]!]);
}

function x3Cases(size: Size): X3Case[] {
  const out: X3Case[] = [];
  for (const design of DESIGNS) {
    if (size === 'ci') { out.push({ design, towers: 3, nudge: 1, presettle: 120 }); continue; }
    for (let nudge = 1; nudge <= 32; nudge++) out.push({ design, towers: 24, nudge, presettle: PRESETTLE });
  }
  return out;
}

function x3Verdict(runs: CaseRun<X3Case, X3Result>[], size: Size): Verdict {
  const table = ['| design | towers | runs | reach >= 6 | reach >= 12 | reach all | reach mean (min-max) | fallen mean | mean time per tower s | limits |', '|---|---|---|---|---|---|---|---|---|---|'], checks: Check[] = [];
  let any12 = false;
  for (const d of DESIGNS) {
    const rs = runs.filter((r) => r.c.design === d);
    if (!rs.length) continue;
    const res = rs.map((r) => r.result), n = rs[0]!.c.towers, frac = (k: number) => res.filter((x) => x.reach >= k).length / res.length;
    const per = res.filter((x) => x.reach >= 3).map((x) => (x.fallStep[x.reach - 1]! - x.fallStep[0]!) / (x.reach - 1) / 60);
    const pct = (f: number) => `${(100 * f).toFixed(0)}%`;
    table.push(`| ${d} | ${n} | ${rs.length} | ${n >= 6 ? pct(frac(6)) : '-'} | ${n >= 12 ? pct(frac(12)) : '-'} | ${pct(frac(n))} | ${(res.reduce((a, x) => a + x.reach, 0) / res.length).toFixed(1)} (${Math.min(...res.map((x) => x.reach))}-${Math.max(...res.map((x) => x.reach))}) | ${(res.reduce((a, x) => a + x.fallen, 0) / res.length).toFixed(1)} | ${per.length ? (per.reduce((a, b) => a + b, 0) / per.length).toFixed(2) : '-'} | ${rs.flatMap((r) => r.limits).length} |`);
    if (n >= 12) {
      const ok = frac(12) >= 0.8;
      any12 ||= ok;
      checks.push({ name: `${d}: 12 towers propagate in 80% of nudges`, pass: ok, detail: `${pct(frac(12))} of ${rs.length}` });
    }
  }
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  return { pass: size === 'full' ? any12 && runs.every((r) => r.limits.length === 0) : null, checks, table };
}

export const X3: Probe<X3Case, X3Result> = {
  id: 'X3',
  title: 'Towers as dominoes',
  question: 'Does a falling tower knock the next one over, down a chain of slender bonded towers?',
  rule: 'At least one design propagates 12 towers in 80% of nudges (chains of 6, 12 and 24; read here off chains of 24).',
  cases: x3Cases,
  label: (c) => `${c.design} x${c.towers} nudge ${c.nudge}`,
  spec: x3Spec,
  meter: x3Meter,
  verdict: x3Verdict,
};

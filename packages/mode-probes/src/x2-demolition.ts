// X2: does order matter when a building comes down? (modes-roadmap.md
// section 7; gates M5 Fuse & Fold.)
//
// Two designs of 0.5 m plaster cells on the game's lattice (2 % horizontal
// gap), a footprint of W x D cells, H courses:
//   cubes   a solid block of cubes, as S14 builds a building;
//   slabs   storeys of two courses of columns (the outer ring of cells and a
//           2 x 2 core) under a one-cell slab spanning the whole footprint.
// Four removal charges cut the whole ground storey (the lowest two courses)
// between them: the core (C: every cell inside the outer ring for cubes, the
// 2 x 2 core for slabs), the west wall (W), the east wall (E) and the north
// and south walls between them (NS). A charge is a set of RemoveEvents (the C5
// removeTarget verb on today's events), so the only energy in the collapse is
// gravity's and the outcome depends on what goes when. Orders (delays after
// the first firing): all at once (a straight drop); the classic implosion,
// core first and the walls 0.3 s later; a felling, every charge but the east
// wall's first, so the building overhangs the east wall and tips west, then
// the east wall 0.3 s or 0.6 s later; and its control, the east wall first
// and the rest 0.3 s later (the building still stands on the rest).
// The world pre-settles PRESETTLE steps
// (Keystone's 300) first; each nudge jitters every cell by +-1 mm and
// +-0.2 deg of yaw from its own seed.
//
// Footprint metric (the skill gate's): spill, the fraction of the remaining
// mass whose centre ends outside the footprint grown by one cell (0.5 m) on
// every side; range [0, 1]. Also: down, the fraction of the remaining mass
// whose centre ends more than 1 m below where it started (did it come down
// at all), lean (the remaining mass's mean x, in cells: + east), and the
// rubble's height. The run ends when every body has been
// slower than 0.05 m/s for 1 s after the last charge, or SETTLE_CAP steps
// after it.
import { type BodyDesc, type InputEvent, type Snapshot, TIER_FREE } from '@tb/engine-api';
import { box, GAME_PARAMS, gameScene, rng, sym, yaw } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const CELL = 0.5;
export const PITCH = 1.02 * CELL;
export const PRESETTLE = 300;
export const SETTLE_CAP = 900;
const QUIET_SPEED = 0.05, QUIET_STEPS = 60, SAMPLE = 10;

export type Design = 'cubes' | 'slabs';
export const CHARGES = ['C', 'W', 'E', 'NS'] as const;
export type Charge = (typeof CHARGES)[number];
/** Each charge's delay in steps after the first firing. */
export interface Order { name: string; at: Record<Charge, number> }
export const ORDERS: readonly Order[] = [
  { name: 'all at once', at: { C: 0, W: 0, E: 0, NS: 0 } },
  { name: 'core, walls +0.3 s', at: { C: 0, W: 18, E: 18, NS: 18 } },
  { name: 'fell west, east wall +0.3 s', at: { C: 0, W: 0, NS: 0, E: 18 } },
  { name: 'fell west, east wall +0.6 s', at: { C: 0, W: 0, NS: 0, E: 36 } },
  { name: 'east wall, rest +0.3 s', at: { E: 0, C: 18, W: 18, NS: 18 } },
];
const lastDelay = (o: Order) => Math.max(...CHARGES.map((k) => o.at[k]));

export interface X2Case { design: Design; W: number; D: number; H: number; order: Order; nudge: number; presettle: number }

export interface Building { bodies: BodyDesc[]; charges: Record<Charge, number[]> }

/** Cells and slabs of a design, and the bodies each charge removes. */
export function building(design: Design, W: number, D: number, H: number, nudge: number): Building {
  const r = rng(2000 + nudge), jit = nudge > 0;
  const bodies: BodyDesc[] = [], charges: Building['charges'] = { C: [], W: [], E: [], NS: [] };
  const cx = (i: number) => (i - (W - 1) / 2) * PITCH, cz = (j: number) => (j - (D - 1) / 2) * PITCH;
  const core = (i: number, j: number) => Math.abs(cx(i)) < PITCH && Math.abs(cz(j)) < PITCH;
  const ring = (i: number, j: number) => i === 0 || j === 0 || i === W - 1 || j === D - 1;
  const cell = (i: number, j: number, k: number) => {
    const id = bodies.length;
    bodies.push(box([cx(i) + (jit ? sym(r) * 1e-3 : 0), (k + 0.5) * CELL, cz(j) + (jit ? sym(r) * 1e-3 : 0)], [CELL / 2, CELL / 2, CELL / 2], yaw(jit ? (sym(r) * 0.2 * Math.PI) / 180 : 0)));
    if (k < 2) charges[!ring(i, j) ? 'C' : i === 0 ? 'W' : i === W - 1 ? 'E' : 'NS'].push(id);
  };
  for (let k = 0; k < H; k++) {
    if (design === 'slabs' && k % 3 === 2) {
      // One slab over the footprint, its edges flush with the outer cells' faces.
      bodies.push(box([0, (k + 0.5) * CELL, 0], [((W - 1) * PITCH + CELL) / 2, CELL / 2, ((D - 1) * PITCH + CELL) / 2]));
      continue;
    }
    for (let j = 0; j < D; j++) for (let i = 0; i < W; i++) if (design === 'cubes' || ring(i, j) || core(i, j)) cell(i, j, k);
  }
  return { bodies, charges };
}

export function x2Spec(c: X2Case): RunSpec {
  const b = building(c.design, c.W, c.D, c.H, c.nudge), at = c.presettle;
  const fire = (ids: number[], step: number): InputEvent[] => ids.map((id) => ({ step, kind: 'remove', id }));
  const inputs = CHARGES.flatMap((k) => fire(b.charges[k], at + c.order.at[k]));
  const scene = gameScene(`X2-${c.design}`, { W: c.W, D: c.D, H: c.H, order: c.order.name, nudge: c.nudge }, b.bodies, inputs);
  return { scene, steps: at + lastDelay(c.order) + SETTLE_CAP, params: GAME_PARAMS, opts: { capacity: b.bodies.length, pairsPerBody: 24, boxBroadphase: true } };
}

export interface X2Result { spill: number; down: number; lean: number; height: number; settled: boolean; steps: number; removed: number }

export function footprintOf(c: Pick<X2Case, 'W' | 'D'>): { x: number; z: number } {
  // Half extents of the footprint grown by one cell on every side.
  return { x: ((c.W - 1) * PITCH + CELL) / 2 + CELL, z: ((c.D - 1) * PITCH + CELL) / 2 + CELL };
}

function x2Meter(c: X2Case, spec: RunSpec): Meter<X2Result> {
  const bodies = spec.scene.bodies, mass = bodies.map((b) => (b.shape.kind === 'box' ? 8 * b.shape.half[0] * b.shape.half[1] * b.shape.half[2] : 0) * b.density);
  const y0 = bodies.map((b) => b.pos[1]), last = c.presettle + lastDelay(c.order), fp = footprintOf(c);
  let quiet = 0, out: X2Result = { spill: 0, down: 0, lean: 0, height: 0, settled: false, steps: 0, removed: 0 };
  const measure = (s: Snapshot, settled: boolean, step: number): X2Result => {
    let m = 0, spilt = 0, down = 0, mx = 0, top = 0, removed = 0;
    for (let i = 0; i < bodies.length; i++) {
      if (s.tier?.[i] === TIER_FREE) { removed++; continue; }
      const x = s.pos[3 * i]!, y = s.pos[3 * i + 1]!, z = s.pos[3 * i + 2]!;
      m += mass[i]!; mx += mass[i]! * x;
      if (Math.abs(x) > fp.x || Math.abs(z) > fp.z) spilt += mass[i]!;
      if (y < y0[i]! - 1) down += mass[i]!;
      top = Math.max(top, y + CELL / 2);
    }
    return { spill: spilt / m, down: down / m, lean: mx / m / PITCH, height: top, settled, steps: step, removed };
  };
  return {
    every: SAMPLE,
    sample(step, s) {
      if (step <= last) return;
      let vmax = 0;
      for (let i = 0; i < bodies.length; i++) if (s.tier?.[i] !== TIER_FREE) vmax = Math.max(vmax, Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!));
      quiet = vmax < QUIET_SPEED ? quiet + SAMPLE : 0;
      out = measure(s, quiet >= QUIET_STEPS, step);
      if (out.settled) return 'stop';
    },
    result: () => out,
  };
}

const DESIGNS: Record<Size, Array<Pick<X2Case, 'design' | 'W' | 'D' | 'H'>>> = {
  // S14's default building (4 x 4 x 12), and its slab-floor variant.
  ci: [{ design: 'cubes', W: 4, D: 4, H: 6 }, { design: 'slabs', W: 4, D: 4, H: 6 }],
  full: [{ design: 'cubes', W: 4, D: 4, H: 12 }, { design: 'slabs', W: 4, D: 4, H: 12 }],
};

function x2Cases(size: Size): X2Case[] {
  const out: X2Case[] = [];
  const orders = size === 'full' ? ORDERS : [ORDERS[0]!, ORDERS[2]!];
  for (const d of DESIGNS[size]) for (const order of orders) for (let nudge = 1; nudge <= (size === 'full' ? 32 : 1); nudge++) out.push({ ...d, order, nudge, presettle: size === 'full' ? PRESETTLE : 120 });
  return out;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs: number[]) => { const m = mean(xs); return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, xs.length - 1)); };

function x2Verdict(runs: CaseRun<X2Case, X2Result>[], size: Size): Verdict {
  const table = ['| design | order | runs | spill mean (sd) | down mean | lean mean (sd), cells | rubble height m | settled | limits |', '|---|---|---|---|---|---|---|---|---|'], checks: Check[] = [];
  const designs = [...new Set(runs.map((r) => r.c.design))];
  let anyOrderMatters = false;
  for (const d of designs) {
    const byOrder = new Map<string, CaseRun<X2Case, X2Result>[]>();
    for (const r of runs.filter((x) => x.c.design === d)) byOrder.set(r.c.order.name, [...(byOrder.get(r.c.order.name) ?? []), r]);
    const stats = [...byOrder].map(([name, rs]) => {
      const sp = rs.map((r) => r.result.spill);
      table.push(`| ${d} ${rs[0]!.c.W}x${rs[0]!.c.D}x${rs[0]!.c.H} | ${name} | ${rs.length} | ${mean(sp).toFixed(3)} (${sd(sp).toFixed(3)}) | ${mean(rs.map((r) => r.result.down)).toFixed(3)} | ${mean(rs.map((r) => r.result.lean)).toFixed(2)} (${sd(rs.map((r) => r.result.lean)).toFixed(2)}) | ${mean(rs.map((r) => r.result.height)).toFixed(2)} | ${rs.filter((r) => r.result.settled).length}/${rs.length} | ${rs.flatMap((r) => r.limits).length} |`);
      return { name, m: mean(sp), se: sd(sp) / Math.sqrt(sp.length), down: mean(rs.map((r) => r.result.down)) };
    });
    const base = stats.find((s) => s.name === ORDERS[0]!.name);
    for (const s of stats) {
      if (!base || s === base) continue;
      const diff = Math.abs(s.m - base.m), z = diff / Math.hypot(s.se, base.se || 1e-9);
      // The skill gate: 0.1 of the metric's range, and more than 3 standard errors (not nudge noise).
      const matters = diff >= 0.1 && z > 3;
      anyOrderMatters ||= matters;
      checks.push({ name: `${d}: "${s.name}" vs "all at once"`, pass: matters, detail: `spill ${s.m.toFixed(3)} vs ${base.m.toFixed(3)}, |diff| ${diff.toFixed(3)} (need >= 0.1), ${s.se + base.se > 0 ? `${z.toFixed(1)} standard errors` : 'one run each, no spread'}` });
    }
    checks.push({ name: `${d}: the building comes down (down >= 0.5 with every charge fired)`, pass: stats.every((s) => s.down >= 0.5), detail: stats.map((s) => `${s.name} ${s.down.toFixed(2)}`).join(', ') });
  }
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  // The rule: order matters on at least one design. The other checks are reported, not required.
  return { pass: size === 'full' ? anyOrderMatters && runs.every((r) => r.limits.length === 0) : null, checks, table };
}

export const X2: Probe<X2Case, X2Result> = {
  id: 'X2',
  title: 'Order matters in demolition',
  question: 'Does the order in which charges fire change where a building ends up?',
  rule: 'The footprint metric (spill: share of mass outside the footprint plus one cell) differs between orders by at least 0.1 of its range on one design; here also by more than 3 standard errors of the nudge means.',
  cases: x2Cases,
  label: (c) => `${c.design} ${c.W}x${c.D}x${c.H} ${c.order.name} nudge ${c.nudge}`,
  spec: x2Spec,
  meter: x2Meter,
  verdict: x2Verdict,
};

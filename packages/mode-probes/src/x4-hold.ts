// X4: do cantilevers and hollowed structures hold at rest? (modes-roadmap.md
// section 7; gates M1 Undercut's Hollow levels and M8 Mason's Trial.)
//
// Plaster at game settings, each case at 20 and 40 iterations (Keystone plays
// 40) for 3,600 steps (60 s) after a pre-settle of PRESETTLE steps:
//   overhang  a harmonic stack of n = 8 blocks (1 x 0.25 x 0.5 m) over the edge
//             of a 2 m pedestal: block i from the top overhangs the one below
//             by f L / (2 i), f = 0.95 (every sub-stack's centre of mass inside
//             its support, so it must hold) or 1.05 (every one outside, so it
//             must fall). Four placement seeds each.
//   span      a corbelled 3 m span: on each side seven courses of two bricks
//             (1 x 0.5 x 0.5 m), each course stepped 0.25 m inward, the top
//             courses meeting in the middle 3.5 m up. It must hold 60 s, and
//             carry a bowling ball (the weapons preset: 0.218 m, 1,340 kg/m^3)
//             rolled across its top at about 2 m/s, 32 nudges (speed +-20 %,
//             sideways +-5 cm, placement +-1 mm).
//   arch      a wall hollowed to an arch: the bodies whose centres lie inside
//             a half disc of radius R at the wall's foot are removed after the
//             pre-settle. Two walls: running-bond bricks (1 x 0.5 x 0.5 m,
//             1 cm joints, 20 bricks x 25 courses) and the game's own lattice
//             of 0.5 m cubes (40 x 25 = 1,000, 2 % gap: every column stands
//             alone, so nothing over the hole has anything to rest on).
// Holds: nothing drops 0.25 m from where it started and no remaining body
// moves HOLD_TOL from its pose at the end of the pre-settle (the game also
// pre-settles before play). Falls: the top block drops 0.2 m. A hollowed wall
// holds when only bricks over the hole come down (within R + 1 m of the
// centre line) and, from CREEP_FROM steps after the removal on, no brick of
// the wall outside that shadow moves HOLD_TOL (no creep): bricks the hollow
// leaves on a knife edge or unsupported fall, as they would in masonry, and
// may do so slowly. The first Metal run (2026-11-06) failed the arch on
// creep everywhere: one brick 1.7 m over the crown slid 1.4 cm in 55 s, most
// of it late, a slow fall over the hole; the wall beside it moved 4 mm.
// Creep over the hole is reported, as the knife-edge drops are.
import { type BodyDesc, type InputEvent, type Snapshot, TIER_FREE } from '@tb/engine-api';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { ball, box, GAME_PARAMS, gameScene, rng, sym } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const PRESETTLE = 300;
export const HOLD_STEPS = 3600;
/** A body that moves this far has not held, m (2 % of a 0.5 m cell). */
export const HOLD_TOL = 0.01;
const SAMPLE = 10;

export type X4Case =
  | { kind: 'overhang'; f: number; n: number; iterations: number; seed: number; steps: number; presettle: number }
  | { kind: 'span'; iterations: number; nudge: number; ball: boolean; steps: number; presettle: number }
  | { kind: 'arch'; wall: 'bricks' | 'cubes'; W: number; H: number; R: number; iterations: number; steps: number; presettle: number };

const BLOCK = { L: 1, h: 0.25, d: 0.5 };

/** The pedestal (body 0, its top at y = 1, its edge at x = 0) and the stack, bottom block first. */
export function overhang(n: number, f: number, seed: number): BodyDesc[] {
  const r = rng(4000 + seed), j = () => (seed > 0 ? sym(r) * 1e-3 : 0);
  const out = [box([-1, 0.5, 0], [1, 0.5, 0.5])];
  // Right ends from the bottom (i = n) up: each block's right end overhangs the one below by f L / (2 i).
  let right = 0;
  for (let i = n; i >= 1; i--) {
    right += (f * BLOCK.L) / (2 * i);
    const k = n - i;
    out.push(box([right - BLOCK.L / 2 + j(), 1 + BLOCK.h * (k + 0.5) + 1e-6 * (k + 1), j()], [BLOCK.L / 2, BLOCK.h / 2, BLOCK.d / 2]));
  }
  return out;
}

/** The theoretical overhang of n blocks: L / 2 times the n-th harmonic number. */
export const harmonicOverhang = (n: number) => (BLOCK.L / 2) * Array.from({ length: n }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);

export const SPAN = { courses: 7, step: 0.25, inner: 1.5, brick: [0.5, 0.25, 0.25] as [number, number, number] };

/** The corbelled span: per side and course, two bricks from the course's inner end outward. */
export function span(nudge: number): BodyDesc[] {
  const r = rng(4100 + nudge), j = () => (nudge > 0 ? sym(r) * 1e-3 : 0), out: BodyDesc[] = [];
  for (let k = 0; k < SPAN.courses; k++) {
    const u = Math.max(1e-4, SPAN.inner - SPAN.step * k);
    for (const s of [-1, 1]) for (const b of [0, 1]) out.push(box([s * (u + 0.5 + b * 1.01) + j(), 0.25 + 0.5 * k + 1e-6 * k, j()], SPAN.brick));
  }
  return out;
}

/** A wall, and the ids inside the half disc of radius R at its foot. */
export function wall(kind: 'bricks' | 'cubes', W: number, H: number, R: number): { bodies: BodyDesc[]; hollow: number[] } {
  const bodies: BodyDesc[] = [], hollow: number[] = [];
  const add = (b: BodyDesc) => { if (Math.hypot(b.pos[0], b.pos[1]) < R) hollow.push(bodies.length); bodies.push(b); };
  if (kind === 'cubes') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) add(box([(x - (W - 1) / 2) * 0.51, 0.25 + 0.5 * y, 0], [0.25, 0.25, 0.25]));
    return { bodies, hollow };
  }
  // Running bond: W bricks on even courses; on odd ones a half brick (a cube) at each end and W - 1 bricks between.
  const P = 1.01, x0 = -(W * P) / 2;
  for (let y = 0; y < H; y++) {
    const cy = 0.25 + 0.5 * y;
    if (y % 2 === 0) for (let x = 0; x < W; x++) add(box([x0 + P * x + 0.5, cy, 0], [0.5, 0.25, 0.25]));
    else {
      add(box([x0 + 0.25, cy, 0], [0.25, 0.25, 0.25]));
      for (let x = 0; x < W - 1; x++) add(box([x0 + 0.51 + P * x + 0.5, cy, 0], [0.5, 0.25, 0.25]));
      add(box([x0 + 0.51 + P * (W - 1) + 0.25, cy, 0], [0.25, 0.25, 0.25]));
    }
  }
  return { bodies, hollow };
}

const bowling = PROJECTILE_PRESETS.bowlingball;

export function x4Spec(c: X4Case): RunSpec {
  const params = { ...GAME_PARAMS, iterations: c.iterations }, steps = c.presettle + c.steps;
  if (c.kind === 'overhang') {
    const bodies = overhang(c.n, c.f, c.seed);
    return { scene: gameScene('X4-overhang', { ...c }, bodies), steps, params, opts: { capacity: bodies.length } };
  }
  if (c.kind === 'span') {
    const bodies = span(c.nudge), inputs: InputEvent[] = [];
    if (c.ball) {
      const r = rng(4200 + c.nudge), jit = c.nudge > 0, radius = bowling.diameter / 2, v = 2 * (1 + (jit ? 0.2 * sym(r) : 0));
      inputs.push({ step: c.presettle, kind: 'spawn', body: ball([-1.8, 3.5 + radius + 1e-3, jit ? 0.05 * sym(r) : 0], radius, [v, 0, 0], { density: bowling.density, friction: bowling.friction }) });
    }
    return { scene: gameScene('X4-span', { ...c }, bodies, inputs), steps, params, opts: { capacity: bodies.length + inputs.length } };
  }
  const w = wall(c.wall, c.W, c.H, c.R);
  const inputs: InputEvent[] = w.hollow.map((id) => ({ step: c.presettle, kind: 'remove', id }));
  return { scene: gameScene(`X4-arch-${c.wall}`, { ...c }, w.bodies, inputs), steps, params, opts: { capacity: w.bodies.length, pairsPerBody: 24, boxBroadphase: true } };
}

export interface X4Result {
  /** Largest move of a remaining structure body from its pose at the end of the pre-settle, m. */
  maxMove: number;
  /** Structure bodies that dropped 0.25 m from where they started (ids), and the share of them over the hole (arch). */
  dropped: number[];
  outsideShadow: number;
  /** Arch: largest move, from CREEP_FROM steps after the removal on, of a body that did not drop: the remainder creeping. */
  creep: number;
  /** Arch: which body crept most (id), where it stood when the creep window opened (x, y, m), and its creep in the window's second half alone: a settle ends early, a creep goes on. */
  creepBody: number;
  creepFromPos: [number, number] | null;
  creepLate: number;
  /** Arch: the largest creep of a body outside the hole's shadow (|x| > R + 1 m at the start): the wall itself. */
  creepWall: number;
  /** The top block's drop from its start (overhang), m. */
  topDrop: number;
  /** The ball's x at the end (span): past 1 m it crossed. */
  ballX: number | null;
  steps: number;
}

/** Steps after the removal by which a hollowed wall's collapse has played out (the creep window starts). */
export const CREEP_FROM = 300;

function x4Meter(c: X4Case, spec: RunSpec): Meter<X4Result> {
  const bodies = spec.scene.bodies, n = bodies.length, top = c.kind === 'overhang' ? n - 1 : -1;
  // The overhang's pedestal is not part of the structure under test; every other body is.
  const first = c.kind === 'overhang' ? 1 : 0, creepFrom = c.presettle + Math.min(CREEP_FROM, c.steps / 2);
  const y0 = bodies.map((b) => b.pos[1]);
  const lateFrom = creepFrom + Math.floor((c.presettle + c.steps - creepFrom) / 2 / SAMPLE) * SAMPLE;
  let ref: Float64Array | null = null, refC: Float64Array | null = null, refL: Float64Array | null = null, maxMove = 0, creep = 0, creepBody = -1, creepLate = 0, creepWall = 0;
  let out: X4Result = { maxMove: 0, dropped: [], outsideShadow: 0, creep: 0, creepBody: -1, creepFromPos: null, creepLate: 0, creepWall: 0, topDrop: 0, ballX: null, steps: 0 };
  const shadowR = c.kind === 'arch' ? c.R + 1 : Infinity;
  const dist = (s: Snapshot, r: Float64Array, i: number) => Math.hypot(s.pos[3 * i]! - r[3 * i]!, s.pos[3 * i + 1]! - r[3 * i + 1]!, s.pos[3 * i + 2]! - r[3 * i + 2]!);
  return {
    every: SAMPLE,
    sample(step, s: Snapshot) {
      if (step === c.presettle) ref = s.pos.slice(0, 3 * n);
      if (step === creepFrom) refC = s.pos.slice(0, 3 * n);
      if (step === lateFrom) refL = s.pos.slice(0, 3 * n);
      if (!ref || step < c.presettle) return;
      const dropped: number[] = [];
      for (let i = first; i < n; i++) {
        if (s.tier?.[i] === TIER_FREE) continue;
        maxMove = Math.max(maxMove, dist(s, ref, i));
        const down = y0[i]! - s.pos[3 * i + 1]! > 0.25;
        if (down) dropped.push(i);
        else if (refC) {
          const d = dist(s, refC, i);
          if (d > creep) { creep = d; creepBody = i; }
          if (Math.abs(bodies[i]!.pos[0]) > shadowR) creepWall = Math.max(creepWall, d);
          if (refL) creepLate = Math.max(creepLate, dist(s, refL, i));
        }
      }
      const R = c.kind === 'arch' ? c.R : 0;
      out = {
        maxMove, dropped, outsideShadow: dropped.filter((i) => Math.abs(bodies[i]!.pos[0]) > R + 1).length, creep, creepBody, creepLate, creepWall,
        creepFromPos: refC && creepBody >= 0 ? [refC[3 * creepBody]!, refC[3 * creepBody + 1]!] : null,
        topDrop: top >= 0 ? y0[top]! - s.pos[3 * top + 1]! : 0, ballX: c.kind === 'span' && c.ball ? s.pos[3 * n]! : null, steps: step,
      };
      // A stack that has clearly fallen needs no more steps.
      if (c.kind === 'overhang' && out.topDrop > 0.5 && step - c.presettle > 120) return 'stop';
    },
    result: () => out,
  };
}

function x4Cases(size: Size): X4Case[] {
  if (size === 'ci') return [
    { kind: 'overhang', f: 0.95, n: 8, iterations: 40, seed: 1, steps: 360, presettle: 120 },
    { kind: 'overhang', f: 1.05, n: 8, iterations: 40, seed: 1, steps: 360, presettle: 120 },
    { kind: 'span', iterations: 40, nudge: 1, ball: true, steps: 240, presettle: 120 },
    { kind: 'arch', wall: 'bricks', W: 8, H: 8, R: 1.6, iterations: 40, steps: 240, presettle: 120 },
  ];
  const out: X4Case[] = [];
  for (const iterations of [20, 40]) {
    for (const f of [0.95, 1.05]) for (let seed = 0; seed < 4; seed++) out.push({ kind: 'overhang', f, n: 8, iterations, seed, steps: HOLD_STEPS, presettle: PRESETTLE });
    out.push({ kind: 'span', iterations, nudge: 0, ball: false, steps: HOLD_STEPS, presettle: PRESETTLE });
    for (const w of ['bricks', 'cubes'] as const) out.push({ kind: 'arch', wall: w, W: w === 'bricks' ? 20 : 40, H: 25, R: 5, iterations, steps: HOLD_STEPS, presettle: PRESETTLE });
  }
  for (let nudge = 1; nudge <= 32; nudge++) out.push({ kind: 'span', iterations: 40, nudge, ball: true, steps: 300, presettle: PRESETTLE });
  return out;
}

const label = (c: X4Case) => (c.kind === 'overhang' ? `overhang ${Math.round(c.f * 100)}% it ${c.iterations} seed ${c.seed}` : c.kind === 'span' ? `span${c.ball ? ` ball nudge ${c.nudge}` : ' hold'} it ${c.iterations}` : `arch ${c.wall} ${c.W}x${c.H} R ${c.R} it ${c.iterations}`);

function x4Verdict(runs: CaseRun<X4Case, X4Result>[], size: Size): Verdict {
  const table = ['| case | runs | held (nothing dropped, no body moved 1 cm) | max move m (worst) | dropped (worst), outside the hole | creep m: wall outside the hole; anywhere (second half; body at x, y) | top drop m | ball crossed | seconds run | limits |', '|---|---|---|---|---|---|---|---|---|---|'], checks: Check[] = [];
  const groups = new Map<string, CaseRun<X4Case, X4Result>[]>();
  for (const r of runs) { const k = label(r.c).replace(/ (seed|nudge) \d+/, ''); groups.set(k, [...(groups.get(k) ?? []), r]); }
  const held = (x: X4Result) => x.maxMove < HOLD_TOL && x.dropped.length === 0;
  const worst = (xs: number[]) => Math.max(...xs).toFixed(4);
  const creepCell = (res: X4Result[]) => {
    const w = res.reduce((a, b) => (b.creep > a.creep ? b : a));
    return `${Math.max(...res.map((x) => x.creepWall)).toFixed(4)}; ${w.creep.toFixed(4)} (${w.creepLate.toFixed(4)}; ${w.creepFromPos ? w.creepFromPos.map((v) => v.toFixed(2)).join(', ') : '-'})`;
  };
  for (const [k, rs] of groups) {
    const res = rs.map((r) => r.result), c = rs[0]!.c, nHeld = res.filter(held).length;
    const crossed = c.kind === 'span' && c.ball ? res.filter((x) => (x.ballX ?? 0) > 1).length : null;
    table.push(`| ${k} | ${rs.length} | ${nHeld}/${rs.length} | ${worst(res.map((x) => x.maxMove))} | ${Math.max(...res.map((x) => x.dropped.length))}, ${Math.max(...res.map((x) => x.outsideShadow))} | ${c.kind === 'arch' ? creepCell(res) : '-'} | ${c.kind === 'overhang' ? Math.min(...res.map((x) => x.topDrop)).toFixed(3) : '-'} | ${crossed === null ? '-' : `${crossed}/${rs.length}`} | ${((Math.min(...res.map((x) => x.steps)) - c.presettle) / 60).toFixed(0)} | ${rs.flatMap((r) => r.limits).length} |`);
    if (c.kind === 'overhang' && c.f < 1) checks.push({ name: `${k}: the 95% stack holds`, pass: nHeld === rs.length, detail: `${nHeld}/${rs.length} held, worst move ${worst(res.map((x) => x.maxMove))} m` });
    if (c.kind === 'overhang' && c.f > 1) checks.push({ name: `${k}: the 105% stack falls`, pass: res.every((x) => x.topDrop > 0.2), detail: `top drops ${res.map((x) => x.topDrop.toFixed(2)).join(', ')} m` });
    if (c.kind === 'span' && !c.ball) checks.push({ name: `${k}: the span holds 60 s`, pass: nHeld === rs.length, detail: `max move ${worst(res.map((x) => x.maxMove))} m, ${res[0]!.dropped.length} dropped` });
    if (c.kind === 'span' && c.ball) checks.push({ name: `${k}: carries the bowling ball in 80% of nudges`, pass: res.filter((x) => held(x) && (x.ballX ?? 0) > 1).length >= 0.8 * rs.length, detail: `${res.filter((x) => held(x) && (x.ballX ?? 0) > 1).length}/${rs.length} held with the ball across` });
    if (c.kind === 'arch') {
      checks.push({ name: `${k}: the arch holds (only bricks over the hole come down, and the wall beside it does not creep)`, pass: res.every((x) => x.outsideShadow === 0 && x.creepWall < HOLD_TOL), detail: `${res[0]!.dropped.length} dropped, ${res[0]!.outsideShadow} outside the hole, wall creep ${worst(res.map((x) => x.creepWall))} m` });
      checks.push({ name: `(reported) ${k}: nothing over the hole creeps either`, pass: res.every((x) => x.creep < HOLD_TOL), detail: `creep ${creepCell(res)}` });
    }
  }
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  // The rule names the brick arch (an arch); the cube lattice wall is the game's own walls, reported.
  const decisive = checks.filter((x) => !x.name.startsWith('arch cubes') && !x.name.startsWith('(reported)'));
  return { pass: size === 'full' ? decisive.every((x) => x.pass) : null, checks, table };
}

export const X4: Probe<X4Case, X4Result> = {
  id: 'X4',
  title: 'Cantilevers and hollows hold',
  question: 'Do cantilevers, corbelled spans and hollowed walls hold at rest at game settings, and fall when they should?',
  rule: '95% harmonic stacks hold and 105% stacks fall; the corbelled 3 m span holds 60 s and carries a bowling ball in 80% of nudges; the arch holds (3,600 steps at 20 and 40 iterations). The cube-lattice arch is reported, not required.',
  cases: x4Cases,
  label,
  spec: x4Spec,
  meter: x4Meter,
  verdict: x4Verdict,
};

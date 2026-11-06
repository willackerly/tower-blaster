// X6: do friction stacks resonate under a gravity schedule, and does a far
// blast shove the world uniformly? (modes-roadmap.md section 7 and claim 6;
// gates M7 Aftershock.)
//
// Shake. The gravity schedule is C7's field events (engine-api field.ts): one
// quantised key per step that changes it, in the scene's inputs. (The probe
// first ran on an emulation that rewrote SceneDesc.gravity before each step;
// results of 2026-11-05 in mode-probes.md.) A horizontal gravity on a still
// ground is a shaking ground seen from the ground's frame.
// Single columns of 5, 10 and 20 cubes (0.5 m plaster, aspect b/h = 1/n)
// stand 4 m apart, every height NUDGES times over in one scene (islands that
// cannot touch); each scene shakes at one frequency f:
//   g_x(t) = A(t) g sin(2 pi f t),  A(t) = A0 * GROWTH^(f t)
// (the envelope grows by GROWTH a cycle from A0, to A_MAX), after a
// pre-settle at plain gravity. A column has failed once any cube is 0.25 m
// below where it stood. Its failure amplitude is the envelope when it was
// last nearly upright (top within 5 cm of over its base cube) before it
// failed, the start of the fatal excursion; reading it at the fall would
// overstate it by the growth over the fall. A column whose base cube slides
// 0.1 m first is recorded as sliding: friction 0.6 lets a column slide at
// 0.6 g, and the roadmap's risk is that stacks slide instead of resonating.
//
// Two references to read the result against. Statics: a rigid column tips
// once a steady side load passes g b / h = g / n (0.2, 0.1, 0.05 g).
// Housner's rocking block (1963): a block of half-diagonal R has the rocking
// frequency p = sqrt(3 g / 4 R) (0.38, 0.27, 0.19 Hz for 5, 10, 20 cubes,
// below every shaking frequency here), and above p the amplitude it takes to
// overturn it grows as (1 / n) sqrt(1 + (omega / p)^2) (rockingA): a rocking
// block is not an oscillator with a natural frequency to tune to. Resonance
// in the roadmap's sense would show as a dip in the failure amplitude at
// some f that moves lower with height; the rocking estimate says the most
// destructive frequency is the lowest for every height.
//
// Shove. Claim 6: a blast centred far away, with a flat core and maxDv set,
// gives every body in reach the same kick. A cube grid floating in no
// gravity (1,000 cubes, 1 m apart) and a standing 6 x 6 x 8 cube building
// on the game lattice take a blast centred DIST m off along -x at their
// mid-height: radius 3 DIST, core 0.999, falloff 0, an impulse far above
// what maxDv caps. Expected kick: maxDv along (p - centre) / |p - centre|.
// Measured: each body's velocity change over the blast's step, and LATER
// steps on the spread of the bodies' velocities along the blast. The rule's
// check is the kick itself, on the free grid. On the standing building the
// blast's step also solves its contacts, and Coulomb's answer for a stack
// that moves as one is a uniform loss of mu g dt (3.3 % of 3 m/s): that is
// reported against, as the response a jolted building gives, not the kick.
import { type BodyDesc, type InputEvent, quantiseVec3, scheduleEvents, type Snapshot, type Vec3 } from '@tb/engine-api';
import { box, DT, GAME_PARAMS, gameScene, GRAVITY, PLASTER, rng, sym, yaw } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const CELL = 0.5;
export const PITCH = 1.02 * CELL;
export const HEIGHTS = [5, 10, 20] as const;
export const TOWER_GAP = 4;
export const FELL = 0.25, UPRIGHT = 0.05, SLID = 0.1;
export const A0 = 0.02, A_MAX = 1;
export const SHOVE_DV = 3;
/** The shove's second reading, this many steps after the blast's step. */
export const LATER = 10;

export type X6Case =
  | { kind: 'shake'; f: number; growth: number; nudges: number; presettle: number; a0?: number; aMax?: number }
  | { kind: 'shove'; design: 'floating' | 'standing'; dist: number; presettle: number };

export interface Column { height: number; nudge: number; first: number }

/** Every height `nudges` times, 4 m apart along z: the bodies and which column each starts. */
export function columns(nudges: number, seed: number): { bodies: BodyDesc[]; cols: Column[] } {
  const bodies: BodyDesc[] = [], cols: Column[] = [], r = rng(seed);
  for (let k = 0; k < nudges; k++) for (const n of HEIGHTS) {
    const z = cols.length * TOWER_GAP, jit = k > 0;
    cols.push({ height: n, nudge: k, first: bodies.length });
    for (let j = 0; j < n; j++) {
      const d = (s: number) => (jit ? sym(r) * s : 0);
      bodies.push(box([d(1e-3), CELL / 2 + j * CELL, z + d(1e-3)], [CELL / 2, CELL / 2, CELL / 2], yaw(d((0.2 * Math.PI) / 180))));
    }
  }
  return { bodies, cols };
}

/**
 * The rocking-block estimate of the amplitude (g) that overturns a rigid column of n cubes shaken at f Hz:
 * alpha sqrt(1 + (omega / p)^2), alpha = b / h = 1 / n, p = sqrt(3 g / 4 R), R the half-diagonal (Housner 1963's
 * sine-pulse result, linearised for a slender block). A reference to read the probe against, not a pass rule.
 */
export function rockingA(n: number, f: number): number {
  const R = 0.5 * CELL * Math.hypot(n, 1), p = Math.sqrt((3 * GRAVITY) / (4 * R));
  return (1 / n) * Math.sqrt(1 + ((2 * Math.PI * f) / p) ** 2);
}

/**
 * The shaking envelope (in g) at time t after the shake starts, and the steps it takes to reach its cap. A case may
 * start higher and stop lower than A0 and A_MAX (`a0`, `aMax`): the CI case does, to fit a loaded runner.
 */
type Env = { f: number; growth: number; a0?: number; aMax?: number };
export const envelope = (c: Env, t: number) => Math.min(c.aMax ?? A_MAX, (c.a0 ?? A0) * c.growth ** (c.f * t));
export const shakeSteps = (c: Env) => Math.ceil(Math.log((c.aMax ?? A_MAX) / (c.a0 ?? A0)) / Math.log(c.growth) / c.f / DT);

/** The shove's two worlds: a floating grid (no gravity) or a standing building; the blast centre and its step. */
export function shoveWorld(c: Extract<X6Case, { kind: 'shove' }>): { bodies: BodyDesc[]; centre: Vec3; at: number } {
  const bodies: BodyDesc[] = [], h: Vec3 = [CELL / 2, CELL / 2, CELL / 2];
  if (c.design === 'floating') {
    for (let i = 0; i < 10; i++) for (let j = 0; j < 10; j++) for (let k = 0; k < 10; k++) bodies.push(box([i, 2 + j, k - 4.5], h));
    return { bodies, centre: [-c.dist, 6.5, 0], at: 1 };
  }
  for (let j = 0; j < 8; j++) for (let i = 0; i < 6; i++) for (let k = 0; k < 6; k++) bodies.push(box([(i - 2.5) * PITCH, CELL / 2 + j * CELL, (k - 2.5) * PITCH], h));
  return { bodies, centre: [-c.dist, 2, 0], at: c.presettle };
}

export function x6Spec(c: X6Case): RunSpec {
  if (c.kind === 'shake') {
    const { bodies } = columns(c.nudges, 6000 + Math.round(100 * c.f));
    // A second at full amplitude after the envelope tops out, for the last columns to finish falling.
    const steps = c.presettle + shakeSteps(c) + 60, base = quantiseVec3([0, -GRAVITY, 0]);
    const shake = scheduleEvents(c.presettle, steps, (i) => {
      const t = (i - c.presettle) * DT;
      return [envelope(c, t) * GRAVITY * Math.sin(2 * Math.PI * c.f * t), base[1], 0];
    }, base);
    const scene = gameScene(`X6-shake-${c.f}`, { ...c }, bodies, shake, { gravity: base });
    return { scene, steps, params: GAME_PARAMS, opts: { capacity: bodies.length, pairsPerBody: 16 } };
  }
  const { bodies, centre, at } = shoveWorld(c);
  const blast: InputEvent = { kind: 'blast', step: at, blast: { centre, radius: 3 * c.dist, impulse: 1e9, falloff: 0, core: 0.999, maxDv: SHOVE_DV, maxSpeed: 48 } };
  const scene = gameScene(`X6-shove-${c.design}`, { ...c }, bodies, [blast], c.design === 'floating' ? { gravity: [0, 0, 0] } : {});
  return { scene, steps: at + 2 + LATER, params: GAME_PARAMS, opts: { capacity: bodies.length, pairsPerBody: 24, boxBroadphase: true } };
}

export interface ColumnResult {
  height: number;
  nudge: number;
  /** Envelope (g) at the start of the fatal excursion; null: it never fell. */
  failA: number | null;
  /** Envelope (g) when the base cube had slid SLID m; null: it never slid. */
  slideA: number | null;
  /** Envelope (g) at the first rock past UPRIGHT (the top off its base by more than 5 cm); null: never. */
  rockA: number | null;
}
export interface ShoveResult {
  bodies: number;
  /** Over the bodies: the largest |measured kick - expected kick| / maxDv, and the mean of the kick along the expected direction / maxDv. */
  maxErr: number;
  meanAlong: number;
  /** The same, for the bodies above the bottom course (the standing building's bottom course drags on the ground). */
  maxErrAbove: number;
  /** The bottom course's mean kick along the direction / maxDv. */
  meanAlongBottom: number;
  /** LATER steps after the blast's: the spread (largest - smallest) of the bodies' velocity along the blast / maxDv, and its mean. */
  spreadLater: number;
  meanLater: number;
}
export type X6Result = { kind: 'shake'; f: number; columns: ColumnResult[]; endStep: number } | ({ kind: 'shove' } & ShoveResult);

function shakeMeter(c: Extract<X6Case, { kind: 'shake' }>, spec: RunSpec): Meter<X6Result> {
  const { cols } = columns(c.nudges, 6000 + Math.round(100 * c.f));
  const out: ColumnResult[] = cols.map((k) => ({ height: k.height, nudge: k.nudge, failA: null, slideA: null, rockA: null }));
  const lastUpright = cols.map(() => 0);
  let base: Snapshot | null = null, endStep = 0;
  const env = (step: number) => (step < c.presettle ? 0 : envelope(c, (step - c.presettle) * DT));
  return {
    every: 2,
    sample(step, s) {
      endStep = step;
      if (step < c.presettle) return;
      if (!base) base = { ...s, pos: s.pos.slice() };
      const b = base;
      let open = 0;
      cols.forEach((k, ci) => {
        const o = out[ci]!;
        if (o.failA !== null) return;
        open++;
        const i0 = k.first, top = k.first + k.height - 1, A = env(step);
        const off = Math.hypot(s.pos[3 * top]! - s.pos[3 * i0]!, s.pos[3 * top + 2]! - s.pos[3 * i0 + 2]!);
        if (off < UPRIGHT) lastUpright[ci] = step;
        else o.rockA ??= A;
        if (o.slideA === null && Math.hypot(s.pos[3 * i0]! - b.pos[3 * i0]!, s.pos[3 * i0 + 2]! - b.pos[3 * i0 + 2]!) > SLID) o.slideA = A;
        for (let i = i0; i <= top; i++) if (b.pos[3 * i + 1]! - s.pos[3 * i + 1]! > FELL) { o.failA = env(lastUpright[ci]!); break; }
      });
      return open === 0 ? 'stop' : undefined;
    },
    result: () => ({ kind: 'shake', f: c.f, columns: out, endStep }),
  };
}

function shoveMeter(c: Extract<X6Case, { kind: 'shove' }>, spec: RunSpec): Meter<X6Result> {
  const { centre, at } = shoveWorld(c), n = spec.scene.bodies.length;
  let before: Snapshot | null = null, res: ShoveResult = { bodies: n, maxErr: NaN, meanAlong: NaN, maxErrAbove: NaN, meanAlongBottom: NaN, spreadLater: NaN, meanLater: NaN };
  return {
    every: 1,
    sample(step, s) {
      // The blast is due at step `at`: it acts in the step from `at` to `at + 1`.
      if (step === at) before = { ...s, pos: s.pos.slice(), linVel: s.linVel.slice() };
      if (!before) return;
      if (step === at + 1 + LATER) {
        let lo = Infinity, hi = -Infinity, sum = 0;
        for (let i = 0; i < n; i++) {
          const d = [0, 1, 2].map((a) => before!.pos[3 * i + a]! - centre[a]!), len = Math.hypot(d[0]!, d[1]!, d[2]!);
          const v = (d[0]! * s.linVel[3 * i]! + d[1]! * s.linVel[3 * i + 1]! + d[2]! * s.linVel[3 * i + 2]!) / len / SHOVE_DV;
          lo = Math.min(lo, v); hi = Math.max(hi, v); sum += v;
        }
        res = { ...res, spreadLater: hi - lo, meanLater: sum / n };
        return 'stop';
      }
      if (step !== at + 1) return;
      let maxErr = 0, maxErrAbove = 0, along = 0, bottom = 0, nb = 0;
      for (let i = 0; i < n; i++) {
        const p = [before.pos[3 * i]!, before.pos[3 * i + 1]!, before.pos[3 * i + 2]!], d = [p[0]! - centre[0], p[1]! - centre[1], p[2]! - centre[2]];
        const len = Math.hypot(d[0]!, d[1]!, d[2]!), dir = d.map((x) => x / len);
        const dv = [0, 1, 2].map((a) => s.linVel[3 * i + a]! - before!.linVel[3 * i + a]!);
        // Gravity's own change over the step (the floating grid has none; a resting body's is cancelled by its support).
        const err = Math.hypot(...[0, 1, 2].map((a) => dv[a]! - SHOVE_DV * dir[a]!)) / SHOVE_DV, al = (dv[0]! * dir[0]! + dv[1]! * dir[1]! + dv[2]! * dir[2]!) / SHOVE_DV;
        maxErr = Math.max(maxErr, err);
        along += al;
        if (p[1]! < CELL) { bottom += al; nb++; } else maxErrAbove = Math.max(maxErrAbove, err);
      }
      res = { ...res, bodies: n, maxErr, meanAlong: along / n, maxErrAbove, meanAlongBottom: nb ? bottom / nb : NaN };
    },
    result: () => ({ kind: 'shove', ...res }),
  };
}

const FREQS: Record<Size, number[]> = { ci: [1], full: [0.5, 0.75, 1, 1.5, 2, 3, 4] };

function x6Cases(size: Size): X6Case[] {
  const full = size === 'full', presettle = full ? 300 : 60, out: X6Case[] = [];
  // CI: one frequency, 20% a cycle from 0.1 g (above a 20-cube column's static tipping load, 0.05 g) to 0.7 g
  // (above where every height fell at 15% from 0.02 g); 640 shaking steps, not 1680, to fit a loaded runner.
  for (const f of FREQS[size]) out.push(full ? { kind: 'shake', f, growth: 1.05, nudges: 8, presettle } : { kind: 'shake', f, growth: 1.2, nudges: 1, presettle, a0: 0.1, aMax: 0.7 });
  for (const dist of full ? [100, 1000] : [1000]) for (const design of ['floating', 'standing'] as const) out.push({ kind: 'shove', design, dist, presettle });
  return out;
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const fmt = (x: number | null) => (x === null ? '-' : x.toFixed(3));

/** Median over nudges of the failure amplitude, Infinity when at least half the nudges never fell. */
export function failAmplitude(cs: ColumnResult[]): number {
  return median(cs.map((c) => c.failA ?? Infinity));
}

function x6Verdict(runs: CaseRun<X6Case, X6Result>[], size: Size): Verdict {
  const table: string[] = [], checks: Check[] = [];
  const shakes = runs.filter((r) => r.result.kind === 'shake') as CaseRun<X6Case, Extract<X6Result, { kind: 'shake' }>>[];
  const shoves = runs.filter((r) => r.result.kind === 'shove') as CaseRun<Extract<X6Case, { kind: 'shove' }>, Extract<X6Result, { kind: 'shove' }>>[];
  // Shake table: one row per frequency, per height the median failure amplitude (g) and how many slid first.
  table.push(`| f Hz | ${HEIGHTS.map((n) => `${n} cubes: fail A (g), slid, rocked first at, rocking estimate`).join(' | ')} |`, `|---|${HEIGHTS.map(() => '---|').join('')}`);
  const curve = new Map<number, Array<{ f: number; A: number }>>(HEIGHTS.map((n) => [n, []]));
  for (const r of shakes) {
    const cells = HEIGHTS.map((n) => {
      const cs = r.result.columns.filter((c) => c.height === n), A = failAmplitude(cs);
      curve.get(n)!.push({ f: r.result.f, A });
      const slid = cs.filter((c) => c.slideA !== null && (c.failA === null || c.slideA <= c.failA)).length;
      const rock = median(cs.map((c) => c.rockA ?? Infinity));
      return `${Number.isFinite(A) ? A.toFixed(3) : `> ${(r.c as Env).aMax ?? A_MAX}`}, ${slid}/${cs.length}, ${fmt(Number.isFinite(rock) ? rock : null)}, ${rockingA(n, r.result.f).toFixed(2)}`;
    });
    table.push(`| ${r.result.f} | ${cells.join(' | ')} |`);
  }
  // The most destructive frequency per height: where the failure amplitude is least (ties to the lower f).
  const worst = new Map(HEIGHTS.map((n) => {
    const pts = curve.get(n)!.filter((p) => Number.isFinite(p.A));
    return [n, pts.length ? pts.reduce((a, b) => (b.A < a.A ? b : a)).f : NaN] as const;
  }));
  const fs = HEIGHTS.map((n) => worst.get(n)!);
  const monotone = fs.every(Number.isFinite) && fs[0]! >= fs[1]! && fs[1]! >= fs[2]! && fs[0]! > fs[2]!;
  checks.push({ name: 'resonance: the most destructive frequency falls with height (5 cubes > 20 cubes, never rising)', pass: monotone, detail: HEIGHTS.map((n, i) => `${n} cubes ${Number.isFinite(fs[i]!) ? `${fs[i]} Hz` : 'never fell'}`).join(', ') });
  // Reported, not the rule: at every frequency a taller column needs no more shaking to fall ("tall falls first").
  const tallFirst = shakes.every((r) => {
    const A = HEIGHTS.map((n) => failAmplitude(r.result.columns.filter((c) => c.height === n)));
    return A[0]! >= A[1]! && A[1]! >= A[2]!;
  });
  checks.push({ name: '(reported) at every frequency the taller column fails at no larger amplitude', pass: tallFirst, detail: tallFirst ? 'yes' : 'see table' });
  table.push('', `Static tipping thresholds g/n: ${HEIGHTS.map((n) => `${n} cubes ${(1 / n).toFixed(3)} g`).join(', ')}; slide threshold ${PLASTER.friction} g.`);
  table.push('', `| shove | bodies | largest kick error / maxDv | mean kick along / maxDv | bottom course: mean along | above it: largest error | ${LATER} steps on: mean along, spread |`, '|---|---|---|---|---|---|---|');
  for (const r of shoves) {
    const s = r.result, pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toFixed(2)}%` : '-');
    table.push(`| ${r.c.design} at ${r.c.dist} m | ${s.bodies} | ${pct(s.maxErr)} | ${s.meanAlong.toFixed(4)} | ${Number.isFinite(s.meanAlongBottom) ? s.meanAlongBottom.toFixed(4) : '-'} | ${pct(s.maxErrAbove)} | ${s.meanLater.toFixed(4)}, ${pct(s.spreadLater)} |`);
    if (r.c.design === 'floating') {
      checks.push({ name: `shove at ${r.c.dist} m: every body gets maxDv along the blast's direction within 1% (the kick, on ${s.bodies} free cubes)`, pass: s.maxErr <= 0.01, detail: `largest error ${pct(s.maxErr)} of maxDv` });
    } else {
      // Reported: on a standing building the blast's step also solves the contacts. Coulomb's answer for a stack that sticks
      // together is a uniform loss of mu g dt (the ground's friction under the whole weight), the same for every body.
      const coulomb = 1 - (PLASTER.friction * GRAVITY * DT) / SHOVE_DV;
      checks.push({ name: `(reported) shove at ${r.c.dist} m on a standing building: every body within 1% of the kick less Coulomb's ground friction (${coulomb.toFixed(4)})`, pass: s.maxErr - (1 - coulomb) <= 0.01, detail: `mean ${s.meanAlong.toFixed(4)}, bottom course ${s.meanAlongBottom.toFixed(4)}, largest error ${pct(s.maxErr)}; ${LATER} steps on spread ${pct(s.spreadLater)}` });
    }
  }
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  const shoveOk = checks.filter((c) => c.name.startsWith('shove at')).every((c) => c.pass);
  return { pass: size === 'full' ? monotone && shoveOk && runs.every((r) => r.limits.length === 0) : null, checks, table };
}

export const X6: Probe<X6Case, X6Result> = {
  id: 'X6',
  title: 'Resonance under a gravity schedule; far-blast shove',
  question: 'Do friction stacks show resonance under a shaking gravity, and does a far blast give every body the same kick?',
  rule: 'The most destructive shaking frequency (least failure amplitude) falls monotonically with column height, 5 to 10 to 20 cubes; every body in a far flat-core blast gets maxDv within 1% (here: the kick, on free cubes; a standing building\'s response is reported).',
  cases: x6Cases,
  label: (c) => (c.kind === 'shake' ? `shake ${c.f} Hz` : `shove ${c.design} at ${c.dist} m`),
  spec: x6Spec,
  meter: (c, spec) => (c.kind === 'shake' ? shakeMeter(c, spec) : shoveMeter(c, spec)),
  verdict: x6Verdict,
};

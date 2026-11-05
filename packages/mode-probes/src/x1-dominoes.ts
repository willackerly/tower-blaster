// X1: do domino runs propagate on AVBD at game settings, and does sleep leave
// them alone? (modes-roadmap.md section 7; gates M6 Wavefront, M16 Picture
// Fields and C22.)
//
// Dominoes are 1 m x 0.5 m x 0.15 m plaster (h = 1 m; 18.75 kg), 0.6 h apart
// along their path, standing on the game's ground. Runs:
//   line    a straight run of n dominoes;
//   curve   8 straight, a half turn of radius r h, 8 straight;
//   field   a brick-offset field (rows 0.6 h apart, columns 0.75 h, odd rows
//           shifted half a column, so each domino falls onto two);
//   cocked  one domino leaning at a fixed angle against a stone block, held
//           by friction: a sculpture that must stay asleep and still.
// Each run waits PUSH_STEP steps (sleepers fall asleep), then a 0.1 m ball
// (2,000 kg/m^3, about 1 m/s, 0.8 m up) is spawned just behind the first
// domino (a field: one per first-row domino). A nudge jitters the push (speed
// +-10 %, height +-5 cm, sideways +-3 cm) and every domino's placement (+-2 mm,
// +-0.5 deg of yaw), from its own seed: what a player and an author can't
// control.
//
// A domino has fallen once its tilt passes FALLEN_DEG. The front is the
// furthest fallen domino's path position; its speed is fitted over the middle
// of the run and compared with sqrt(g h). With sleep on, once the run is over
// (everything fallen, or nothing new for STALL_STEPS) and TAIL_STEPS more
// have passed, a blast of no impulse wakes everything: a domino sleep had
// frozen mid-fall then falls on, so the largest tilt change over the next
// UNFREEZE_STEPS of the dominoes that were asleep says whether sleep only
// ever froze bodies at rest.
import type { BodyDesc, InputEvent, Snapshot, Vec3 } from '@tb/engine-api';
import { ball, box, DT, GAME_PARAMS, gameScene, GRAVITY, rng, slope, STONE, sym, tiltDeg, yaw } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const DOMINO = { h: 1, w: 0.5, t: 0.15 } as const;
const HALF: Vec3 = [DOMINO.w / 2, DOMINO.h / 2, DOMINO.t / 2];
/** Centre-to-centre spacing along the path, as a fraction of h. */
export const SPACING = 0.6;
/** Field columns, centre to centre (a 0.25 m gap between neighbours in a row). */
export const FIELD_COL = 0.75;
export const FALLEN_DEG = 15;
export const PUSH_STEP = 90;
/** A run with nothing new fallen for this long is over (stalled). */
export const STALL_STEPS = 180;
export const TAIL_STEPS = 180;
export const UNFREEZE_STEPS = 120;
const SAMPLE = 5;
/** sqrt(g h): the wave speed's natural unit. */
export const WAVE_UNIT = Math.sqrt(GRAVITY * DOMINO.h);

export type X1Case =
  | { kind: 'line'; n: number; nudge: number; sleep: boolean }
  | { kind: 'curve'; r: number; lead: number; nudge: number; sleep: boolean }
  | { kind: 'field'; rows: number; cols: number; nudge: number; sleep: boolean }
  | { kind: 'cocked'; deg: number; steps: number; sleep: boolean };

export interface PathPoint { x: number; z: number; heading: number; s: number }

/** Points every SPACING h along a straight run of n dominoes heading +z. */
export function linePath(n: number): PathPoint[] {
  return Array.from({ length: n }, (_, i) => ({ x: 0, z: i * SPACING, heading: 0, s: i * SPACING }));
}

/** `lead` straight, a right half turn of radius r about (r, lead s), `lead` straight back, every SPACING along the centre line. */
export function curvePath(r: number, lead: number): PathPoint[] {
  const L1 = (lead - 1) * SPACING, arc = Math.PI * r, total = 2 * L1 + arc, out: PathPoint[] = [];
  for (let k = 0; k * SPACING <= total + 1e-9; k++) {
    const s = k * SPACING;
    if (s <= L1) out.push({ x: 0, z: s, heading: 0, s });
    else if (s <= L1 + arc) { const f = (s - L1) / r; out.push({ x: r - r * Math.cos(f), z: L1 + r * Math.sin(f), heading: f, s }); }
    else out.push({ x: 2 * r, z: L1 - (s - L1 - arc), heading: Math.PI, s });
  }
  return out;
}

/** The brick-offset field, row by row; s is the row's distance from the first. */
export function fieldPath(rows: number, cols: number): PathPoint[] {
  const out: PathPoint[] = [];
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++)
    out.push({ x: (col - (cols - 1) / 2 + (row % 2 ? 0.5 : 0)) * FIELD_COL, z: row * SPACING, heading: 0, s: row * SPACING });
  return out;
}

const headingVec = (a: number): Vec3 => [Math.sin(a), 0, Math.cos(a)];

/** A domino standing at p, 1e-6 m clear of the ground; jittered from r when given. */
function domino(p: PathPoint, r?: () => number): BodyDesc {
  const a = p.heading + (r ? (sym(r) * 0.5 * Math.PI) / 180 : 0);
  const d = headingVec(p.heading), side: Vec3 = [d[2], 0, -d[0]];
  const da = r ? sym(r) * 0.002 : 0, ds = r ? sym(r) * 0.002 : 0;
  return box([p.x + da * d[0] + ds * side[0], DOMINO.h / 2 + 1e-6, p.z + da * d[2] + ds * side[2]], HALF, yaw(a));
}

/** The pushing ball for the domino at p (the first of a run). */
function pusher(p: PathPoint, r: () => number, jitter: boolean): BodyDesc {
  const d = headingVec(p.heading), side: Vec3 = [d[2], 0, -d[0]], radius = 0.1;
  const j = jitter ? { v: 1 + 0.1 * sym(r), y: 0.05 * sym(r), s: 0.03 * sym(r) } : { v: 1, y: 0, s: 0 };
  const back = DOMINO.t / 2 + radius + 0.02;
  return ball([p.x - back * d[0] + j.s * side[0], 0.8 + j.y, p.z - back * d[2] + j.s * side[2]], radius, [j.v * d[0], 0, j.v * d[2]], { density: 2000 });
}

export function pathOf(c: Exclude<X1Case, { kind: 'cocked' }>): PathPoint[] {
  return c.kind === 'line' ? linePath(c.n) : c.kind === 'curve' ? curvePath(c.r, c.lead) : fieldPath(c.rows, c.cols);
}

/** The engine options a case runs with: the game's pair room is every pair of a small level; probes use a generous fixed room. */
function optsOf(sleep: boolean, n: number) {
  return { sleep, capacity: n, pairsPerBody: 24, boxBroadphase: true } as const;
}

export function x1Spec(c: X1Case): RunSpec {
  if (c.kind === 'cocked') {
    const a = (c.deg * Math.PI) / 180, { h, t } = DOMINO;
    // Tilted about +x by a (top toward +z), its front bottom edge on the ground and its top front edge on the block.
    const cy = (h / 2) * Math.cos(a) + (t / 2) * Math.sin(a) + 1e-6, top = (h / 2) * Math.sin(a) + (t / 2) * Math.cos(a);
    const d = box([0, cy, 0], HALF, [Math.sin(a / 2), 0, 0, Math.cos(a / 2)]);
    const block = box([0, 0.75 + 1e-6, top + 1e-6 + 0.5], [0.5, 0.75, 0.5], undefined, { density: STONE.density, friction: STONE.friction });
    const scene = gameScene('X1-cocked', { deg: c.deg }, [d, block]);
    return { scene, steps: c.steps, params: GAME_PARAMS, opts: optsOf(c.sleep, 2) };
  }
  const path = pathOf(c), r = rng(1000 + c.nudge), jitter = c.nudge > 0;
  const bodies = path.map((p) => domino(p, jitter ? r : undefined));
  const firsts = c.kind === 'field' ? path.slice(0, c.cols) : [path[0]!];
  const inputs: InputEvent[] = firsts.map((p) => ({ step: PUSH_STEP, kind: 'spawn', body: pusher(p, r, jitter) }));
  const scene = gameScene(`X1-${c.kind}`, { ...c }, bodies, inputs);
  const len = path.at(-1)!.s;
  // Room for the wave to cross at a third of sqrt(g h), then the tail and the unfreeze.
  const steps = PUSH_STEP + Math.ceil(len / (WAVE_UNIT / 3) / DT) + STALL_STEPS + TAIL_STEPS + UNFREEZE_STEPS;
  return { scene, steps, params: GAME_PARAMS, opts: optsOf(c.sleep, bodies.length + inputs.length) };
}

export interface RunResult {
  kind: 'line' | 'curve' | 'field';
  n: number;
  fallen: number;
  /** The last domino of the path fell (a line or curve). */
  end: boolean;
  /** Front speed fitted over the middle of the run, m/s; NaN if too little fell. */
  speed: number;
  /** The step the last new domino fell at (from the push). */
  lastFallStep: number;
  stalled: boolean;
  /** Most dominoes awake in one sample after the push, and the mean while the front moved. */
  awakeMax: number;
  awakeMean: number;
  /** Most standing dominoes awake more than two pitches ahead of the front in one sample after the first fall. */
  aheadAwakeMax: number;
  /** With sleep: dominoes asleep when everything was woken, those of them leaning 5-80 deg, and the largest tilt change of one of them after. */
  asleepAtWake: number;
  leaningAsleep: number;
  unfreezeMaxDeg: number;
}

export interface CockedResult { kind: 'cocked'; deg: number; tilt0: number; tiltEnd: number; drift: number; asleepFrom: number | null; asleepAtEnd: boolean; steps: number }
export type X1Result = RunResult | CockedResult;

function runMeter(c: Exclude<X1Case, { kind: 'cocked' }>): Meter<RunResult> {
  const path = pathOf(c), n = path.length, pitch = SPACING;
  const fallenAt = new Array<number>(n).fill(-1);
  let lastNew = PUSH_STEP, phase: 'run' | 'tail' | 'unfreeze' = 'run', phaseAt = 0;
  let awakeMax = 0, awakeSum = 0, awakeN = 0, aheadMax = 0, frontS = -Infinity;
  let wake: { asleep: number[]; tilt: number[] } | null = null, unfreezeMax = 0, leaning = 0;
  const allFallen = () => fallenAt.every((s) => s >= 0);
  return {
    every: SAMPLE,
    sample(step: number, s: Snapshot) {
      let awake = 0;
      for (let i = 0; i < n; i++) {
        const t = tiltDeg(s.rot, i);
        if (fallenAt[i]! < 0 && t > FALLEN_DEG) { fallenAt[i] = step; lastNew = step; frontS = Math.max(frontS, path[i]!.s); }
        if (s.awake[i]) awake++;
      }
      if (step >= PUSH_STEP && phase === 'run') {
        awakeMax = Math.max(awakeMax, awake); awakeSum += awake; awakeN++;
        if (frontS > -Infinity) {
          let ahead = 0;
          for (let i = 0; i < n; i++) if (fallenAt[i]! < 0 && s.awake[i] && path[i]!.s > frontS + 2 * pitch) ahead++;
          aheadMax = Math.max(aheadMax, ahead);
        }
      }
      if (phase === 'run' && step > PUSH_STEP && (allFallen() || step - lastNew >= STALL_STEPS)) { phase = 'tail'; phaseAt = step; }
      if (phase === 'tail' && step - phaseAt >= TAIL_STEPS) {
        if (!c.sleep) return 'stop';
        const asleep: number[] = [], tilt: number[] = [];
        for (let i = 0; i < n; i++) if (!s.awake[i]) { asleep.push(i); const t = tiltDeg(s.rot, i); tilt.push(t); if (t > 5 && t < 80) leaning++; }
        wake = { asleep, tilt };
        phase = 'unfreeze'; phaseAt = step;
        return [{ step, kind: 'blast', blast: { centre: [0, 0, 0], radius: 1e6, impulse: 0, maxSpeed: Infinity } }];
      }
      if (phase === 'unfreeze' && wake) {
        wake.asleep.forEach((i, k) => { unfreezeMax = Math.max(unfreezeMax, Math.abs(tiltDeg(s.rot, i) - wake!.tilt[k]!)); });
        if (step - phaseAt >= UNFREEZE_STEPS) return 'stop';
      }
    },
    result(): RunResult {
      const fallen = fallenAt.filter((x) => x >= 0).length, maxS = path.at(-1)!.s;
      // The front's speed: fall time against path position, over the middle 60 % of the path that fell.
      const xs: number[] = [], ys: number[] = [];
      for (let i = 0; i < n; i++) if (fallenAt[i]! >= 0 && path[i]!.s >= 0.2 * frontS && path[i]!.s <= 0.8 * frontS) { xs.push(fallenAt[i]! * DT); ys.push(path[i]!.s); }
      return {
        kind: c.kind, n, fallen, end: c.kind === 'field' ? fallen === n : fallenAt[n - 1]! >= 0, speed: frontS >= 0.5 * maxS ? slope(xs, ys) : NaN,
        lastFallStep: lastNew - PUSH_STEP, stalled: !allFallen(),
        awakeMax, awakeMean: awakeN ? awakeSum / awakeN : 0, aheadAwakeMax: aheadMax,
        asleepAtWake: wake?.asleep.length ?? 0, leaningAsleep: leaning, unfreezeMaxDeg: unfreezeMax,
      };
    },
  };
}

function cockedMeter(c: Extract<X1Case, { kind: 'cocked' }>): Meter<CockedResult> {
  // The domino's tilt once its contacts have loaded (step SETTLED) is the pose it must hold.
  const SETTLED = 120;
  let tilt0 = NaN, tiltEnd = NaN, asleepFrom: number | null = null, maxDev = 0, last = 0, asleepAtEnd = false;
  return {
    every: 10,
    sample(step, s) {
      const t = tiltDeg(s.rot, 0);
      if (step === SETTLED) tilt0 = t;
      if (step >= SETTLED) maxDev = Math.max(maxDev, Math.abs(t - tilt0));
      if (!s.awake[0]) { if (asleepFrom === null) asleepFrom = step; } else asleepFrom = null;
      tiltEnd = t; last = step; asleepAtEnd = !s.awake[0];
    },
    result: () => ({ kind: 'cocked', deg: c.deg, tilt0, tiltEnd, drift: maxDev, asleepFrom, asleepAtEnd, steps: last }),
  };
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '-');
const pct = (k: number, n: number) => `${k}/${n} (${n ? ((100 * k) / n).toFixed(0) : 0}%)`;

function x1Cases(size: Size): X1Case[] {
  // CI: one short line each way, a small field and a cocked domino (about 2 min on SwiftShader); full: the roadmap's setup.
  if (size === 'ci') return [
    { kind: 'line', n: 10, nudge: 1, sleep: false },
    { kind: 'line', n: 10, nudge: 2, sleep: true },
    { kind: 'field', rows: 4, cols: 4, nudge: 1, sleep: true },
    { kind: 'cocked', deg: 20, steps: 420, sleep: true },
  ];
  const out: X1Case[] = [];
  for (const sleep of [false, true]) {
    for (let nudge = 0; nudge < 32; nudge++) {
      out.push({ kind: 'line', n: 200, nudge, sleep });
      for (const r of [3, 5, 8]) out.push({ kind: 'curve', r, lead: 8, nudge, sleep });
    }
    for (let nudge = 0; nudge < 4; nudge++) out.push({ kind: 'field', rows: 100, cols: 100, nudge, sleep });
    for (const deg of [20, 40]) out.push({ kind: 'cocked', deg, steps: 4200, sleep });
  }
  return out;
}

const groupOf = (c: X1Case) => (c.kind === 'line' ? `line ${c.n}` : c.kind === 'curve' ? `curve r ${c.r} h` : c.kind === 'field' ? `field ${c.rows}x${c.cols}` : `cocked ${c.deg} deg`);

function x1Verdict(runs: CaseRun<X1Case, X1Result>[], size: Size): Verdict {
  const checks: Check[] = [], table = ['| run | sleep | runs | reached the end | fallen (mean) | front speed m/s (x sqrt(g h)) | awake max / mean | ahead awake | asleep at wake, leaning | unfreeze max deg | limits |', '|---|---|---|---|---|---|---|---|---|---|---|'];
  const groups = new Map<string, CaseRun<X1Case, X1Result>[]>();
  for (const r of runs) { const k = `${groupOf(r.c)}|${'sleep' in r.c && r.c.sleep ? 'on' : 'off'}`; groups.set(k, [...(groups.get(k) ?? []), r]); }
  for (const [k, rs] of groups) {
    const [name, sleep] = k.split('|') as [string, string];
    const c0 = rs[0]!.c, limits = rs.flatMap((r) => r.limits);
    if (c0.kind === 'cocked') {
      const res = rs.map((r) => r.result as CockedResult);
      for (const x of res) {
        const held = x.asleepFrom === null ? 0 : (x.steps - x.asleepFrom) * DT;
        table.push(`| ${name} | ${sleep} | 1 | - | - | - | - | - | ${x.asleepAtEnd ? `asleep ${held.toFixed(0)} s (from ${(x.asleepFrom! * DT).toFixed(1)} s)` : 'awake at end'} | drift ${fmt(x.drift, 3)} (tilt ${fmt(x.tilt0)}) | ${limits.length} |`);
        if (sleep === 'on') {
          const need = size === 'full' ? 60 : (x.steps - 300) * DT;
          checks.push({ name: `${name}: asleep and still to the end`, pass: x.asleepAtEnd && held >= need && x.drift < 0.1, detail: `asleep ${held.toFixed(1)} s (need ${need.toFixed(0)}), drift ${fmt(x.drift, 3)} deg (need < 0.1)` });
        }
      }
      continue;
    }
    const res = rs.map((r) => r.result as RunResult), ends = res.filter((x) => x.end).length;
    const sp = res.map((x) => x.speed).filter(Number.isFinite), meanSp = sp.length ? sp.reduce((a, b) => a + b, 0) / sp.length : NaN;
    const meanFallen = res.reduce((a, x) => a + x.fallen / x.n, 0) / res.length;
    table.push(`| ${name} | ${sleep} | ${rs.length} | ${pct(ends, rs.length)} | ${(100 * meanFallen).toFixed(1)}% of ${res[0]!.n} | ${fmt(meanSp)} (${fmt(meanSp / WAVE_UNIT)}) | ${Math.max(...res.map((x) => x.awakeMax))} / ${fmt(res.reduce((a, x) => a + x.awakeMean, 0) / res.length, 1)} | ${Math.max(...res.map((x) => x.aheadAwakeMax))} | ${sleep === 'on' ? `${Math.max(...res.map((x) => x.asleepAtWake))}, ${Math.max(...res.map((x) => x.leaningAsleep))}` : '-'} | ${sleep === 'on' ? fmt(Math.max(...res.map((x) => x.unfreezeMaxDeg)), 3) : '-'} | ${limits.length} |`);
    if (c0.kind === 'field') checks.push({ name: `${name}, sleep ${sleep}: the front reaches 95% of dominoes in every run`, pass: res.every((x) => x.fallen >= 0.95 * x.n), detail: res.map((x) => `${x.fallen}/${x.n}`).join(', ') });
    else if (c0.kind === 'line' || c0.r >= 5) checks.push({ name: `${name}, sleep ${sleep}: reaches the end in 98% of nudges`, pass: ends >= 0.98 * rs.length, detail: pct(ends, rs.length) });
    if (sleep === 'on') checks.push({ name: `${name}: no domino frozen mid-fall (tilt change after waking all < 1 deg)`, pass: res.every((x) => x.unfreezeMaxDeg < 1), detail: `max ${fmt(Math.max(...res.map((x) => x.unfreezeMaxDeg)), 3)} deg` });
    checks.push({ name: `${name}, sleep ${sleep}: no engine limit hit`, pass: limits.length === 0, detail: limits[0] ?? 'none' });
  }
  return { pass: size === 'full' ? checks.every((x) => x.pass) : null, checks, table };
}

export const X1: Probe<X1Case, X1Result> = {
  id: 'X1',
  title: 'Domino propagation and sleep',
  question: 'Do domino runs propagate on AVBD at game settings, and does sleep leave them alone?',
  rule: 'Line and curves of radius 5 h or more reach the end in at least 98% of 32 nudges; the field front reaches 95% of dominoes; no domino asleep mid-fall; a cocked (leaning, held) domino stays asleep for 60 s; awake count at the front logged.',
  cases: x1Cases,
  label: (c) => `${groupOf(c)}${'nudge' in c ? ` nudge ${c.nudge}` : ''}${c.sleep ? ' sleep' : ''}`,
  spec: x1Spec,
  meter: (c) => (c.kind === 'cocked' ? cockedMeter(c) : runMeter(c)) as Meter<X1Result>,
  verdict: x1Verdict,
};

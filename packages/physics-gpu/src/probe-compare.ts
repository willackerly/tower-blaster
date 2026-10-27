// The fused dual's kill rules (perf-competition r2-dualfusion report), applied
// to measured results so the M5 sweep decides by rule, not by reading:
// - P2, fused against off (two bench:probe JSON files at the same I): the
//   per-point cost (t_c - empty dispatch) / W_c may rise by at most 5%
//   (contactpar judge-gpu, item 1), taken as the median over the direct
//   colours at each checkpoint, and the tail's t / W_crit by at most 5% too;
//   the solve pass must fall by at least I x 60 us.
// - bench:browser A/B records (base first, variant second) on S4, city awake,
//   with the variant fused and the base not: the step must be at least
//   I x 60 us faster (0.6 ms at I = 10, 1.2 ms at I = 20: persistent
//   judge-physics item 2, and contactpar judge-gpu's pass bar).
// Only the side-array arm (dualFusion without solveContactsRW) decides the
// merge, and only on S4 in the judged windows, steps 60-240 and 300-480 (P2:
// a checkpoint in one). Everything else is reported, never a kill: the
// in-place arm (it decides only which storage ships), the binding-only A/B,
// the steps 0-150 run, other scenes (S5, S1), combinations with the other
// opt-in variants (records, colorMode, colorPriority) on either side, and an
// A/B record whose timing bench:browser found not valid. For the other
// variants' own rules (their PRs, applied by reading) P2 also gives one
// sweep's colour time off against on, and the A/B table the saving in percent
// of the base's step, each engine's block spread, and the median saving of a
// cell timed more than once.
// Times in the P2 JSON are ms; reported here in µs.
import { type AvbdParams, DEFAULT_AVBD } from '@tb/physics-ref';
import type { Checkpoint, P2Result } from './probe.ts';

export const MAX_PER_POINT_RISE = 0.05;
/** The kill threshold on the saving per step, in µs per iteration. */
export const KILL_US_PER_ITERATION = 60;
export const killMs = (iterations: number) => (iterations * KILL_US_PER_ITERATION) / 1000;
/** The step windows the rules judge, first and last step: the city awake, after the settle (steps 0-150 are reported only). */
export const JUDGED_WINDOWS: ReadonlyArray<readonly [number, number]> = [[60, 240], [300, 480]];

type Options = { dualFusion?: unknown; solveContactsRW?: unknown; records?: unknown; colorMode?: unknown; colorPriority?: unknown };
/** The other opt-in variants a run has on: the rules judge the fused dual alone against the default. */
const others = (v: Options | undefined) => (['records', 'colorMode', 'colorPriority'] as const).filter((k) => v?.[k] !== undefined && v[k] !== 0);
/** The base the rules compare against: neither the fused dual nor the read_write contacts binding. */
const isBase = (v: Options | undefined) => v?.dualFusion !== true && v?.solveContactsRW !== true;
/** The arm the rules judge: the fused dual in its side array. */
const isSideArm = (v: Options | undefined) => v?.dualFusion === true && v?.solveContactsRW !== true;
/** Why a base/arm pair on a scene is reported rather than judged, or null if the rules judge it. */
function reportedOnly(scene: string | undefined, base: Options | undefined, arm: Options | undefined): string | null {
  if (scene !== 'S4') return `${scene ?? 'unknown scene'}: the rules judge S4 only`;
  const combined = [...new Set([...others(base), ...others(arm)])];
  if (combined.length) return `with ${combined.join(', ')} on: the rules judge the fused dual alone against the default`;
  if (!isBase(base)) return 'the base is not the default (unfused, read-only contacts)';
  if (arm?.dualFusion !== true) return 'the variant does not fuse the dual (as in the binding-only A/B)';
  if (!isSideArm(arm)) return 'the in-place arm (solveContactsRW) decides only which storage ships';
  return null;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b), m = s.length >> 1;
  return s.length === 0 ? NaN : s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export interface CheckpointCompare {
  step: number;
  /** The structure of both runs (K, ΣW, points): the physics must be the same for the times to compare. */
  structure: { off: { K: number; sumW: number; points: number }; on: { K: number; sumW: number; points: number }; same: boolean };
  /** Per direct colour present in both: (t_c - empty) / W_c in ns, off and on, and on / off. */
  colours: Array<{ colour: number; W: number; offNs: number; onNs: number; ratio: number }>;
  medianRatio: number;
  tail: { offNs: number; onNs: number; ratio: number } | null;
  /** Solve pass of the steps up to the checkpoint, ms, and off - on. */
  solvePass: { off: number; on: number; savingMs: number } | null;
  /**
   * One sweep's colour time in ms, off, on and on / off: the direct colours (sum of t_c) and with the tail.
   * Reported for the colorMode and records lines (their PRs: sweep at most 0.55x, primal at least 30% shorter).
   */
  sweep: { direct: SweepRatio; withTail: SweepRatio } | null;
  dual: { off: number | null; on: number | null };
  /** The rules this checkpoint fails; kills only when judged. */
  fails: string[];
  /** Whether the step lies in a judged window (JUDGED_WINDOWS). */
  judged: boolean;
}
export interface P2Compare {
  iterations: number; offEngine: string; onEngine: string; checkpoints: CheckpointCompare[]; killMs: number;
  /** Why the pair is reported rather than judged (reportedOnly), or null. */
  reported: string | null;
  /** The failures that kill: those of judged checkpoints, when the pair is judged. */
  kill: string[];
}

type SweepRatio = { off: number; on: number; ratio: number };
/** A checkpoint's direct colours summed, and with the tail, in ms; null if a colour or the tail was not timed. */
const sweepOf = (c: Checkpoint) => {
  if (!c.tail.t || c.direct.some((d) => !d.t)) return null;
  const direct = c.direct.reduce((s, d) => s + d.t!.median, 0);
  return { direct, withTail: direct + c.tail.t.median };
};

const perPoint = (c: Checkpoint) => {
  const e = c.emptyDispatch?.median;
  const out = new Map<number, { W: number; ns: number }>();
  if (e === undefined) return out;
  for (const d of c.direct) if (d.t && d.W > 0 && d.bodies > 0) out.set(d.colour, { W: d.W, ns: ((d.t.median - e) * 1e6) / d.W });
  return out;
};

export function compareP2(off: P2Result, on: P2Result): P2Compare {
  if (off.iterations !== on.iterations) throw new Error(`probe-compare: the runs are at ${off.iterations} and ${on.iterations} iterations; compare at the same I`);
  if (off.N !== on.N || off.seed !== on.seed || off.scenario !== on.scenario) throw new Error('probe-compare: the runs are of different scenes');
  if (off.dualFusion === true) throw new Error(`probe-compare: the first run (${off.engine}) fuses the dual; give the unfused run first`);
  const I = off.iterations, kms = killMs(I);
  const reported = reportedOnly(off.scenario, { ...off, ...off.variant }, { ...on, ...on.variant });
  const checkpoints: CheckpointCompare[] = [];
  for (const a of off.checkpoints) {
    const b = on.checkpoints.find((x) => x.step === a.step);
    if (!b) continue;
    const pa = perPoint(a), pb = perPoint(b);
    const colours = [...pa].flatMap(([colour, x]) => {
      const y = pb.get(colour);
      return y ? [{ colour, W: x.W, offNs: x.ns, onNs: y.ns, ratio: y.ns / x.ns }] : [];
    });
    const medianRatio = median(colours.map((c) => c.ratio));
    const tail = a.tail.t && b.tail.t && a.tail.Wcrit > 0 && b.tail.Wcrit > 0
      ? { offNs: (a.tail.t.median * 1e6) / a.tail.Wcrit, onNs: (b.tail.t.median * 1e6) / b.tail.Wcrit, ratio: 0 } : null;
    if (tail) tail.ratio = tail.onNs / tail.offNs;
    const solvePass = a.solvePass && b.solvePass ? { off: a.solvePass.median, on: b.solvePass.median, savingMs: a.solvePass.median - b.solvePass.median } : null;
    const sa = sweepOf(a), sb = sweepOf(b);
    const sweep = sa && sb ? { direct: { off: sa.direct, on: sb.direct, ratio: sb.direct / sa.direct }, withTail: { off: sa.withTail, on: sb.withTail, ratio: sb.withTail / sa.withTail } } : null;
    const s = (c: Checkpoint) => ({ K: c.coloursUsed, sumW: c.sumW, points: c.totalPoints });
    const structure = { off: s(a), on: s(b), same: a.coloursUsed === b.coloursUsed && a.sumW === b.sumW && Math.abs(a.totalPoints - b.totalPoints) <= 0.01 * a.totalPoints };
    const fails: string[] = [];
    if (!colours.length) fails.push(`step ${a.step}: no direct colour timed in both runs`);
    else if (!(medianRatio <= 1 + MAX_PER_POINT_RISE)) fails.push(`step ${a.step}: per-point cost rose ${((medianRatio - 1) * 100).toFixed(1)}% (median over ${colours.length} direct colours; limit ${MAX_PER_POINT_RISE * 100}%)`);
    if (tail && !(tail.ratio <= 1 + MAX_PER_POINT_RISE)) fails.push(`step ${a.step}: the tail's cost per critical-path point rose ${((tail.ratio - 1) * 100).toFixed(1)}% (limit ${MAX_PER_POINT_RISE * 100}%)`);
    if (!solvePass) fails.push(`step ${a.step}: no solve pass timed in both runs`);
    else if (!(solvePass.savingMs >= kms)) fails.push(`step ${a.step}: the solve pass fell ${(solvePass.savingMs * 1000).toFixed(0)} µs, below I x ${KILL_US_PER_ITERATION} µs = ${(kms * 1000).toFixed(0)} µs`);
    const judged = JUDGED_WINDOWS.some(([first, last]) => a.step >= first && a.step <= last);
    checkpoints.push({ step: a.step, structure, colours, medianRatio, tail, solvePass, sweep, dual: { off: a.dual?.median ?? null, on: b.dual?.median ?? null }, fails, judged });
  }
  const judged = checkpoints.filter((c) => c.judged);
  const kill = reported ? [] : judged.length ? judged.flatMap((c) => c.fails) : ['no checkpoint of a judged window in both runs'];
  return { iterations: I, offEngine: off.engine ?? 'avbd-gpu (default)', onEngine: on.engine ?? 'avbd-gpu (default)', checkpoints, killMs: kms, reported, kill };
}

export interface BrowserCompare {
  scene: string; engines: [string, string]; iterations: number;
  /** The steps the blocks timed, [warmup, warmup + steps]; null for a record without its warmup. */
  window: [number, number] | null;
  steps: number; baseMs: number; armMs: number; savingMs: number; killMs: number; stretchMs: number;
  /** Each engine's block medians, (max - min) / median, in %: the noise to read a small saving against. */
  spreadPct: [number, number];
  /**
   * The rule decides only S4 records of a judged window (JUDGED_WINDOWS) with valid timing, whose
   * variant fuses the dual in its side array and whose base is the default; the others are
   * reported, and say why.
   */
  governs: boolean; reported: string | null; kill: boolean; valid: boolean;
}

interface BrowserRecord {
  kind?: string; scene?: { id: string; params: Record<string, unknown> };
  engines?: Array<{ name: string; variant?: Record<string, unknown> }>;
  /** Steps run before the first block; records written before the runner recorded it have none. */
  warmup?: number;
  timing?: Array<{ blocks: number; stepsPerBlock: number; blockMedians: number[] }>;
  timingValid?: boolean;
  timingProblems?: string[];
}
/** An engine as the table names it: its name, I, and the entries of its variant that differ from DEFAULT_AVBD (the switches and engine options that make it an arm). */
const specOf = (e: { name: string; variant?: Record<string, unknown> }) => {
  const kv = Object.entries(e.variant ?? {}).filter(([k, v]) => k === 'iterations' || DEFAULT_AVBD[k as keyof AvbdParams] !== v);
  return `${e.name}${kv.length ? `:${kv.map(([k, v]) => `${k}=${v}`).join(',')}` : ''}`;
};
const spread = (xs: number[]) => (100 * (Math.max(...xs) - Math.min(...xs))) / median(xs);

/**
 * One bench:browser A/B record: base (first) minus variant (second), the
 * median over blocks of each engine's per-step median, in ms. Kill below
 * I x 60 µs. stretchMs is contactpar judge-physics' I x 90 µs, reported only.
 */
export function compareBrowser(r: BrowserRecord): BrowserCompare {
  if (r.kind !== 'compare' || r.engines?.length !== 2 || r.timing?.length !== 2) throw new Error('probe-compare: a bench:browser record of two engines (base first) is needed');
  const its = r.engines.map((e) => Number(e.variant?.iterations ?? 10));
  if (its[0] !== its[1]) throw new Error(`probe-compare: the engines run ${its[0]} and ${its[1]} iterations`);
  const steps = r.timing[0]!.blocks * r.timing[0]!.stepsPerBlock;
  const window: [number, number] | null = typeof r.warmup === 'number' ? [r.warmup, r.warmup + steps] : null;
  const valid = r.timingValid !== false;
  const reported = (valid ? null : `the timing is not valid here (${r.timingProblems?.join('; ') || 'no reason given'})`)
    ?? reportedOnly(r.scene?.id, r.engines[0]!.variant, r.engines[1]!.variant)
    ?? (!window ? 'the record does not say which steps it timed (no warmup)'
      : JUDGED_WINDOWS.some(([first, last]) => window[0] === first && window[1] === last) ? null
        : `steps ${window[0]}-${window[1]}: the rule judges steps ${JUDGED_WINDOWS.map(([a, b]) => `${a}-${b}`).join(' and ')} only`);
  const governs = reported === null;
  const I = its[0]!, baseMs = median(r.timing[0]!.blockMedians), armMs = median(r.timing[1]!.blockMedians), savingMs = baseMs - armMs;
  return {
    scene: `${r.scene?.id ?? '?'} ${JSON.stringify(r.scene?.params ?? {})}`, engines: [specOf(r.engines[0]!), specOf(r.engines[1]!)], iterations: I, window,
    steps, baseMs, armMs, savingMs, killMs: killMs(I), stretchMs: (I * 90) / 1000, spreadPct: [spread(r.timing[0]!.blockMedians), spread(r.timing[1]!.blockMedians)],
    governs, reported, kill: governs && !(savingMs >= killMs(I)), valid,
  };
}

const f = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));

export function compareMarkdown(p2: P2Compare[], browser: BrowserCompare[]): string {
  const L: string[] = [];
  for (const c of p2) {
    L.push(`## P2 at I = ${c.iterations}: ${c.onEngine} against ${c.offEngine}`, '');
    for (const k of c.checkpoints) {
      L.push(`### Step ${k.step}: K ${k.structure.off.K} / ${k.structure.on.K}, ΣW ${k.structure.off.sumW} / ${k.structure.on.sumW}, points ${k.structure.off.points} / ${k.structure.on.points}${k.structure.same ? '' : ' (structure differs: the times do not compare)'}`, '');
      L.push('| Colour | W_c | off ns/point | on ns/point | on / off |', '|---|---|---|---|---|');
      for (const x of k.colours) L.push(`| ${x.colour} | ${x.W} | ${f(x.offNs, 0)} | ${f(x.onNs, 0)} | ${f(x.ratio, 3)} |`);
      if (k.tail) L.push(`| tail (t / W_crit) | | ${f(k.tail.offNs, 0)} | ${f(k.tail.onNs, 0)} | ${f(k.tail.ratio, 3)} |`);
      L.push('', `Median on / off over the direct colours: **${f(k.medianRatio, 3)}** (limit ${f(1 + MAX_PER_POINT_RISE, 2)}). Solve pass ${f(k.solvePass ? k.solvePass.off * 1000 : null, 0)} → ${f(k.solvePass ? k.solvePass.on * 1000 : null, 0)} µs, saving **${f(k.solvePass ? k.solvePass.savingMs * 1000 : null, 0)} µs** (kill below ${f(c.killMs * 1000, 0)}). Dual pass ${f(k.dual.off != null ? k.dual.off * 1000 : null, 1)} / ${f(k.dual.on != null ? k.dual.on * 1000 : null, 1)} µs.${k.judged ? '' : ' Outside the judged windows: reported only.'}`, '');
      if (k.sweep) L.push(`One sweep: direct colours ${f(k.sweep.direct.off * 1000, 0)} → ${f(k.sweep.direct.on * 1000, 0)} µs (**${f(k.sweep.direct.ratio, 3)}x**), with the tail ${f(k.sweep.withTail.off * 1000, 0)} → ${f(k.sweep.withTail.on * 1000, 0)} µs (**${f(k.sweep.withTail.ratio, 3)}x**).`, '');
    }
    const fails = c.checkpoints.flatMap((k) => k.fails);
    L.push(c.kill.length ? `**KILL**: ${c.kill.join('; ')}.`
      : c.reported ? `**Reported, not judged** (${c.reported})${fails.length ? `; the rules would fail on: ${fails.join('; ')}` : '; every P2 rule holds'}.`
        : '**Pass**: every P2 rule holds at the judged checkpoints.', '');
  }
  if (browser.length) {
    // Saving %: the records and colorMode rules are in percent of the base's step (their PRs); this tool judges only the fused dual.
    // Block spread: (max - min) / median of each engine's block medians, against which to read the 2% bands on S1 and S5.
    L.push('## bench:browser A/B records', '', '| Scene | Base | Variant | Steps | Base ms | Variant ms | Saving ms | Saving % | Block spread % (base / variant) | Kill below | I x 90 µs (reported) | Verdict |', '|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const b of browser) L.push(`| ${b.scene} | ${b.engines[0]} | ${b.engines[1]} | ${b.window ? `${b.window[0]}-${b.window[1]}` : b.steps} | ${f(b.baseMs, 3)} | ${f(b.armMs, 3)} | **${f(b.savingMs, 3)}** | ${f((100 * b.savingMs) / b.baseMs, 1)} | ${f(b.spreadPct[0], 1)} / ${f(b.spreadPct[1], 1)} | ${f(b.killMs, 2)} | ${f(b.stretchMs, 2)} ${b.savingMs >= b.stretchMs ? 'met' : 'not met'} | ${!b.governs ? `reported (${b.reported})` : b.kill ? 'KILL' : 'pass'} |`);
    // The records rule reads the median of its runs per window (its PR): one line per cell with more than one valid record.
    const cells = new Map<string, BrowserCompare[]>();
    for (const b of browser.filter((x) => x.valid)) {
      const key = [b.scene, ...b.engines, b.window ? `${b.window[0]}-${b.window[1]}` : b.steps].join(' | ');
      cells.set(key, [...(cells.get(key) ?? []), b]);
    }
    const repeated = [...cells].filter(([, bs]) => bs.length > 1);
    if (repeated.length) {
      L.push('', '### Cells timed more than once', '', '| Scene | Base | Variant | Steps | Runs | Saving % per run | Median saving % |', '|---|---|---|---|---|---|---|');
      for (const [key, bs] of repeated) {
        const pct = bs.map((b) => (100 * b.savingMs) / b.baseMs);
        L.push(`| ${key} | ${bs.length} | ${pct.map((x) => f(x, 1)).join(', ')} | **${f(median(pct), 1)}** |`);
      }
    }
  }
  return L.join('\n');
}

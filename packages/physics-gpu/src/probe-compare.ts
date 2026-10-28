// bench:probe-compare: a base and a variant side by side, from measured
// results, for an option's own rules (its PR), which are read from the tables.
// The tool judges nothing: the fused dual (AvbdParams.dualFusion), whose kill
// rules it used to apply, was removed after the M5 sweep of 2026-10-27
// (docs/plan.md).
// - P2, base against variant (two bench:probe JSON files at the same I): per
//   direct colour the per-point cost (t_c - empty dispatch) / W_c and its
//   ratio, the tail's t / W_crit, the solve pass, the dual pass, and one
//   sweep's colour time (the direct colours, and with the tail). Each
//   checkpoint lists the checks of rule P it misses: the per-point cost
//   (median over the direct colours) and the tail's may rise at most 5%
//   (contactpar judge-gpu, item 1).
// - bench:browser A/B records (base first, variant second): each engine's
//   step, the saving in ms and in percent of the base's step, each engine's
//   block spread, and the median saving of a cell timed more than once.
// A pair is flagged when one side solves points (records 0) and the other
// leaves records unset, which on the GPU is records 1 (gpuRecordsLayout), or
// one side colours with colorMode 0 and the other leaves it unset, which on
// the GPU is colorMode 3 (gpuColorMode), and a bench:browser record when its
// timing is not valid or an engine hit a limit that changed its physics during
// the timing (limitProblems: the two arms then time different simulations).
// Such records are left out of the median over repeated cells.
// Times in the P2 JSON are ms; reported here in µs.
import { type AvbdParams, DEFAULT_AVBD } from '@tb/physics-ref';
import type { Checkpoint, P2Result } from './probe.ts';

/** Rule P: the per-point cost, and the tail's per critical-path point, may rise at most this much. */
export const MAX_PER_POINT_RISE = 0.05;

type Options = { records?: unknown; colorMode?: unknown };
/** Why the base and the variant are not the same contact layout or colouring although neither seems to change it, or null. */
function layoutNote(base: Options | undefined, arm: Options | undefined): string | null {
  // On the GPU unset is records 1 (gpuRecordsLayout), so points on one side only is two layouts;
  // and unset is colorMode 3 (gpuColorMode), so colorMode 0 on one side only is two colourings.
  const unsetAnd = (k: keyof Options, v: number) => (a: Options | undefined, b: Options | undefined) => a?.[k] === undefined && b?.[k] === v;
  const points = unsetAnd('records', 0), hash = unsetAnd('colorMode', 0);
  if (points(base, arm) || points(arm, base)) return 'the base and the variant solve different contact layouts (records 0 against the default, records 1)';
  if (hash(base, arm) || hash(arm, base)) return 'the base and the variant colour differently (colorMode 0 against the default, colorMode 3)';
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
  /** The checks of rule P this checkpoint misses (MAX_PER_POINT_RISE), or that it could not make. */
  fails: string[];
}
export interface P2Compare {
  iterations: number; offEngine: string; onEngine: string; checkpoints: CheckpointCompare[];
  /** A note on the pair (layoutNote), or null. */
  note: string | null;
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
  const note = layoutNote(off.variant, on.variant);
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
    checkpoints.push({ step: a.step, structure, colours, medianRatio, tail, solvePass, sweep, dual: { off: a.dual?.median ?? null, on: b.dual?.median ?? null }, fails });
  }
  return { iterations: off.iterations, offEngine: off.engine ?? 'avbd-gpu (default)', onEngine: on.engine ?? 'avbd-gpu (default)', checkpoints, note };
}

export interface BrowserCompare {
  scene: string; engines: [string, string]; iterations: number;
  /** The steps the blocks timed, [warmup, warmup + steps]; null for a record without its warmup. */
  window: [number, number] | null;
  steps: number; baseMs: number; armMs: number; savingMs: number;
  /** Each engine's block medians, (max - min) / median, in %: the noise to read a small saving against. */
  spreadPct: [number, number];
  /** Whether bench:browser found the timing valid and no engine hit a limit that changed its physics; a note on the record (why not, or layoutNote), or null. */
  valid: boolean; note: string | null;
}

interface BrowserRecord {
  kind?: string; scene?: { id: string; params: Record<string, unknown> };
  engines?: Array<{ name: string; variant?: Record<string, unknown> }>;
  /** Steps run before the first block; records written before the runner recorded it have none. */
  warmup?: number;
  timing?: Array<{ blocks: number; stepsPerBlock: number; blockMedians: number[] }>;
  timingValid?: boolean;
  timingProblems?: string[];
  /** One sentence per limit an engine hit during the timing that changed its physics (runner execute); records from before it have none. */
  limitProblems?: string[];
}
/** An engine as the table names it: its name, I, and the entries of its variant that differ from DEFAULT_AVBD (the switches and engine options that make it an arm). */
const specOf = (e: { name: string; variant?: Record<string, unknown> }) => {
  const kv = Object.entries(e.variant ?? {}).filter(([k, v]) => k === 'iterations' || DEFAULT_AVBD[k as keyof AvbdParams] !== v);
  return `${e.name}${kv.length ? `:${kv.map(([k, v]) => `${k}=${v}`).join(',')}` : ''}`;
};
const spread = (xs: number[]) => (100 * (Math.max(...xs) - Math.min(...xs))) / median(xs);

/**
 * One bench:browser A/B record: base (first) minus variant (second), the
 * median over blocks of each engine's per-step median, in ms.
 */
export function compareBrowser(r: BrowserRecord): BrowserCompare {
  if (r.kind !== 'compare' || r.engines?.length !== 2 || r.timing?.length !== 2) throw new Error('probe-compare: a bench:browser record of two engines (base first) is needed');
  const its = r.engines.map((e) => Number(e.variant?.iterations ?? 10));
  if (its[0] !== its[1]) throw new Error(`probe-compare: the engines run ${its[0]} and ${its[1]} iterations`);
  const steps = r.timing[0]!.blocks * r.timing[0]!.stepsPerBlock;
  const window: [number, number] | null = typeof r.warmup === 'number' ? [r.warmup, r.warmup + steps] : null;
  const timingOk = r.timingValid !== false, limits = r.limitProblems ?? [];
  const valid = timingOk && limits.length === 0;
  const note = (timingOk ? null : `the timing is not valid here (${r.timingProblems?.join('; ') || 'no reason given'})`)
    ?? (limits.length ? `an engine hit a limit that changed its physics, so the arms time different simulations (${limits.join('; ')})` : null)
    ?? layoutNote(r.engines[0]!.variant, r.engines[1]!.variant);
  const I = its[0]!, baseMs = median(r.timing[0]!.blockMedians), armMs = median(r.timing[1]!.blockMedians), savingMs = baseMs - armMs;
  return {
    scene: `${r.scene?.id ?? '?'} ${JSON.stringify(r.scene?.params ?? {})}`, engines: [specOf(r.engines[0]!), specOf(r.engines[1]!)], iterations: I, window,
    steps, baseMs, armMs, savingMs, spreadPct: [spread(r.timing[0]!.blockMedians), spread(r.timing[1]!.blockMedians)], valid, note,
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
      L.push('', `Median on / off over the direct colours: **${f(k.medianRatio, 3)}** (limit ${f(1 + MAX_PER_POINT_RISE, 2)}). Solve pass ${f(k.solvePass ? k.solvePass.off * 1000 : null, 0)} → ${f(k.solvePass ? k.solvePass.on * 1000 : null, 0)} µs, saving **${f(k.solvePass ? k.solvePass.savingMs * 1000 : null, 0)} µs** (off − on). Dual pass ${f(k.dual.off != null ? k.dual.off * 1000 : null, 1)} / ${f(k.dual.on != null ? k.dual.on * 1000 : null, 1)} µs.`, '');
      if (k.sweep) L.push(`One sweep: direct colours ${f(k.sweep.direct.off * 1000, 0)} → ${f(k.sweep.direct.on * 1000, 0)} µs (**${f(k.sweep.direct.ratio, 3)}x**), with the tail ${f(k.sweep.withTail.off * 1000, 0)} → ${f(k.sweep.withTail.on * 1000, 0)} µs (**${f(k.sweep.withTail.ratio, 3)}x**).`, '');
    }
    const fails = c.checkpoints.flatMap((k) => k.fails);
    L.push(`${c.note ? `Note: ${c.note}. ` : ''}${fails.length ? `Rule P misses: ${fails.join('; ')}.` : 'Rule P holds at every checkpoint.'}`, '');
  }
  if (browser.length) {
    // Saving %: the records and colorMode rules are in percent of the base's step (their PRs).
    // Block spread: (max - min) / median of each engine's block medians, against which to read the 2% bands on S1 and S5.
    L.push('## bench:browser A/B records', '', '| Scene | Base | Variant | Steps | Base ms | Variant ms | Saving ms | Saving % | Block spread % (base / variant) | Note |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const b of browser) L.push(`| ${b.scene} | ${b.engines[0]} | ${b.engines[1]} | ${b.window ? `${b.window[0]}-${b.window[1]}` : b.steps} | ${f(b.baseMs, 3)} | ${f(b.armMs, 3)} | **${f(b.savingMs, 3)}** | ${f((100 * b.savingMs) / b.baseMs, 1)} | ${f(b.spreadPct[0], 1)} / ${f(b.spreadPct[1], 1)} | ${b.note ?? ''} |`);
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

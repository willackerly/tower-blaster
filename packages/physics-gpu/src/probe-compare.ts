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
//   judge-physics item 2, and contactpar judge-gpu's pass bar). Other
//   records (S5, S1, the binding-only A/B) are reported, not judged.
// Times in the P2 JSON are ms; reported here in µs.
import type { Checkpoint, P2Result } from './probe.ts';

export const MAX_PER_POINT_RISE = 0.05;
/** The kill threshold on the saving per step, in µs per iteration. */
export const KILL_US_PER_ITERATION = 60;
export const killMs = (iterations: number) => (iterations * KILL_US_PER_ITERATION) / 1000;

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
  dual: { off: number | null; on: number | null };
  kill: string[];
}
export interface P2Compare { iterations: number; offEngine: string; onEngine: string; checkpoints: CheckpointCompare[]; killMs: number; kill: string[] }

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
  const I = off.iterations, kms = killMs(I);
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
    const s = (c: Checkpoint) => ({ K: c.coloursUsed, sumW: c.sumW, points: c.totalPoints });
    const structure = { off: s(a), on: s(b), same: a.coloursUsed === b.coloursUsed && a.sumW === b.sumW && Math.abs(a.totalPoints - b.totalPoints) <= 0.01 * a.totalPoints };
    const kill: string[] = [];
    if (!colours.length) kill.push(`step ${a.step}: no direct colour timed in both runs`);
    else if (!(medianRatio <= 1 + MAX_PER_POINT_RISE)) kill.push(`step ${a.step}: per-point cost rose ${((medianRatio - 1) * 100).toFixed(1)}% (median over ${colours.length} direct colours; limit ${MAX_PER_POINT_RISE * 100}%)`);
    if (tail && !(tail.ratio <= 1 + MAX_PER_POINT_RISE)) kill.push(`step ${a.step}: the tail's cost per critical-path point rose ${((tail.ratio - 1) * 100).toFixed(1)}% (limit ${MAX_PER_POINT_RISE * 100}%)`);
    if (!solvePass) kill.push(`step ${a.step}: no solve pass timed in both runs`);
    else if (!(solvePass.savingMs >= kms)) kill.push(`step ${a.step}: the solve pass fell ${(solvePass.savingMs * 1000).toFixed(0)} µs, below I x ${KILL_US_PER_ITERATION} µs = ${(kms * 1000).toFixed(0)} µs`);
    checkpoints.push({ step: a.step, structure, colours, medianRatio, tail, solvePass, dual: { off: a.dual?.median ?? null, on: b.dual?.median ?? null }, kill });
  }
  const kill = checkpoints.length ? checkpoints.flatMap((c) => c.kill) : ['no checkpoint in both runs'];
  return { iterations: I, offEngine: off.engine ?? 'avbd-gpu (default)', onEngine: on.engine ?? 'avbd-gpu (default)', checkpoints, killMs: kms, kill };
}

export interface BrowserCompare {
  scene: string; engines: [string, string]; iterations: number; steps: number; baseMs: number; armMs: number; savingMs: number; killMs: number; stretchMs: number;
  /** The rule decides only S4 (city awake) records whose variant turns dualFusion on and whose base does not; the others are reported. */
  governs: boolean; kill: boolean; valid: boolean;
}

interface BrowserRecord {
  kind?: string; scene?: { id: string; params: Record<string, unknown> };
  engines?: Array<{ name: string; variant?: Record<string, unknown> }>;
  timing?: Array<{ blocks: number; stepsPerBlock: number; blockMedians: number[] }>;
  timingValid?: boolean;
}
const specOf = (e: { name: string; variant?: Record<string, unknown> }) => `${e.name}${e.variant && Object.keys(e.variant).length ? `:${Object.entries(e.variant).map(([k, v]) => `${k}=${v}`).join(',')}` : ''}`;

/**
 * One bench:browser A/B record: base (first) minus variant (second), the
 * median over blocks of each engine's per-step median, in ms. Kill below
 * I x 60 µs. stretchMs is contactpar judge-physics' I x 90 µs, reported only.
 */
export function compareBrowser(r: BrowserRecord): BrowserCompare {
  if (r.kind !== 'compare' || r.engines?.length !== 2 || r.timing?.length !== 2) throw new Error('probe-compare: a bench:browser record of two engines (base first) is needed');
  const its = r.engines.map((e) => Number(e.variant?.iterations ?? 10));
  if (its[0] !== its[1]) throw new Error(`probe-compare: the engines run ${its[0]} and ${its[1]} iterations`);
  const fused = (e: { variant?: Record<string, unknown> }) => e.variant?.dualFusion === true;
  const governs = r.scene?.id === 'S4' && !fused(r.engines[0]!) && fused(r.engines[1]!);
  const I = its[0]!, baseMs = median(r.timing[0]!.blockMedians), armMs = median(r.timing[1]!.blockMedians), savingMs = baseMs - armMs;
  return {
    scene: `${r.scene?.id ?? '?'} ${JSON.stringify(r.scene?.params ?? {})}`, engines: [specOf(r.engines[0]!), specOf(r.engines[1]!)], iterations: I,
    steps: r.timing[0]!.blocks * r.timing[0]!.stepsPerBlock, baseMs, armMs, savingMs, killMs: killMs(I), stretchMs: (I * 90) / 1000, governs, kill: governs && !(savingMs >= killMs(I)), valid: r.timingValid !== false,
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
      L.push('', `Median on / off over the direct colours: **${f(k.medianRatio, 3)}** (limit ${f(1 + MAX_PER_POINT_RISE, 2)}). Solve pass ${f(k.solvePass ? k.solvePass.off * 1000 : null, 0)} → ${f(k.solvePass ? k.solvePass.on * 1000 : null, 0)} µs, saving **${f(k.solvePass ? k.solvePass.savingMs * 1000 : null, 0)} µs** (kill below ${f(c.killMs * 1000, 0)}). Dual pass ${f(k.dual.off != null ? k.dual.off * 1000 : null, 1)} / ${f(k.dual.on != null ? k.dual.on * 1000 : null, 1)} µs.`, '');
    }
    L.push(c.kill.length ? `**KILL**: ${c.kill.join('; ')}.` : '**Pass**: every P2 rule holds.', '');
  }
  if (browser.length) {
    L.push('## bench:browser A/B records', '', '| Scene | Base | Variant | Steps | Base ms | Variant ms | Saving ms | Kill below | I x 90 µs (reported) | Verdict |', '|---|---|---|---|---|---|---|---|---|---|');
    for (const b of browser) L.push(`| ${b.scene} | ${b.engines[0]} | ${b.engines[1]} | ${b.steps} | ${f(b.baseMs, 3)} | ${f(b.armMs, 3)} | **${f(b.savingMs, 3)}** | ${f(b.killMs, 2)} | ${f(b.stretchMs, 2)} ${b.savingMs >= b.stretchMs ? 'met' : 'not met'} | ${!b.governs ? 'reported' : b.kill ? 'KILL' : 'pass'}${b.valid ? '' : ' (timing invalid)'} |`);
  }
  return L.join('\n');
}

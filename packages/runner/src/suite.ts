// The standard benchmark suite: one command, one results file, comparable
// across machines and commits.
import { loglogFit } from '@tb/metrics';
import { DEFAULT_TIMING, type TimingOptions } from '@tb/bench';
import type { RunConfig } from './config.ts';

/** Physics budget per 60 Hz step: half of a 33 ms frame, two steps. */
export const STEP_BUDGET_MS = 7.5;

export interface SuiteCase {
  /** Stable name, used to line results up across machines. */
  name: string;
  /** What the case answers. */
  question: string;
  config: RunConfig;
  /** Cases sharing a series form a scaling curve over params.N. */
  series?: string;
}

function cfg(engines: string[], scenario: string, params: RunConfig['params'], sleep: boolean | null, timing: Partial<TimingOptions> = {}): RunConfig {
  return { engines, scenario, params, seed: 1, sleep, timing: { ...DEFAULT_TIMING, warmup: 60, blockSteps: 30, blocks: 6, ...timing }, qualitySteps: 0, autorun: false };
}

export function standardSuite(engine = 'rapier', sizes = [1000, 2000, 5000, 10000, 20000]): SuiteCase[] {
  const e = [engine];
  return [
    ...sizes.map((N) => ({
      name: `rain-awake-${N}`,
      question: 'Throughput ceiling: cost per step with every body awake and colliding',
      series: 'rain-awake',
      config: cfg(e, 'S7', { N }, false, { warmup: 120 }),
    })),
    {
      name: 'city-10k-asleep',
      question: 'Idle cost of a settled 10k-cube world',
      config: cfg(e, 'S4', { N: 10000 }, true, { warmup: 300 }),
    },
    {
      name: 'city-10k-awake',
      question: 'Packed towers with sleeping disabled: the lattice worst case',
      config: cfg(e, 'S4', { N: 10000 }, false),
    },
    {
      name: 'impact-10k',
      question: 'A ball fired into the city: the collapse spike',
      config: cfg(e, 'S5', { N: 10000, fireStep: 30 }, true, { warmup: 20 }),
    },
    {
      name: 'tower-packed',
      question: 'Packed-lattice penalty, part 1: an 8x8x30 tower with columns touching',
      config: cfg(e, 'S1', { F: 8, H: 30, gap: 0 }, false),
    },
    {
      name: 'tower-gapped',
      question: 'Packed-lattice penalty, part 2: the same tower with 2% gaps',
      config: cfg(e, 'S1', { F: 8, H: 30, gap: 0.02 }, false),
    },
  ];
}

export interface CaseResult { name: string; series?: string; N: number; median: number; p95: number; p99: number; valid: boolean }

export function caseResult(c: SuiteCase, record: Record<string, unknown>): CaseResult {
  const t = (record.timing as Array<{ wallMs: { median: number; p95: number; p99: number } }>)[0]!.wallMs;
  const scene = record.scene as { bodies: number };
  return { name: c.name, ...(c.series ? { series: c.series } : {}), N: scene.bodies, median: t.median, p95: t.p95, p99: t.p99, valid: record.timingValid === true };
}

/**
 * Fit log t = a + b log N to a series and solve for the N at which the
 * median step reaches the budget. Extrapolates; say so when reporting.
 */
export function nAtBudget(points: Array<{ N: number; ms: number }>, budgetMs = STEP_BUDGET_MS) {
  const fit = loglogFit(points.map((p) => p.N), points.map((p) => p.ms));
  const n = Math.exp((Math.log(budgetMs) - fit.intercept) / fit.slope);
  const inRange = n >= Math.min(...points.map((p) => p.N)) && n <= Math.max(...points.map((p) => p.N));
  return { slope: fit.slope, r2: fit.r2, nAtBudget: n, extrapolated: !inRange };
}

export function summaryMarkdown(results: CaseResult[], suite: SuiteCase[], header: string): string {
  const fmt = (x: number) => (x >= 100 ? x.toFixed(0) : x >= 10 ? x.toFixed(1) : x.toFixed(2));
  const lines = [header, '', '| Case | Bodies | Median ms/step | p95 | p99 | Within 7.5 ms | Valid |', '|---|---|---|---|---|---|---|'];
  for (const r of results) {
    lines.push(`| ${r.name} | ${r.N} | ${fmt(r.median)} | ${fmt(r.p95)} | ${fmt(r.p99)} | ${r.p99 <= STEP_BUDGET_MS ? 'yes' : 'no'} | ${r.valid ? 'yes' : 'NO'} |`);
  }
  for (const series of new Set(results.map((r) => r.series).filter(Boolean))) {
    const pts = results.filter((r) => r.series === series).map((r) => ({ N: r.N, ms: r.median }));
    if (pts.length < 2) continue;
    const f = nAtBudget(pts);
    lines.push('', `**${series}**: cost grows as N^${f.slope.toFixed(2)} (r² ${f.r2.toFixed(3)}); median reaches ${STEP_BUDGET_MS} ms per step at about N = ${Math.round(f.nAtBudget)}${f.extrapolated ? ' (extrapolated beyond the measured range)' : ''}.`);
  }
  const packed = results.find((r) => r.name === 'tower-packed'), gapped = results.find((r) => r.name === 'tower-gapped');
  if (packed && gapped) lines.push('', `**Packed-lattice penalty**: touching columns cost ${(packed.median / gapped.median).toFixed(2)}x the gapped tower.`);
  const questions = suite.map((c) => `- \`${c.name}\`: ${c.question}`);
  lines.push('', '<details><summary>What each case measures</summary>', '', ...questions, '', '</details>');
  return lines.join('\n');
}

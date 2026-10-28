// The standard benchmark suite: one command, one results file, comparable
// across machines and commits.
import { type EngineHealth, limitsHit } from '@tb/engine-api';
import { loglogFit } from '@tb/metrics';
import { DEFAULT_TIMING, type TimingMode, type TimingOptions } from '@tb/bench';
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

function baseCfg(engines: string[], scenario: string, params: RunConfig['params'], sleep: boolean | null, timing: Partial<TimingOptions> = {}): RunConfig {
  return { engines, scenario, params, seed: 1, sleep, bounce: null, timing: { ...DEFAULT_TIMING, warmup: 60, blockSteps: 30, blocks: 6, ...timing }, qualitySteps: 0, autorun: false };
}

/**
 * The suite for one engine in one timing mode: 'latency' waits for every step,
 * 'throughput' once per block (see TimingMode). Run a GPU engine in both.
 */
export function standardSuite(engine = 'rapier', sizes = [1000, 2000, 5000, 10000, 20000], mode: TimingMode = 'latency'): SuiteCase[] {
  const e = [engine];
  const cfg = (engines: string[], scenario: string, params: RunConfig['params'], sleep: boolean | null, timing: Partial<TimingOptions> = {}) =>
    baseCfg(engines, scenario, params, sleep, { mode, ...timing });
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
      question: 'Packed-lattice penalty, part 1: an 8x8x30 tower with columns touching, 1 s after load, sleep on',
      config: cfg(e, 'S1', { F: 8, H: 30, gap: 0 }, true),
    },
    {
      name: 'tower-gapped',
      question: 'Packed-lattice penalty, part 2: the same tower with 2% gaps (with sleep off the two cost the same per step; the penalty is in settling and sleeping)',
      config: cfg(e, 'S1', { F: 8, H: 30, gap: 0.02 }, true),
    },
    // Kapla (S15, units of one plank width). Until the scene carries its metres per unit, gravity
    // is 9.81 units/s^2: planks fall as if 43x larger, slower than real ones (docs/world-scale.md).
    {
      name: 'kapla-10k-standing',
      question: 'Kapla: a 10k-plank tower standing, every plank awake: thin boxes, deep load paths, sphere-loose broadphase pairs',
      config: cfg(e, 'S15', { planks: 10000, topple: false }, false),
    },
    {
      name: 'kapla-10k-topple',
      question: 'Kapla: a ball rolled into the 10k-plank tower 1 s in, timed from 0.5 s: the collapse',
      config: cfg(e, 'S15', { planks: 10000, toppleAt: 1 }, false, { warmup: 30 }),
    },
  ];
}

/** The cases whose name contains any of the comma-separated patterns (all of them for undefined). */
export function selectCases(suite: SuiteCase[], patterns: string | undefined): SuiteCase[] {
  if (patterns === undefined) return suite;
  const ps = patterns.split(',').filter((p) => p !== '');
  const out = suite.filter((c) => ps.some((p) => c.name.includes(p)));
  if (!out.length) throw new Error(`--cases ${patterns} matches no case; cases: ${suite.map((c) => c.name).join(', ')}`);
  return out;
}

/**
 * One case's numbers. In 'throughput' mode a sample is a block's mean step, so
 * p95 and p99 are over a handful of block means and can't show a slow step.
 * `limits` names each engine limit that changed the physics, with the steps it
 * hit on (e.g. "pairs on 42 of 420 steps"); it is absent when no engine in the
 * record reported its limits (no health(), or a record from before them).
 * `limitProblems` are the record's sentences for them, fix included.
 */
export interface CaseResult { name: string; series?: string; N: number; mode: TimingMode; median: number; p95: number; p99: number; valid: boolean; limits?: string[]; limitProblems?: string[] }

export function caseResult(c: SuiteCase, record: Record<string, unknown>): CaseResult {
  const timing = (record.timing as Array<{ mode?: TimingMode; wallMs: { median: number; p95: number; p99: number } }>)[0]!;
  const t = timing.wallMs;
  const scene = record.scene as { bodies: number };
  const health = ((record.health as Array<EngineHealth | null> | undefined) ?? []).filter((h) => h !== null);
  return {
    name: c.name, ...(c.series ? { series: c.series } : {}), N: scene.bodies, mode: timing.mode ?? 'latency', median: t.median, p95: t.p95, p99: t.p99, valid: record.timingValid === true,
    ...(health.length ? { limits: health.flatMap((h) => limitsHit(h).map((l) => `${l.id} on ${l.steps} of ${h.steps} steps`)), limitProblems: (record.limitProblems as string[] | undefined) ?? [] } : {}),
  };
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
  const lines = [header, '', '| Case | Bodies | Median ms/step | p95 | p99 | Within 7.5 ms | Valid | Limits hit |', '|---|---|---|---|---|---|---|---|'];
  for (const r of results) {
    // The budget is a per-step p99, which only latency mode measures.
    const tail = r.mode === 'latency' ? [fmt(r.p95), fmt(r.p99), r.p99 <= STEP_BUDGET_MS ? 'yes' : 'no'] : ['–', '–', '–'];
    const limits = r.limits === undefined ? '–' : r.limits.length ? `**${r.limits.join(', ')}**` : 'none';
    lines.push(`| ${r.name} | ${r.N} | ${fmt(r.median)} | ${tail.join(' | ')} | ${r.valid ? 'yes' : 'NO'} | ${limits} |`);
  }
  const hit = results.filter((r) => r.limitProblems?.length);
  if (hit.length) {
    lines.push('', 'These cases hit an engine limit that changed the physics, so their rows time a different simulation from the one asked for:', '');
    for (const r of hit) for (const p of r.limitProblems!) lines.push(`- \`${r.name}\`, ${p}`);
  }
  if (results.some((r) => r.mode === 'throughput')) {
    lines.push('', 'Throughput rows give the sustained cost per step (the median over blocks of each block\'s mean step). A block mean hides a slow step, so they leave p95, p99 and the budget column to a latency run.');
  }
  for (const series of new Set(results.map((r) => r.series).filter(Boolean))) {
    const pts = results.filter((r) => r.series === series).map((r) => ({ N: r.N, ms: r.median }));
    if (pts.length < 2) continue;
    const f = nAtBudget(pts);
    lines.push('', `**${series}**: cost grows as N^${f.slope.toFixed(2)} (r² ${f.r2.toFixed(3)}); median reaches ${STEP_BUDGET_MS} ms per step at about N = ${Math.round(f.nAtBudget)}${f.extrapolated ? ' (extrapolated beyond the measured range)' : ''}.`);
  }
  const packed = results.find((r) => r.name === 'tower-packed'), gapped = results.find((r) => r.name === 'tower-gapped');
  if (packed && gapped) lines.push('', `**Packed-lattice penalty** (1 s after load, sleep on): touching columns cost ${(packed.median / gapped.median).toFixed(2)}x the gapped tower.`);
  const questions = suite.map((c) => `- \`${c.name}\`: ${c.question}`);
  lines.push('', '<details><summary>What each case measures</summary>', '', ...questions, '', '</details>');
  return lines.join('\n');
}

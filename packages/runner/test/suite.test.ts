import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { caseResult, nAtBudget, openRunner, parseConfig, standardSuite, summaryMarkdown, toQuery, type CaseResult } from '../src/orchestrate-entry.ts';

describe('standard suite', () => {
  const suite = standardSuite();
  it('has unique case names and every case builds', () => {
    expect(new Set(suite.map((c) => c.name)).size).toBe(suite.length);
    for (const c of suite) expect(buildScenario(c.config.scenario, c.config.params, c.config.seed).bodies.length).toBeGreaterThan(0);
  });

  it('carries the timing mode into every case and its URL', () => {
    expect(suite.every((c) => c.config.timing.mode === 'latency')).toBe(true);
    const gpu = standardSuite('avbd-gpu', [1000], 'throughput');
    for (const c of gpu) {
      expect(c.config.engines).toEqual(['avbd-gpu']);
      expect(parseConfig(toQuery(c.config)).timing).toEqual(c.config.timing);
      expect(c.config.timing.mode).toBe('throughput');
    }
  });

  it('solves the scaling fit for the budget crossing', () => {
    const pts = [1000, 2000, 5000, 10000].map((N) => ({ N, ms: 1e-3 * N }));
    const f = nAtBudget(pts, 7.5);
    expect(f.slope).toBeCloseTo(1, 9);
    expect(f.nAtBudget).toBeCloseTo(7500, 6);
    expect(f.extrapolated).toBe(false);
    expect(nAtBudget(pts, 100).extrapolated).toBe(true);
  });

  it('summarises results with the budget column, scaling and lattice penalty', () => {
    const rs: CaseResult[] = [
      { name: 'rain-awake-1000', series: 'rain-awake', N: 1000, mode: 'latency', median: 2, p95: 2.5, p99: 3, valid: true },
      { name: 'rain-awake-2000', series: 'rain-awake', N: 2000, mode: 'latency', median: 4, p95: 5, p99: 9, valid: true },
      { name: 'tower-packed', N: 1920, mode: 'latency', median: 30, p95: 31, p99: 32, valid: true },
      { name: 'tower-gapped', N: 1920, mode: 'latency', median: 12, p95: 13, p99: 14, valid: false },
    ];
    const md = summaryMarkdown(rs, suite, '## test');
    expect(md).toContain('| rain-awake-1000 | 1000 | 2.00 | 2.50 | 3.00 | yes | yes |');
    expect(md).toContain('| rain-awake-2000 | 2000 | 4.00 | 5.00 | 9.00 | no | yes |');
    expect(md).toContain('N^1.00');
    expect(md).toContain('about N = 3750');
    expect(md).toContain('(1 s after load, sleep on): touching columns cost 2.50x the gapped tower');
    expect(md).toContain('| NO |');
    expect(md).not.toContain('Throughput rows');
  });

  it('leaves p95, p99 and the budget verdict out of throughput rows, whose samples are block means', () => {
    // A block of 3 ms steps with one 30 ms step averages under budget; only latency mode can see the slow step.
    const rs: CaseResult[] = [{ name: 'impact-10k', N: 10001, mode: 'throughput', median: 3.9, p95: 4.0, p99: 4.0, valid: true }];
    const md = summaryMarkdown(rs, suite, '## test');
    expect(md).toContain('| impact-10k | 10001 | 3.90 | – | – | – | yes |');
    expect(md).toContain('Throughput rows give the sustained cost per step');
  });

  it('reads the timing mode from the record, defaulting to latency for older records', () => {
    const record = (mode?: string) => ({ timing: [{ ...(mode ? { mode } : {}), wallMs: { median: 1, p95: 2, p99: 3 } }], scene: { bodies: 5 }, timingValid: true });
    expect(caseResult(suite[0]!, record('throughput'))).toMatchObject({ mode: 'throughput', N: 5, median: 1, p99: 3, valid: true });
    expect(caseResult(suite[0]!, record()).mode).toBe('latency');
  });
});

describe('runner session', () => {
  it('reuses one server and browser across runs', async () => {
    const runner = await openRunner();
    try {
      const a = await runner.run(parseConfig('?scenario=S1&param.F=2&param.H=2&warmup=2&blockSteps=5&blocks=2'));
      const b = await runner.run(parseConfig('?scenario=S9&param.H=3&warmup=2&blockSteps=5&blocks=2'));
      expect((a.scene as { id: string }).id).toBe('S1');
      expect((b.scene as { id: string; bodies: number }).bodies).toBe(4);
    } finally {
      await runner.close();
    }
  });
});

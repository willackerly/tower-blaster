import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { nAtBudget, openRunner, parseConfig, standardSuite, summaryMarkdown, type CaseResult } from '../src/orchestrate-entry.ts';

describe('standard suite', () => {
  const suite = standardSuite();
  it('has unique case names and every case builds', () => {
    expect(new Set(suite.map((c) => c.name)).size).toBe(suite.length);
    for (const c of suite) expect(buildScenario(c.config.scenario, c.config.params, c.config.seed).bodies.length).toBeGreaterThan(0);
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
      { name: 'rain-awake-1000', series: 'rain-awake', N: 1000, median: 2, p95: 2.5, p99: 3, valid: true },
      { name: 'rain-awake-2000', series: 'rain-awake', N: 2000, median: 4, p95: 5, p99: 9, valid: true },
      { name: 'tower-packed', N: 1920, median: 30, p95: 31, p99: 32, valid: true },
      { name: 'tower-gapped', N: 1920, median: 12, p95: 13, p99: 14, valid: false },
    ];
    const md = summaryMarkdown(rs, suite, '## test');
    expect(md).toContain('| rain-awake-1000 | 1000 | 2.00 | 2.50 | 3.00 | yes | yes |');
    expect(md).toContain('| rain-awake-2000 | 2000 | 4.00 | 5.00 | 9.00 | no | yes |');
    expect(md).toContain('N^1.00');
    expect(md).toContain('about N = 3750');
    expect(md).toContain('(1 s after load, sleep on): touching columns cost 2.50x the gapped tower');
    expect(md).toContain('| NO |');
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

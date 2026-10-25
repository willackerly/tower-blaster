import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildScenario } from '@tb/scenarios';
import { caseResult, nAtBudget, openRunner, parseConfig, runSuite, standardSuite, summaryMarkdown, toQuery, type CaseResult, type RunnerSession } from '../src/orchestrate-entry.ts';

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

describe('runSuite', () => {
  const cases = standardSuite('rapier', [1000]).slice(0, 3);
  const record = (bodies: number) => ({ timing: [{ mode: 'latency', wallMs: { median: 1, p95: 2, p99: 3 } }], scene: { bodies }, timingValid: true, env: { browser: { userAgent: 'test agent' } } });
  const files = () => {
    const dir = mkdtempSync(join(tmpdir(), 'tb-suite-'));
    return { jsonl: join(dir, 'suite.jsonl'), md: join(dir, 'suite.md') };
  };
  const rows = (jsonl: string) => (existsSync(jsonl) ? readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { case: string; git: string }) : []);

  it('writes every row and the summary before it closes the runner, and passes on what did not close', async () => {
    const f = files();
    let atClose: { summary: boolean; rows: number } | null = null;
    let n = 0;
    const runner: RunnerSession = {
      run: async () => record(++n),
      // A close that hangs (macOS, 2026-10-25): the results must already be on disk.
      close: async () => { atClose = { summary: existsSync(f.md), rows: rows(f.jsonl).length }; return ['browser']; },
    };
    const r = await runSuite(runner, cases, { jsonl: f.jsonl, git: 'abc1234', header: (first) => `## suite (${(first.env as { browser: { userAgent: string } }).browser.userAgent})`, progress: () => {} });
    expect(atClose).toEqual({ summary: true, rows: 3 });
    expect(r.stuck).toEqual(['browser']);
    expect(r.summary).toBe(f.md);
    expect(readFileSync(f.md, 'utf8')).toBe(r.md + '\n');
    expect(r.md.startsWith('## suite (test agent)')).toBe(true);
    expect(r.results.map((x) => [x.name, x.N])).toEqual(cases.map((c, i) => [c.name, i + 1]));
    expect(rows(f.jsonl).map((x) => [x.case, x.git])).toEqual(cases.map((c) => [c.name, 'abc1234']));
  });

  it('closes the runner and rethrows when a case fails, with the rows so far and no summary', async () => {
    const f = files();
    let closes = 0, n = 0;
    const runner: RunnerSession = {
      run: async () => { if (++n === 2) throw new Error('runner page failed: lost'); return record(n); },
      close: async () => { closes++; return []; },
    };
    await expect(runSuite(runner, cases, { jsonl: f.jsonl, git: 'abc1234', header: () => '## suite', progress: () => {} })).rejects.toThrow('runner page failed: lost');
    expect(closes).toBe(1);
    expect(rows(f.jsonl).map((x) => x.case)).toEqual([cases[0]!.name]);
    expect(existsSync(f.md)).toBe(false);
  });
});

describe('runner session', () => {
  it('reuses one server and browser across runs, and closes both', async () => {
    const runner = await openRunner();
    let stuck: string[] = ['not closed'];
    try {
      const a = await runner.run(parseConfig('?scenario=S1&param.F=2&param.H=2&warmup=2&blockSteps=5&blocks=2'));
      const b = await runner.run(parseConfig('?scenario=S9&param.H=3&warmup=2&blockSteps=5&blocks=2'));
      expect((a.scene as { id: string }).id).toBe('S1');
      expect((b.scene as { id: string; bodies: number }).bodies).toBe(4);
    } finally {
      stuck = await runner.close();
    }
    expect(stuck).toEqual([]);
  });

  // The browser's main process, found by a switch only it carries (Chrome
  // passes unknown switches to none of its helpers, which all have --type=).
  const browserPid = (token: string) => {
    const pids = execFileSync('ps', ['-eo', 'pid=,args='], { encoding: 'utf8' }).split('\n')
      .filter((l) => l.includes(token) && !l.includes('--type=')).map((l) => Number(l.trim().split(/\s+/)[0]));
    expect(pids).toHaveLength(1);
    return pids[0]!;
  };
  const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

  it.skipIf(process.platform === 'win32')('close() gives up on a browser that will not exit, after closeTimeoutMs', async () => {
    const token = `--tb-teardown-test=${process.pid}-${Math.round(performance.now())}`;
    const runner = await openRunner({ closeTimeoutMs: 1500, extraArgs: [token] });
    const pid = browserPid(token);
    // A stopped browser cannot act on Browser.close, so Playwright's close
    // takes its own 30 s before its SIGKILL; close() must return at its own bound.
    process.kill(pid, 'SIGSTOP');
    try {
      const t0 = performance.now();
      const stuck = await runner.close();
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(stuck).toEqual(['browser']);
      expect(alive(pid)).toBe(true);
    } finally {
      // Playwright starts the browser as a process group leader; take its helpers too.
      process.kill(-pid, 'SIGKILL');
    }
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  });

  // Linux /proc: the processes outside the browser's process group whose
  // stdout or stderr is the browser's stderr, which Playwright's 'close' waits on.
  const outsideHolders = (pid: number) => {
    const fd = (p: string, n: number) => { try { return readlinkSync(`/proc/${p}/fd/${n}`); } catch { return null; } };
    const pgid = (p: string) => { try { return Number(readFileSync(`/proc/${p}/stat`, 'utf8').slice(readFileSync(`/proc/${p}/stat`, 'utf8').lastIndexOf(')') + 2).split(' ')[2]); } catch { return null; } };
    const stderr = fd(String(pid), 2);
    expect(stderr).toMatch(/^(socket|pipe):/);
    return readdirSync('/proc').filter((p) => /^\d+$/.test(p) && (fd(p, 1) === stderr || fd(p, 2) === stderr) && pgid(p) !== null && pgid(p) !== pid).map(Number);
  };

  it.runIf(process.platform === 'linux')('close() does not wait for a process outside the browser\'s group that holds its stdio', async () => {
    // Full Chromium (not the headless shell) starts chrome_crashpad_handler with setsid,
    // holding the browser's stdout and stderr. Stopped, it keeps them open after the
    // browser exits, and Playwright's SIGKILL of the browser's group cannot reach it, so
    // Playwright alone never finishes closing: the Mac stall, where the handler outlived
    // the browser. Our end is released once the browser has exited (releaseStdioOnExit),
    // well inside the 20 s bound.
    const token = `--tb-teardown-test=${process.pid}-${Math.round(performance.now())}`;
    const runner = await openRunner({ channel: 'chromium', closeTimeoutMs: 20_000, extraArgs: [token] });
    const holders = outsideHolders(browserPid(token));
    expect(holders.length).toBeGreaterThan(0);
    for (const h of holders) process.kill(h, 'SIGSTOP');
    try {
      const t0 = performance.now();
      const stuck = await runner.close();
      expect(performance.now() - t0).toBeLessThan(10_000);
      expect(stuck).toEqual([]);
    } finally {
      for (const h of holders) { try { process.kill(h, 'SIGKILL'); } catch { /* already gone */ } }
    }
  });

  it.runIf(process.platform === 'linux')('close() finishes after Playwright\'s 30 s kill of a browser that ignores it, and its profile is removed', async () => {
    // Both at once: the browser cannot act on Browser.close, and a process outside its
    // group holds its stdio. Playwright SIGKILLs the group at 30 s; the release then lets
    // its close finish, inside the default 45 s bound, and Playwright removes its profile.
    const token = `--tb-teardown-test=${process.pid}-${Math.round(performance.now())}`;
    const runner = await openRunner({ channel: 'chromium', extraArgs: [token] });
    const pid = browserPid(token);
    const profile = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').find((a) => a.startsWith('--user-data-dir='))!.slice('--user-data-dir='.length);
    expect(existsSync(profile)).toBe(true);
    const holders = outsideHolders(pid);
    expect(holders.length).toBeGreaterThan(0);
    for (const h of [pid, ...holders]) process.kill(h, 'SIGSTOP');
    try {
      const t0 = performance.now();
      const stuck = await runner.close();
      const s = (performance.now() - t0) / 1000;
      expect(stuck).toEqual([]);
      expect(s).toBeGreaterThan(29);
      expect(s).toBeLessThan(40);
      expect(existsSync(profile)).toBe(false);
    } finally {
      for (const h of holders) { try { process.kill(h, 'SIGKILL'); } catch { /* already gone */ } }
      try { process.kill(-pid, 'SIGKILL'); } catch { /* group gone */ }
    }
  }, 60_000);
});

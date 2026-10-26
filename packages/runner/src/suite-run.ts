// Node side of bench:suite: run every case in one runner session, append a
// jsonl row per case, write the Markdown summary, and only then tear down.
import { appendFileSync, writeFileSync } from 'node:fs';
import type { RunnerSession } from './orchestrate.ts';
import { caseResult, type CaseResult, type SuiteCase, summaryMarkdown } from './suite.ts';

export interface SuiteOutput {
  /** Results file; the summary goes next to it as .md. */
  jsonl: string;
  git: string;
  /** The summary's header, from the first case's record (its env names the browser and adapter). */
  header: (first: Record<string, unknown>) => string;
  progress?: (text: string) => void;
}

/**
 * Run the suite and close the runner. The summary is written before the
 * runner closes: closing Chrome hung after a WebGPU suite (macOS,
 * 2026-10-25; see testkit's teardown.ts), and the results must not wait on it. If a case fails, the
 * runner is closed and the error rethrown, with no summary.
 */
export async function runSuite(runner: RunnerSession, suite: SuiteCase[], out: SuiteOutput): Promise<{ results: CaseResult[]; md: string; summary: string; stuck: string[] }> {
  const progress = out.progress ?? ((text: string) => process.stderr.write(text));
  const results: CaseResult[] = [];
  const summary = out.jsonl.replace(/\.jsonl$/, '.md');
  let first: Record<string, unknown> | undefined;
  let md = '';
  let stuck: string[] = [];
  try {
    for (const [i, c] of suite.entries()) {
      progress(`[${i + 1}/${suite.length}] ${c.name} … `);
      const record = await runner.run(c.config);
      first ??= record;
      appendFileSync(out.jsonl, JSON.stringify({ case: c.name, git: out.git, ...record }) + '\n');
      const r = caseResult(c, record);
      results.push(r);
      progress(`${r.median.toFixed(2)} ms/step\n`);
    }
    md = summaryMarkdown(results, suite, out.header(first ?? {}));
    writeFileSync(summary, md + '\n');
  } finally {
    progress('closing the browser and server … ');
    stuck = await runner.close();
    progress(stuck.length ? `not closed: ${stuck.join(', ')}\n` : 'closed\n');
  }
  return { results, md, summary, stuck };
}

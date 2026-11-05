// Node side: a browser page with the probe bundle (page.ts) loaded, and a
// loop that runs a probe's cases on it and returns the verdict.
import { fileURLToPath } from 'node:url';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Page from './page.ts';
import type { CaseRun, Probe, Size, Verdict } from './probe.ts';

export interface ProbePage {
  adapter: string;
  software: boolean;
  run(id: string, size: Size, index: number): Promise<Page.PageRun>;
  close(): Promise<string[]>;
}

type Win = { __probes: typeof Page };

/** Opens Chromium (SwiftShader on Linux; channel "chrome" for the installed Chrome and the real GPU) with page.ts loaded; null without WebGPU. */
export async function openProbePage(opts: { channel?: string; headless?: boolean } = {}): Promise<ProbePage | null> {
  const gpu: WebGPUSession | null = await openWebGPU([], opts);
  if (!gpu) return null;
  try {
    await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__probes');
    const a = await gpu.page.evaluate(() => (window as unknown as Win).__probes.adapter());
    return {
      adapter: a.text, software: a.software,
      run: (id, size, index) => gpu.page.evaluate(([i, s, k]) => (window as unknown as Win).__probes.runCase(i, s, k), [id, size, index] as const),
      close: () => gpu.close(),
    };
  } catch (e) {
    await gpu.close();
    throw e;
  }
}

export interface ProbeRun { probe: string; size: Size; runs: Array<CaseRun<unknown, unknown> & { label: string; error: string | null }>; verdict: Verdict }

/** Runs every case of `probe` at `size` (or those `only` picks) on the page, in order, and judges them. */
export async function runProbe(page: ProbePage, probe: Probe, size: Size, opts: { only?: (label: string) => boolean; log?: (line: string) => void } = {}): Promise<ProbeRun> {
  const cases = probe.cases(size), runs: ProbeRun['runs'] = [];
  for (let k = 0; k < cases.length; k++) {
    const c = cases[k]!, label = probe.label(c);
    if (opts.only && !opts.only(label)) continue;
    const r = await page.run(probe.id, size, k);
    opts.log?.(`[${probe.id} ${k + 1}/${cases.length}] ${label}: ${r.steps} steps, ${(r.wallMs / 1000).toFixed(1)} s${r.error ? `, ERROR ${r.error.split('\n')[0]}` : ''}${r.limits.length ? `, ${r.limits.length} limit(s) hit` : ''}`);
    runs.push({ c, label, result: r.result, steps: r.steps, wallMs: r.wallMs, limits: r.limits, error: r.error });
  }
  const ok = runs.filter((r) => r.error === null);
  const verdict = probe.verdict(ok, size);
  const failed = runs.filter((r) => r.error !== null);
  if (failed.length) verdict.checks.push({ name: 'every run completed', pass: false, detail: failed.map((r) => `${r.label}: ${r.error!.split('\n')[0]}`).join('; ') });
  if (failed.length && verdict.pass) verdict.pass = false;
  // A subset of the cases cannot decide a rule written over all of them; its checks still say what it saw.
  if (opts.only) verdict.pass = null;
  return { probe: probe.id, size, runs, verdict };
}

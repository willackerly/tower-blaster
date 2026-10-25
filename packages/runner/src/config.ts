// Run configuration carried in the page URL, so a run is a shareable link
// and the orchestrator needs no other channel into the page.
import type { Params } from '@tb/scenarios';
import { DEFAULT_TIMING, type TimingOptions } from '@tb/bench';

export interface RunConfig {
  /** One engine: a timed run. Two: an interleaved comparison (second relative to first). */
  engines: string[];
  scenario: string;
  params: Params;
  seed: number;
  /** Override the scenario's sleep setting. */
  sleep: boolean | null;
  timing: TimingOptions;
  /** Also run a quality pass of this many steps (0 = none). */
  qualitySteps: number;
  autorun: boolean;
}

const num = (v: string, key: string) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${v}"`);
  return n;
};

export function parseConfig(search: string): RunConfig {
  const q = new URLSearchParams(search);
  const engines = (q.get('engines') ?? 'rapier').split(',').map((s) => s.trim()).filter(Boolean);
  if (engines.length < 1 || engines.length > 2) throw new Error('engines must list one or two engine specs');
  const params: Params = {};
  for (const [k, v] of q) {
    if (!k.startsWith('param.')) continue;
    params[k.slice(6)] = v === 'true' ? true : v === 'false' ? false : num(v, k);
  }
  const sleep = q.get('sleep');
  const get = (k: string, d: number) => (q.has(k) ? num(q.get(k)!, k) : d);
  return {
    engines,
    scenario: q.get('scenario') ?? 'S1',
    params,
    seed: get('seed', 1),
    sleep: sleep === null ? null : sleep === 'true',
    timing: { warmup: get('warmup', DEFAULT_TIMING.warmup), blockSteps: get('blockSteps', DEFAULT_TIMING.blockSteps), blocks: get('blocks', DEFAULT_TIMING.blocks) },
    qualitySteps: get('qualitySteps', 0),
    autorun: q.get('autorun') === '1',
  };
}

export function toQuery(c: RunConfig): string {
  const q = new URLSearchParams();
  q.set('engines', c.engines.join(','));
  q.set('scenario', c.scenario);
  for (const [k, v] of Object.entries(c.params)) q.set(`param.${k}`, String(v));
  q.set('seed', String(c.seed));
  if (c.sleep !== null) q.set('sleep', String(c.sleep));
  q.set('warmup', String(c.timing.warmup));
  q.set('blockSteps', String(c.timing.blockSteps));
  q.set('blocks', String(c.timing.blocks));
  if (c.qualitySteps) q.set('qualitySteps', String(c.qualitySteps));
  if (c.autorun) q.set('autorun', '1');
  return `?${q.toString()}`;
}

// Run configuration carried in the page URL, so a run is a shareable link
// and the orchestrator needs no other channel into the page.
import type { SceneDesc } from '@tb/engine-api';
import { bounceScene, buildScenario, type Params } from '@tb/scenarios';
import { DEFAULT_TIMING, type TimingOptions } from '@tb/bench';

export interface RunConfig {
  /** One engine: a timed run. Two: an interleaved comparison (second relative to first). */
  engines: string[];
  scenario: string;
  params: Params;
  seed: number;
  /** Override the scenario's sleep setting. */
  sleep: boolean | null;
  /**
   * Every body, spawn and the ground at this restitution (bounceScene), so an
   * engine with restitution on bounces; null: the scenario's own (0).
   */
  bounce: number | null;
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

/**
 * The engine specs in an engines list. Specs are comma-separated, and so are a
 * spec's options, so a piece that is an option (key=value, no engine name
 * before a colon) belongs to the spec before it: "avbd-gpu:iterations=20,
 * records=2,avbd-gpu:iterations=20" is two engines, the first with two
 * options. No engine name contains '=', so no other list changes meaning.
 */
export function splitEngines(list: string): string[] {
  const specs: string[] = [];
  for (const piece of list.split(',').map((s) => s.trim()).filter(Boolean)) {
    const option = piece.includes('=') && !piece.split('=')[0]!.includes(':');
    if (option && specs.length && specs.at(-1)!.includes(':')) specs[specs.length - 1] += `,${piece}`;
    else specs.push(piece);
  }
  return specs;
}

export function parseConfig(search: string): RunConfig {
  const q = new URLSearchParams(search);
  const engines = splitEngines(q.get('engines') ?? 'rapier');
  if (engines.length < 1 || engines.length > 2) throw new Error('engines must list one or two engine specs');
  const params: Params = {};
  for (const [k, v] of q) {
    if (!k.startsWith('param.')) continue;
    params[k.slice(6)] = v === 'true' ? true : v === 'false' ? false : num(v, k);
  }
  const sleep = q.get('sleep');
  const bounceText = q.get('bounce');
  const bounce = bounceText === null ? null : Number(bounceText);
  if (bounce !== null && (bounceText!.trim() === '' || !(bounce >= 0 && bounce <= 1))) throw new Error(`bounce must be a number from 0 to 1, got "${bounceText}"`);
  const get = (k: string, d: number) => (q.has(k) ? num(q.get(k)!, k) : d);
  const mode = q.get('timingMode') ?? 'latency';
  if (mode !== 'latency' && mode !== 'throughput') throw new Error(`timingMode must be latency or throughput, got "${mode}"`);
  return {
    engines,
    scenario: q.get('scenario') ?? 'S1',
    params,
    seed: get('seed', 1),
    sleep: sleep === null ? null : sleep === 'true',
    bounce,
    timing: { warmup: get('warmup', DEFAULT_TIMING.warmup), blockSteps: get('blockSteps', DEFAULT_TIMING.blockSteps), blocks: get('blocks', DEFAULT_TIMING.blocks), mode },
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
  if (c.bounce !== null) q.set('bounce', String(c.bounce));
  q.set('warmup', String(c.timing.warmup));
  q.set('blockSteps', String(c.timing.blockSteps));
  q.set('blocks', String(c.timing.blocks));
  if (c.timing.mode && c.timing.mode !== 'latency') q.set('timingMode', c.timing.mode);
  if (c.qualitySteps) q.set('qualitySteps', String(c.qualitySteps));
  if (c.autorun) q.set('autorun', '1');
  return `?${q.toString()}`;
}

/** The scene a config runs: the scenario, with the config's sleep and bounce if it sets them. */
export function runScene(c: RunConfig): SceneDesc {
  const built = buildScenario(c.scenario, c.params, c.seed);
  const scene = c.bounce === null ? built : bounceScene(built, c.bounce);
  if (c.sleep !== null) scene.sleep = c.sleep;
  return scene;
}

/** What a result record says about the scene it ran (bounce only when the config sets one). */
export function sceneKey(c: RunConfig, scene: SceneDesc) {
  return { id: scene.id, params: scene.params, seed: scene.seed, sleep: scene.sleep, ...(c.bounce === null ? {} : { bounce: c.bounce }), bodies: scene.bodies.length, inputs: scene.inputs.length };
}

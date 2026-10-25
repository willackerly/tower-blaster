// Viewer configuration from the URL, e.g.
// ?scenario=S4&param.N=3000&engine=rapier&sleep=1
import { SCENARIOS } from '@tb/scenarios';

export interface ViewerConfig {
  engine: string;
  scenario: string;
  params: Record<string, number | boolean>;
  seed: number;
  sleep: boolean | null;
  /** Fire a ball automatically after this many steps (tests, demos); 0 = off. */
  autofire: number;
  /** Render to an offscreen texture (headless tests; see Renderer.create). */
  offscreen: boolean;
}

export const DEFAULT_CONFIG: ViewerConfig = { engine: 'rapier', scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, seed: 1, sleep: null, autofire: 0, offscreen: false };

export function parseViewerConfig(search: string): ViewerConfig {
  const q = new URLSearchParams(search);
  const scenario = (q.get('scenario') ?? DEFAULT_CONFIG.scenario).toUpperCase();
  if (!SCENARIOS[scenario]) throw new Error(`unknown scenario ${scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  const params: Record<string, number | boolean> = {};
  for (const [k, v] of q) {
    if (!k.startsWith('param.')) continue;
    params[k.slice(6)] = v === 'true' ? true : v === 'false' ? false : Number(v);
    if (typeof params[k.slice(6)] === 'number' && !Number.isFinite(params[k.slice(6)])) throw new Error(`param ${k} is not a number: ${v}`);
  }
  const hasParams = [...q.keys()].some((k) => k.startsWith('param.'));
  const sleep = q.get('sleep');
  return {
    engine: q.get('engine') ?? DEFAULT_CONFIG.engine,
    scenario,
    params: hasParams ? params : scenario === DEFAULT_CONFIG.scenario ? { ...DEFAULT_CONFIG.params } : {},
    seed: Number(q.get('seed') ?? 1),
    sleep: sleep === null ? null : sleep === '1' || sleep === 'true',
    autofire: Number(q.get('autofire') ?? 0),
    offscreen: q.get('offscreen') === '1',
  };
}

export function toSearch(c: ViewerConfig): string {
  const q = new URLSearchParams({ scenario: c.scenario, engine: c.engine });
  for (const [k, v] of Object.entries(c.params)) q.set(`param.${k}`, String(v));
  if (c.seed !== 1) q.set('seed', String(c.seed));
  if (c.sleep !== null) q.set('sleep', c.sleep ? '1' : '0');
  if (c.autofire) q.set('autofire', String(c.autofire));
  if (c.offscreen) q.set('offscreen', '1');
  return `?${q}`;
}

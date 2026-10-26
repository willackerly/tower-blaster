// Viewer configuration from the URL, e.g.
// ?scenario=S4&param.N=3000&engine=rapier&sleep=1 (engine: a @tb/bench spec; the default is the GPU engine)
import { parseSpec } from '@tb/bench';
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
  /** Look preset: candy (default) or hazy. */
  look: string;
}

export const DEFAULT_CONFIG: ViewerConfig = { engine: 'avbd-gpu', scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, seed: 1, sleep: null, autofire: 0, offscreen: false, look: 'candy' };

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
    look: q.get('look') ?? DEFAULT_CONFIG.look,
  };
}

export function toSearch(c: ViewerConfig): string {
  const q = new URLSearchParams({ scenario: c.scenario, engine: c.engine });
  for (const [k, v] of Object.entries(c.params)) q.set(`param.${k}`, String(v));
  if (c.seed !== 1) q.set('seed', String(c.seed));
  if (c.sleep !== null) q.set('sleep', c.sleep ? '1' : '0');
  if (c.autofire) q.set('autofire', String(c.autofire));
  if (c.offscreen) q.set('offscreen', '1');
  if (c.look !== DEFAULT_CONFIG.look) q.set('look', c.look);
  return `?${q}`;
}

/** A preset's search with the current engine kept, which is where its button takes you. */
export function presetSearch(preset: string, engine: string): string {
  return toSearch({ ...parseViewerConfig(preset), engine });
}

/** Bodies fired balls may add on the GPU engine, whose buffers are sized at init. */
export const GPU_SPARE = 256;

/** The engine spec to build: the GPU engine gets room for GPU_SPARE fired balls unless the spec sets spare. */
export function engineSpec(spec: string): string {
  const { name, options } = parseSpec(spec);
  if (name !== 'avbd-gpu' || options.spare !== undefined) return spec;
  return withOption(spec, 'spare', GPU_SPARE);
}

/** spec with one option set, or removed when value is undefined; the other options keep their order. */
export function withOption(spec: string, key: string, value: number | boolean | undefined): string {
  const { name, options } = parseSpec(spec);
  const o = { ...options };
  if (value === undefined) delete o[key];
  else o[key] = value;
  const kv = Object.entries(o).map(([k, v]) => `${k}=${v}`);
  return kv.length ? `${name}:${kv.join(',')}` : name;
}

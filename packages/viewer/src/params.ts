// Viewer configuration from the URL, e.g.
// ?scenario=S4&param.N=3000&engine=rapier&sleep=1&maxSteps=2&proj=cube&proj.size=2
// (engine: a @tb/bench spec; the default is the GPU engine; proj*: see projectile.ts)
import { parseSpec } from '@tb/bench';
import { boundingRadius } from '@tb/geom';
import { SCENARIOS } from '@tb/scenarios';
import { MAX_STEPS_LIMIT } from './loop.ts';
import { DEFAULT_PROJECTILE, parseProjectile, type Projectile, projectileShape, writeProjectile } from './projectile.ts';

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
  /** Most physics steps per frame, 1 to MAX_STEPS_LIMIT (see stepsDue); 1 = no catch-up. */
  maxSteps: number;
  /** What a click fires. */
  projectile: Projectile;
}

export const DEFAULT_CONFIG: ViewerConfig = { engine: 'avbd-gpu', scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, seed: 1, sleep: null, autofire: 0, offscreen: false, look: 'candy', maxSteps: 1, projectile: DEFAULT_PROJECTILE };

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
  const maxSteps = Number(q.get('maxSteps') ?? DEFAULT_CONFIG.maxSteps);
  if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > MAX_STEPS_LIMIT) throw new Error(`maxSteps must be an integer from 1 to ${MAX_STEPS_LIMIT}: ${q.get('maxSteps')}`);
  return {
    engine: q.get('engine') ?? DEFAULT_CONFIG.engine,
    scenario,
    params: hasParams ? params : scenario === DEFAULT_CONFIG.scenario ? { ...DEFAULT_CONFIG.params } : {},
    seed: Number(q.get('seed') ?? 1),
    sleep: sleep === null ? null : sleep === '1' || sleep === 'true',
    autofire: Number(q.get('autofire') ?? 0),
    offscreen: q.get('offscreen') === '1',
    look: q.get('look') ?? DEFAULT_CONFIG.look,
    maxSteps,
    projectile: parseProjectile(q),
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
  if (c.maxSteps !== DEFAULT_CONFIG.maxSteps) q.set('maxSteps', String(c.maxSteps));
  writeProjectile(c.projectile, q);
  return `?${q}`;
}

/** A preset's search with the current engine and projectile kept, which is where its button takes you. */
export function presetSearch(preset: string, engine: string, projectile: Projectile = DEFAULT_PROJECTILE): string {
  return toSearch({ ...parseViewerConfig(preset), engine, projectile });
}

/** Bodies fired balls may add on the engines whose id tables are sized at init (GPU AVBD, the tiers). */
export const GPU_SPARE = 256;

/**
 * The engine spec to build: the GPU and tiered engines get room for GPU_SPARE fired balls unless
 * the spec sets spare, and the GPU engine's broadphase is sized for the projectile unless the spec
 * sets maxRadius. That changes nothing while the projectile is no larger than the scene's largest
 * body (the engine takes the larger of the two), which holds for the default ball in every scene.
 */
export function engineSpec(spec: string, projectile: Projectile = DEFAULT_PROJECTILE): string {
  const { name, options } = parseSpec(spec);
  if (name !== 'avbd-gpu' && name !== 'tiered') return spec;
  let out = options.spare === undefined ? withOption(spec, 'spare', GPU_SPARE) : spec;
  if (name === 'avbd-gpu' && options.maxRadius === undefined) out = withOption(out, 'maxRadius', boundingRadius(projectileShape(projectile)));
  return out;
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

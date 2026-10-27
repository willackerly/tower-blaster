// Viewer configuration from the URL, e.g.
// ?scenario=S4&param.N=3000&engine=rapier&sleep=1&loop=frame&maxSteps=2&proj=cube&proj.size=2
// (engine: a @tb/bench spec; the default is the GPU engine; proj*: see projectile.ts;
// look=real with real.* knobs: see parseRealOptions in @tb/render; cam: see parseCamera; scale=0.25: quarter-metre cubes, substeps=2)
import { parseSpec } from '@tb/bench';
import type { BodyDesc, SceneDesc, Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { froudeParams } from '@tb/physics-ref';
import { LOOKS, parseRealOptions, type RealOptions, writeRealOptions } from '@tb/render';
import { SCENARIOS } from '@tb/scenarios';
import type { CameraPose } from './camera.ts';
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
  /** Look preset: candy (default), hazy or real. */
  look: string;
  /** The real look's knobs that differ from REAL_DEFAULTS (URL keys real.*); kept whatever the look. */
  real: Partial<RealOptions>;
  /**
   * free (default): physics steps in its own loop, back to back while steps
   * are due, and every frame renders (stepDue, alphaAt). frame: each frame
   * steps, waits for the snapshot, then renders (stepsDue), as before.
   */
  loop: 'free' | 'frame';
  /**
   * loop=free with a GPU engine: while physics is behind, queue each step
   * behind the read-back of the one before, so the GPU never waits for the
   * page (runFree). pipeline=0 turns it off.
   */
  pipeline: boolean;
  /** loop=frame only: most physics steps per frame, 1 to MAX_STEPS_LIMIT (see stepsDue); 1 = no catch-up. */
  maxSteps: number;
  /** What a click fires. */
  projectile: Projectile;
  /**
   * How big a cube is, metres per world unit (1: the scenarios' unit cubes are
   * 1 m). Physics stays in cube units with gravity 9.81 / scale (worldScene,
   * worldEngineSpec), so a world at scale s moves as the unit world played
   * 1/sqrt(s) times as fast; the renderer draws its metric details (ground,
   * air, dust) to match.
   */
  scale: number;
  /**
   * Physics steps per 1/60 s (each scene.dt / substeps): finer steps, n times the physics cost.
   * Default autoSubsteps(scale): a world of smaller cubes at the unit world's 1/60 s steps is
   * the unit world at longer steps, which throws a collapse much further (docs/world-scale.md).
   * Counts in 1/60 s keep their meaning: autofire's step and loop=frame's maxSteps are multiplied by it.
   */
  substeps: number;
  /** Where the camera starts on every load and R; null = framed to fit the scene. */
  camera: CameraPose | null;
}

/** scale's accepted range, and the most substeps. */
export const SCALE_LIMITS = [0.01, 10] as const;
export const MAX_SUBSTEPS = 8;

/**
 * Substeps that keep a world at this scale stepping no coarser than the
 * unit world at 1/60 s (each step is 1/sqrt(scale) of a unit-world step,
 * Froude): 2 at quarter-metre cubes (and at half-metre ones), 1 from 1 m up.
 */
export const autoSubsteps = (scale: number) => Math.min(MAX_SUBSTEPS, Math.max(1, Math.ceil(1 / Math.sqrt(scale) - 1e-9)));

/**
 * The scene a world at this scale and substeps runs: gravity 1/scale as
 * strong (in cube units), every starting and spawned velocity froudeSpeed
 * times as fast (so a scenario's throws keep their arcs), steps divided and
 * spawns moved to the same moment in the finer steps.
 */
export function worldScene(scene: SceneDesc, scale: number, substeps: number): SceneDesc {
  if (scale === 1 && substeps === 1) return scene;
  const f = froudeSpeed(scale);
  const fast = (b: BodyDesc): BodyDesc => (f === 1 ? b : { ...b, linVel: b.linVel.map((v) => v * f) as Vec3, angVel: b.angVel.map((v) => v * f) as Vec3 });
  return {
    ...scene,
    gravity: scene.gravity.map((g) => g / scale) as Vec3,
    dt: scene.dt / substeps,
    bodies: scene.bodies.map(fast),
    inputs: scene.inputs.map((e) => ({ ...e, step: e.step * substeps, ...(e.kind === 'spawn' ? { body: fast(e.body) } : {}) })),
  };
}

/** The scale a scenario runs at when the URL sets none. */
export const defaultScale = (scenario: string) => SCENARIOS[scenario]?.scale ?? 1;

/** How much faster than the unit world a world at this scale moves (speeds, in cube units per second). */
export const froudeSpeed = (scale: number) => 1 / Math.sqrt(scale);

export const DEFAULT_CONFIG: ViewerConfig = { engine: 'avbd-gpu', scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, seed: 1, sleep: null, autofire: 0, offscreen: false, look: 'candy', real: {}, loop: 'free', pipeline: true, maxSteps: 1, projectile: DEFAULT_PROJECTILE, scale: 1, substeps: 1, camera: null };

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
  const look = q.get('look') ?? DEFAULT_CONFIG.look;
  if (!LOOKS[look]) throw new Error(`unknown look ${look}; known: ${Object.keys(LOOKS).join(', ')}`);
  // maxSteps is a frame-loop option, so a URL that sets it without a loop keeps meaning what it did before loop=free.
  const loop = q.get('loop') ?? (q.has('maxSteps') ? 'frame' : DEFAULT_CONFIG.loop);
  if (loop !== 'free' && loop !== 'frame') throw new Error(`loop must be free or frame: ${loop}`);
  if (loop === 'free' && maxSteps !== DEFAULT_CONFIG.maxSteps) throw new Error('maxSteps applies to loop=frame; loop=free catches up on its own');
  const pipeline = q.get('pipeline') ?? '1';
  if (pipeline !== '0' && pipeline !== '1') throw new Error(`pipeline must be 0 or 1: ${pipeline}`);
  if (loop === 'frame' && pipeline === '0') throw new Error('pipeline applies to loop=free');
  const scale = Number(q.get('scale') ?? defaultScale(scenario));
  if (!(scale >= SCALE_LIMITS[0] && scale <= SCALE_LIMITS[1])) throw new Error(`scale must be a number from ${SCALE_LIMITS[0]} to ${SCALE_LIMITS[1]} (metres per cube): ${q.get('scale')}`);
  const substeps = Number(q.get('substeps') ?? autoSubsteps(scale));
  if (!Number.isInteger(substeps) || substeps < 1 || substeps > MAX_SUBSTEPS) throw new Error(`substeps must be an integer from 1 to ${MAX_SUBSTEPS}: ${q.get('substeps')}`);
  return {
    engine: q.get('engine') ?? DEFAULT_CONFIG.engine,
    scenario,
    params: hasParams ? params : scenario === DEFAULT_CONFIG.scenario ? { ...DEFAULT_CONFIG.params } : {},
    seed: Number(q.get('seed') ?? 1),
    sleep: sleep === null ? null : sleep === '1' || sleep === 'true',
    autofire: Number(q.get('autofire') ?? 0),
    offscreen: q.get('offscreen') === '1',
    look,
    real: parseRealOptions(q),
    loop,
    pipeline: pipeline === '1',
    maxSteps,
    projectile: parseProjectile(q),
    scale,
    substeps,
    camera: parseCamera(q.get('cam')),
  };
}

/** URL key cam: target x,y,z, yaw, pitch (radians) and distance (m), as writeCamera writes it; absent = null. */
export function parseCamera(raw: string | null): CameraPose | null {
  if (raw === null || raw === '') return null;
  const v = raw.split(',').map(Number);
  if (v.length !== 6 || v.some((x) => !Number.isFinite(x)) || v[5]! <= 0) throw new Error(`cam must be six numbers, target x,y,z, yaw, pitch, distance > 0: ${raw}`);
  return { target: [v[0]!, v[1]!, v[2]!], yaw: v[3]!, pitch: v[4]!, distance: v[5]! };
}

export const writeCamera = (p: CameraPose) => [...p.target, p.yaw, p.pitch, p.distance].join(',');

export function toSearch(c: ViewerConfig): string {
  const q = new URLSearchParams({ scenario: c.scenario, engine: c.engine });
  for (const [k, v] of Object.entries(c.params)) q.set(`param.${k}`, String(v));
  if (c.seed !== 1) q.set('seed', String(c.seed));
  if (c.sleep !== null) q.set('sleep', c.sleep ? '1' : '0');
  if (c.autofire) q.set('autofire', String(c.autofire));
  if (c.offscreen) q.set('offscreen', '1');
  if (c.look !== DEFAULT_CONFIG.look) q.set('look', c.look);
  writeRealOptions(c.real, q);
  if (c.loop !== DEFAULT_CONFIG.loop) q.set('loop', c.loop);
  if (c.pipeline !== DEFAULT_CONFIG.pipeline) q.set('pipeline', c.pipeline ? '1' : '0');
  if (c.maxSteps !== DEFAULT_CONFIG.maxSteps) q.set('maxSteps', String(c.maxSteps));
  writeProjectile(c.projectile, q);
  if (c.scale !== defaultScale(c.scenario)) q.set('scale', String(c.scale));
  if (c.substeps !== autoSubsteps(c.scale)) q.set('substeps', String(c.substeps));
  if (c.camera) q.set('cam', writeCamera(c.camera));
  return `?${q}`;
}

/**
 * A preset's search with how the viewer runs (engine, loop, pipeline,
 * substeps set by hand), the projectile, the look and a chosen scale kept (a scale left
 * at the current scenario's default becomes the preset's default), which is
 * where its button takes you (framed afresh: no camera).
 */
export function presetSearch(preset: string, cur: Pick<ViewerConfig, 'engine' | 'loop' | 'pipeline' | 'maxSteps' | 'projectile'> & Partial<Pick<ViewerConfig, 'look' | 'real' | 'substeps' | 'scale' | 'scenario'>>): string {
  const { engine, loop, pipeline, maxSteps, projectile, look = DEFAULT_CONFIG.look, real = {} } = cur;
  const next = parseViewerConfig(preset);
  const chosen = cur.scale !== undefined && cur.scenario !== undefined && cur.scale !== defaultScale(cur.scenario);
  const scale = chosen ? cur.scale! : next.scale;
  // Substeps set by hand stay; otherwise the new scale's own.
  const substeps = cur.substeps !== undefined && cur.substeps !== autoSubsteps(cur.scale ?? 1) ? cur.substeps : autoSubsteps(scale);
  return toSearch({ ...next, engine, loop, pipeline, maxSteps, projectile, look, real, substeps, scale });
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

/**
 * The engine spec for a world at this scale: the AVBD engines' penalties
 * (and beta) scaled by 1/scale and their spin cap by 1/sqrt(scale)
 * (froudeParams), taken from the spec's own values or the defaults, so the
 * world moves exactly as the unit world played faster. Other engines get
 * the stronger gravity alone.
 */
export function worldEngineSpec(spec: string, scale: number): string {
  const { name, options } = parseSpec(spec);
  if (scale === 1 || (name !== 'avbd-gpu' && name !== 'avbd-ref')) return spec;
  const own = Object.fromEntries(FROUDE_KEYS.filter((k) => options[k] !== undefined).map((k) => [k, Number(options[k])]));
  const scaled = froudeParams(own, 1 / scale);
  return FROUDE_KEYS.reduce((out, k) => withOption(out, k, scaled[k] as number), spec);
}
const FROUDE_KEYS = ['beta', 'penaltyMin', 'penaltyMax', 'maxAngularSpeed'] as const;

/** spec with one option set, or removed when value is undefined; the other options keep their order. */
export function withOption(spec: string, key: string, value: number | boolean | undefined): string {
  const { name, options } = parseSpec(spec);
  const o = { ...options };
  if (value === undefined) delete o[key];
  else o[key] = value;
  const kv = Object.entries(o).map(([k, v]) => `${k}=${v}`);
  return kv.length ? `${name}:${kv.join(',')}` : name;
}

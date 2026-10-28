// Viewer configuration from the URL, e.g.
// ?scenario=S4&param.N=3000&engine=rapier&sleep=1&loop=frame&maxSteps=2&proj=cube&proj.size=2
// (engine: a @tb/bench spec; the default is the GPU engine; proj*: see projectile.ts;
// look=real with real.* knobs: see parseRealOptions in @tb/render; cam: see parseCamera; scale=0.25: quarter-metre cubes, substeps=2;
// view.pitch=17&view.fit=1.1&view.fov=45: how a scene without cam is framed, see parseFraming;
// engine=avbd-gpu:restitution=true&bounce.e=0.7: Bounce, one feature under two keys: the switch is the
// engine option restitution (an AvbdParams key, so it travels with the spec), bounce.e the e it then gives
// every surface (the viewer's own, as no engine has one); see bounceOn and ViewerConfig.bounce;
// level=L2: a Keystone level instead of a scenario, level.def=<base64url JSON>: a level of your own (level-file.ts),
// presettle=300: steps run before it shows, see ViewerConfig.level; rules=keystone: play the level by the game's
// rules, with keystone.hitstop=1 and keystone.slowmo=1 for its pace juice, see ViewerConfig.rules)
import { parseSpec } from '@tb/bench';
import type { BodyDesc, SceneDesc, Vec3 } from '@tb/engine-api';
import type { EngineKind, PaceFeel } from '@tb/game';
import { boundingRadius } from '@tb/geom';
import { AVBD_ITERATIONS, compileLevel, LEVELS, type LevelDef, PRESETTLE_STEPS } from '@tb/keystone';
import { type AvbdParams, froudeParams } from '@tb/physics-ref';
import { LOOKS, parseRealOptions, type RealOptions, writeRealOptions } from '@tb/render';
import { bounceBody, bounceScene, buildScenario, SCENARIOS } from '@tb/scenarios';
import { type CameraPose, DEFAULT_FRAMING, type Framing, FRAMING_LIMITS } from './camera.ts';
import { decodeLevelParam, encodeLevelParam } from './level-file.ts';
import { MAX_STEPS_LIMIT } from './loop.ts';
import { DEFAULT_PROJECTILE, parseProjectile, type Projectile, projectileShape, writeProjectile } from './projectile.ts';

export interface ViewerConfig {
  engine: string;
  /**
   * A Keystone level (L1 to L5, @tb/keystone LEVELS) to load instead of the scenario: its bodies,
   * materials, friction rule (min) and sleep, in metres (scale 1: its cubes are its unit, 0.5 m).
   * null: the scenario. While set, scenario, params and seed are unused (and kept, for the panel).
   */
  level: string | null;
  /**
   * A level of your own (URL key level.def, a file's scene.levelDef; level-file.ts) whose id is level,
   * loaded in place of the built-in level of that id if there is one; null: level is a built-in one.
   */
  customLevel: LevelDef | null;
  scenario: string;
  params: Record<string, number | boolean>;
  seed: number;
  sleep: boolean | null;
  /** Fire a ball automatically this many steps after the scene shows (after presettle; tests, demos); 0 = off. */
  autofire: number;
  /**
   * Steps run after a load or R before the scene shows, so stacks have settled into their
   * contacts (new AVBD contacts start soft: a Keystone tower drops tens of mm and springs back
   * over ~45 steps; @tb/keystone PRESETTLE_STEPS). In 1/60 s steps, times substeps like autofire.
   * Default defaultPresettle: a level's PRESETTLE_STEPS, as the game plays it; 0 for a scenario.
   */
  presettle: number;
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
  /** How a scene without a start camera is framed, and the field of view either way. */
  view: Framing;
  /**
   * sandbox (default): the scene as physics, fired at along the camera ray. keystone (a level only):
   * the game's rules, played as the game page plays them (@tb/game playKeystone): the rack fires from
   * the launcher ring, physics runs only while a shot is in play, and a session replays headless.
   * The level is played as the game builds it, so the keys that change its physics or stepping must
   * be at the level's defaults (keystoneEngine, checkKeystone); proj, cam and view are kept, unused.
   */
  rules: Rules;
  /** Keystone's pace juice (URL keys keystone.hitstop, keystone.slowmo: 0 or 1, rules=keystone only; both off by default, as in the game). */
  feel: PaceFeel;
  /**
   * Bounce's e (URL key bounce.e, 0 to 1, default DEFAULT_BOUNCE): while the engine spec
   * turns restitution on (bounceOn), every body, spawn and fired projectile and the ground
   * get this restitution (bounceScene), so under the scenes' combine rule (average) every
   * pair bounces at e. Off, the scene is the scenario's. Kept whether Bounce is on or not.
   */
  bounce: number;
}

/**
 * Bounce's default e. The scenarios' bodies and ground have restitution 0 and the fired
 * ball 0.1, so restitution on with nothing else bounces only the ball, at 0.05 under
 * average: next to nothing. 0.5 bounces visibly and stays in the range the reference was
 * checked for energy at (e <= 0.9; e = 1 is not energy-safe: physics-ref avbd.ts). What
 * it does to the default ball's shots, against Rapier: docs/plan.md, Restitution, Viewer.
 */
export const DEFAULT_BOUNCE = 0.5;

export const RULES = ['sandbox', 'keystone'] as const;
export type Rules = (typeof RULES)[number];

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

/** The scale a scenario runs at when the URL sets none; a level is in metres, so 1. */
export const defaultScale = (scenario: string, level: string | null = null) => (level ? 1 : SCENARIOS[scenario]?.scale ?? 1);

/** The Keystone level with this id (any case), or undefined. */
export const levelDef = (id: string): LevelDef | undefined => LEVELS.find((l) => l.id === id.toUpperCase());

/** Steps run before a scene shows when the URL sets none: a level's, as the game plays it; none for a scenario. */
export const defaultPresettle = (level: string | null) => (level ? PRESETTLE_STEPS : 0);
export const MAX_PRESETTLE = 6000;

/** How much faster than the unit world a world at this scale moves (speeds, in cube units per second). */
export const froudeSpeed = (scale: number) => 1 / Math.sqrt(scale);

export const DEFAULT_CONFIG: ViewerConfig = { engine: 'avbd-gpu', level: null, customLevel: null, scenario: 'S4', params: { N: 2000, F: 4, H: 12 }, seed: 1, sleep: null, autofire: 0, presettle: 0, offscreen: false, look: 'candy', real: {}, loop: 'free', pipeline: true, maxSteps: 1, projectile: DEFAULT_PROJECTILE, scale: 1, substeps: 1, camera: null, view: DEFAULT_FRAMING, bounce: DEFAULT_BOUNCE, rules: 'sandbox', feel: { hitStop: false, slowMo: false } };

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
  let level: string | null = null, customLevel: LevelDef | null = null;
  if (q.has('level') && q.has('level.def')) throw new Error('level and level.def both name the level: give one');
  if (q.has('level.def')) {
    customLevel = decodeLevelParam(q.get('level.def')!);
    level = customLevel.id;
  } else if (q.has('level')) {
    const def = levelDef(q.get('level')!);
    if (!def) throw new Error(`unknown level ${q.get('level')}; known: ${LEVELS.map((l) => l.id).join(', ')}`);
    level = def.id;
  }
  if (level && (q.has('scenario') || hasParams || q.has('seed'))) throw new Error('level takes no scenario, param.* or seed: the level is the scene');
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
  const scale = Number(q.get('scale') ?? defaultScale(scenario, level));
  if (!(scale >= SCALE_LIMITS[0] && scale <= SCALE_LIMITS[1])) throw new Error(`scale must be a number from ${SCALE_LIMITS[0]} to ${SCALE_LIMITS[1]} (metres per cube): ${q.get('scale')}`);
  const substeps = Number(q.get('substeps') ?? autoSubsteps(scale));
  if (!Number.isInteger(substeps) || substeps < 1 || substeps > MAX_SUBSTEPS) throw new Error(`substeps must be an integer from 1 to ${MAX_SUBSTEPS}: ${q.get('substeps')}`);
  const presettle = Number(q.get('presettle') ?? defaultPresettle(level));
  if (!Number.isInteger(presettle) || presettle < 0 || presettle > MAX_PRESETTLE) throw new Error(`presettle must be a whole number of steps from 0 to ${MAX_PRESETTLE}: ${q.get('presettle')}`);
  const bounce = Number(q.get('bounce.e') ?? DEFAULT_BOUNCE);
  if (!(bounce >= 0 && bounce <= 1) || q.get('bounce.e') === '') throw new Error(`bounce.e must be a number from 0 to 1: ${q.get('bounce.e')}`);
  const rules = (q.get('rules') ?? 'sandbox') as Rules;
  if (!RULES.includes(rules)) throw new Error(`rules must be ${RULES.join(' or ')}: ${q.get('rules')}`);
  const flag = (k: string) => {
    const v = q.get(k);
    if (v === null) return false;
    if (rules !== 'keystone') throw new Error(`${k} applies to rules=keystone`);
    if (v !== '0' && v !== '1') throw new Error(`${k} must be 0 or 1: ${v}`);
    return v === '1';
  };
  const feel: PaceFeel = { hitStop: flag('keystone.hitstop'), slowMo: flag('keystone.slowmo') };
  const c: ViewerConfig = {
    engine: q.get('engine') ?? DEFAULT_CONFIG.engine,
    level,
    customLevel,
    scenario,
    params: hasParams ? params : scenario === DEFAULT_CONFIG.scenario ? { ...DEFAULT_CONFIG.params } : {},
    seed: Number(q.get('seed') ?? 1),
    sleep: sleep === null ? null : sleep === '1' || sleep === 'true',
    autofire: Number(q.get('autofire') ?? 0),
    presettle,
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
    view: parseFraming(q),
    bounce,
    rules,
    feel,
  };
  if (rules === 'keystone') checkKeystone(c);
  return c;
}

/**
 * The game engine a spec names under rules=keystone: the GPU solver (at Keystone's iterations and
 * gapSlop, sized for the rack: @tb/game makeEngine) or Rapier, as the game page offers them.
 */
export function keystoneEngine(spec: string): EngineKind {
  const { name, options } = parseSpec(spec);
  if ((name !== 'avbd-gpu' && name !== 'rapier') || Object.keys(options).length) {
    throw new Error(`rules=keystone plays on the game's engines, engine=avbd-gpu (at Keystone's ${AVBD_ITERATIONS} iterations and gapSlop) or engine=rapier, with no options: not ${spec}`);
  }
  return name === 'rapier' ? 'rapier' : 'gpu';
}

/**
 * Throws unless c can be played by Keystone's rules as the game plays it: a level, a game engine
 * (keystoneEngine), and every key that changes its physics or stepping at the level's default.
 */
export function checkKeystone(c: ViewerConfig): void {
  if (!c.level) throw new Error('rules=keystone needs a level: level=L1 to L5, or level.def');
  keystoneEngine(c.engine);
  const off = Object.entries({
    scale: c.scale !== 1, substeps: c.substeps !== 1, presettle: c.presettle !== PRESETTLE_STEPS, sleep: c.sleep !== null,
    autofire: c.autofire !== 0, loop: c.loop !== DEFAULT_CONFIG.loop, pipeline: c.pipeline !== DEFAULT_CONFIG.pipeline, maxSteps: c.maxSteps !== DEFAULT_CONFIG.maxSteps,
  }).filter(([, v]) => v).map(([k]) => k);
  if (off.length) throw new Error(`rules=keystone plays the level as the game does, so ${off.join(', ')} must be left at the level's default`);
}

/** URL keys view.pitch, view.fit, view.fov (camera.ts Framing; degrees, multiple of a fit, degrees); absent ones are the defaults. */
export function parseFraming(q: URLSearchParams): Framing {
  const f = { ...DEFAULT_FRAMING };
  for (const k of Object.keys(f) as (keyof Framing)[]) {
    const raw = q.get(`view.${k}`);
    if (raw === null || raw === '') continue;
    const v = Number(raw), [lo, hi] = FRAMING_LIMITS[k];
    if (!(v >= lo && v <= hi)) throw new Error(`view.${k} must be a number from ${lo} to ${hi}: ${raw}`);
    f[k] = v;
  }
  return f;
}

export function writeFraming(f: Framing, q: URLSearchParams): void {
  for (const k of Object.keys(DEFAULT_FRAMING) as (keyof Framing)[]) if (f[k] !== DEFAULT_FRAMING[k]) q.set(`view.${k}`, String(f[k]));
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
  const q = new URLSearchParams(c.customLevel ? { 'level.def': encodeLevelParam(c.customLevel), engine: c.engine } : c.level ? { level: c.level, engine: c.engine } : { scenario: c.scenario, engine: c.engine });
  if (!c.level) {
    for (const [k, v] of Object.entries(c.params)) q.set(`param.${k}`, String(v));
    if (c.seed !== 1) q.set('seed', String(c.seed));
  }
  if (c.sleep !== null) q.set('sleep', c.sleep ? '1' : '0');
  if (c.autofire) q.set('autofire', String(c.autofire));
  if (c.presettle !== defaultPresettle(c.level)) q.set('presettle', String(c.presettle));
  if (c.offscreen) q.set('offscreen', '1');
  if (c.look !== DEFAULT_CONFIG.look) q.set('look', c.look);
  writeRealOptions(c.real, q);
  if (c.loop !== DEFAULT_CONFIG.loop) q.set('loop', c.loop);
  if (c.pipeline !== DEFAULT_CONFIG.pipeline) q.set('pipeline', c.pipeline ? '1' : '0');
  if (c.maxSteps !== DEFAULT_CONFIG.maxSteps) q.set('maxSteps', String(c.maxSteps));
  writeProjectile(c.projectile, q);
  if (c.scale !== defaultScale(c.scenario, c.level)) q.set('scale', String(c.scale));
  if (c.substeps !== autoSubsteps(c.scale)) q.set('substeps', String(c.substeps));
  if (c.camera) q.set('cam', writeCamera(c.camera));
  writeFraming(c.view, q);
  if (c.bounce !== DEFAULT_BOUNCE) q.set('bounce.e', String(c.bounce));
  if (c.rules !== DEFAULT_CONFIG.rules) q.set('rules', c.rules);
  if (c.feel.hitStop) q.set('keystone.hitstop', '1');
  if (c.feel.slowMo) q.set('keystone.slowmo', '1');
  return `?${q}`;
}

/**
 * A preset's search with how the viewer runs (engine, Bounce included, loop, pipeline,
 * substeps set by hand), the projectile, the look, the framing, Bounce's e and a chosen scale kept (a scale left
 * at the current scenario's default becomes the preset's default), which is
 * where its button takes you (framed afresh: no camera).
 */
export function presetSearch(preset: string, cur: Pick<ViewerConfig, 'engine' | 'loop' | 'pipeline' | 'maxSteps' | 'projectile'> & Partial<Pick<ViewerConfig, 'look' | 'real' | 'substeps' | 'scale' | 'scenario' | 'level' | 'view' | 'bounce'>>): string {
  const { engine, loop, pipeline, maxSteps, projectile, look = DEFAULT_CONFIG.look, real = {}, view = DEFAULT_CONFIG.view, bounce = DEFAULT_BOUNCE } = cur;
  const next = parseViewerConfig(preset);
  const chosen = cur.scale !== undefined && cur.scenario !== undefined && cur.scale !== defaultScale(cur.scenario, cur.level ?? null);
  const scale = chosen ? cur.scale! : next.scale;
  // Substeps set by hand stay; otherwise the new scale's own.
  const substeps = cur.substeps !== undefined && cur.substeps !== autoSubsteps(cur.scale ?? 1) ? cur.substeps : autoSubsteps(scale);
  return toSearch({ ...next, engine, loop, pipeline, maxSteps, projectile, look, real, substeps, scale, view, bounce });
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
 * world moves exactly as the unit world played faster; with restitution on,
 * its threshold (a speed) scaled by 1/sqrt(scale) too, which froudeParams
 * does only while the switch is on, so a spec without it gains no key.
 * Other engines get the stronger gravity alone.
 */
export function worldEngineSpec(spec: string, scale: number): string {
  const { name, options } = parseSpec(spec);
  if (scale === 1 || !AVBD_ENGINES.has(name)) return spec;
  const own = Object.fromEntries(FROUDE_KEYS.filter((k) => options[k] !== undefined).map((k) => [k, Number(options[k])])) as Partial<AvbdParams>;
  // The switch as the spec gives it: the engines take any truthy value as on, and froudeParams does too.
  if (options.restitution !== undefined) own.restitution = options.restitution as boolean;
  const scaled = froudeParams(own, 1 / scale);
  return FROUDE_KEYS.reduce((out, k) => (scaled[k] === undefined ? out : withOption(out, k, scaled[k] as number)), spec);
}
const FROUDE_KEYS = ['beta', 'penaltyMin', 'penaltyMax', 'maxAngularSpeed', 'restitutionThreshold'] as const;

/** GpuEngineOptions keys (bench's gpuEngineArgs): a scenario's avbd options with these go to avbd-gpu only. */
const GPU_OPTIONS: ReadonlySet<string> = new Set(['capacity', 'spare', 'pairsPerBody', 'maxRadius', 'colorTail', 'indirectColors', 'tailThreads', 'colorRounds', 'hessian', 'boxBroadphase']);

/**
 * The spec with the scenario's own AVBD options (ScenarioDef.avbd) under it: each one the spec
 * leaves unset, on the AVBD engines (GPU options on avbd-gpu only). Other engines' specs are unchanged.
 */
export function scenarioEngineSpec(spec: string, scenario: string): string {
  const { name, options } = parseSpec(spec);
  const own = SCENARIOS[scenario]?.avbd;
  if (!own || !AVBD_ENGINES.has(name)) return spec;
  return Object.entries(own).reduce((out, [k, v]) => (options[k] === undefined && (name === 'avbd-gpu' || !GPU_OPTIONS.has(k)) ? withOption(out, k, v) : out), spec);
}

/** The engines whose spec takes AvbdParams, restitution included. */
export const AVBD_ENGINES: ReadonlySet<string> = new Set(['avbd-gpu', 'avbd-ref']);

/**
 * Whether the spec turns restitution on (the panel's Bounce): an AVBD engine
 * whose restitution option is on (true; like the engines, any truthy value).
 */
export function bounceOn(spec: string): boolean {
  const { name, options } = parseSpec(spec);
  return AVBD_ENGINES.has(name) && !!options.restitution;
}

// bounceBody and bounceScene (the body and the scene at Bounce's e) live in @tb/scenarios, shared with bench runs (--bounce).
export { bounceBody, bounceScene };

/**
 * The scene a config runs: the scenario or the level (compileLevel's scene), at Bounce's e while
 * the engine spec turns restitution on (bounceOn; off, the scene's own bodies and
 * ground), in the world at the config's scale and substeps (worldScene),
 * with the config's sleep if it sets one.
 */
export function viewerScene(c: ViewerConfig): SceneDesc {
  const def = levelOf(c);
  const built = def ? compileLevel(def).scene : buildScenario(c.scenario, c.params, c.seed);
  const s = worldScene(bounceOn(c.engine) ? bounceScene(built, c.bounce) : built, c.scale, c.substeps);
  return c.sleep === null ? s : { ...s, sleep: c.sleep };
}

/** The level a config loads (its own or the built-in one), or null for a scenario. */
export const levelOf = (c: Pick<ViewerConfig, 'level' | 'customLevel'>): LevelDef | null => c.customLevel ?? (c.level ? levelDef(c.level) ?? null : null);

/** What the HUD calls the scene: the level's id and name (a level of your own says so), or the scenario's title. */
export const sceneTitle = (c: Pick<ViewerConfig, 'level' | 'customLevel' | 'scenario'>) => {
  const d = levelOf(c);
  return d ? `${d.id} ${d.name}${c.customLevel ? ' (custom)' : ''}` : SCENARIOS[c.scenario]!.title;
};

/** spec with one option set, or removed when value is undefined; the other options keep their order. */
export function withOption(spec: string, key: string, value: number | boolean | undefined): string {
  const { name, options } = parseSpec(spec);
  const o = { ...options };
  if (value === undefined) delete o[key];
  else o[key] = value;
  const kv = Object.entries(o).map(([k, v]) => `${k}=${v}`);
  return kv.length ? `${name}:${kv.join(',')}` : name;
}

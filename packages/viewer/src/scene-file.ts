// A viewer setup saved as JSON (the panel's Download / Load): the scene, the engine and how
// it is stepped, the projectile, the look, the camera and its framing. The file is self-contained: it
// lists every scenario param and every real-look knob, so a later change of defaults does not
// change a saved scene. Loading goes through the URL parser (parseViewerConfig), so a file
// and a URL accept exactly the same values; unknown keys are refused, so a typo in a
// hand-edited file is an error rather than a silently ignored setting.
import { engineNames, parseSpec } from '@tb/bench';
import { ENVS, GROUNDS, REAL_DEFAULTS, REAL_KNOBS, type RealKnob, type RealOptions, STONES } from '@tb/render';
import { SCENARIOS } from '@tb/scenarios';
import { type CameraPose, DEFAULT_FRAMING, type Framing } from './camera.ts';
import { parseViewerConfig, type ViewerConfig, writeCamera, writeFraming } from './params.ts';
import { DEFAULT_PROJECTILE, type Projectile } from './projectile.ts';

export const SCENE_FILE_FORMAT = 'tower-blaster/viewer-scene';
export const SCENE_FILE_VERSION = 1;

export interface SceneFile {
  format: typeof SCENE_FILE_FORMAT;
  version: typeof SCENE_FILE_VERSION;
  /** The name typed in the panel ('' when none). */
  name: string;
  /** ISO time it was saved; informational. */
  savedAt: string;
  /** sleep: null = the scenario's own setting; scale: metres per cube (ViewerConfig.scale; absent in older files: the scenario's default). */
  scene: { scenario: string; params: Record<string, number | boolean>; seed: number; sleep: boolean | null; scale: number };
  /** A @tb/bench engine spec, split up (avbd-gpu:iterations=20 is { name: 'avbd-gpu', options: { iterations: 20 } }). */
  engine: { name: string; options: Record<string, number | boolean | string> };
  /** substeps: physics steps per 1/60 s (absent in older files: 1). */
  loop: { mode: 'free' | 'frame'; pipeline: boolean; maxSteps: number; substeps: number };
  projectile: Projectile;
  /** Fire at the centre after this many steps; 0 = off. */
  autofire: number;
  /** real: every knob of the real look, kept whatever the preset. */
  look: { preset: string; real: RealOptions };
  /** Where the camera starts; null = framed to fit the scene. */
  camera: CameraPose | null;
  /** How the scene is framed without a camera, and the field of view (ViewerConfig.view; absent, as in files saved before it: today's DEFAULT_FRAMING, so their saved camera shows at 45 rather than 50 degrees). */
  view: Framing;
}

/** The file for a config, with the camera where it is now (null: framed to fit). */
export function sceneFile(c: ViewerConfig, name: string, camera: CameraPose | null, savedAt = new Date()): SceneFile {
  return {
    format: SCENE_FILE_FORMAT,
    version: SCENE_FILE_VERSION,
    name: name.trim(),
    savedAt: savedAt.toISOString(),
    scene: { scenario: c.scenario, params: { ...SCENARIOS[c.scenario]!.defaults, ...c.params }, seed: c.seed, sleep: c.sleep, scale: c.scale },
    engine: parseSpec(c.engine),
    loop: { mode: c.loop, pipeline: c.pipeline, maxSteps: c.maxSteps, substeps: c.substeps },
    projectile: { ...c.projectile },
    autofire: c.autofire,
    look: { preset: c.look, real: { ...REAL_DEFAULTS, ...c.real } },
    camera,
    view: { ...c.view },
  };
}

/** The download's file name: the name made safe, or the scenario and local time (S4-20261027-0130.json). */
export function sceneFileName(name: string, scenario: string, at = new Date()): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60);
  if (slug) return `${slug}.json`;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${scenario}-${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}.json`;
}

type Json = Record<string, unknown>;

/**
 * The config a file describes (offscreen off: that is the page's, not the scene's), its name,
 * or an error saying what is wrong. Real-look knobs equal to today's defaults are dropped, so
 * the URL stays as short as the panel keeps it.
 */
export function parseSceneFile(text: string): { config: ViewerConfig; name: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    throw new Error('not a JSON file');
  }
  const root = object(doc, 'the file');
  if (root.format !== SCENE_FILE_FORMAT) throw new Error(`not a tower-blaster viewer scene (format should be "${SCENE_FILE_FORMAT}")`);
  if (typeof root.version !== 'number' || root.version > SCENE_FILE_VERSION) throw new Error(`scene file version ${String(root.version)} is newer than this viewer reads (${SCENE_FILE_VERSION}); pull main`);
  if (root.version !== SCENE_FILE_VERSION) throw new Error(`unknown scene file version ${root.version}`);
  only(root, ['format', 'version', 'name', 'savedAt', 'scene', 'engine', 'loop', 'projectile', 'autofire', 'look', 'camera', 'view'], 'the file');
  const name = root.name === undefined ? '' : str(root.name, 'name');

  const q = new URLSearchParams();
  const scene = object(root.scene, 'scene');
  only(scene, ['scenario', 'params', 'seed', 'sleep', 'scale'], 'scene');
  const scenario = str(scene.scenario, 'scene.scenario').toUpperCase();
  const def = SCENARIOS[scenario];
  if (!def) throw new Error(`unknown scenario ${scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`);
  q.set('scenario', scenario);
  const params = object(scene.params ?? {}, 'scene.params');
  only(params, Object.keys(def.defaults), `scene.params (${scenario})`);
  for (const [k, v] of Object.entries(params)) q.set(`param.${k}`, String(typeof v === 'boolean' ? v : num(v, `scene.params.${k}`)));
  if (scene.seed !== undefined) q.set('seed', String(int(scene.seed, 'scene.seed')));
  if (scene.sleep !== undefined && scene.sleep !== null) q.set('sleep', bool(scene.sleep, 'scene.sleep') ? '1' : '0');
  if (scene.scale !== undefined) q.set('scale', String(num(scene.scale, 'scene.scale')));

  const engine = object(root.engine, 'engine');
  only(engine, ['name', 'options'], 'engine');
  const engineName = str(engine.name, 'engine.name');
  if (!engineNames().includes(engineName)) throw new Error(`unknown engine ${engineName}; known: ${engineNames().join(', ')}`);
  const options = Object.entries(object(engine.options ?? {}, 'engine.options')).map(([k, v]) => {
    if (!/^\w+$/.test(k)) throw new Error(`engine.options: bad option name "${k}"`);
    if (typeof v !== 'number' && typeof v !== 'boolean' && typeof v !== 'string') throw new Error(`engine.options.${k} must be a number, true, false or a word`);
    return `${k}=${v}`;
  });
  const spec = options.length ? `${engineName}:${options.join(',')}` : engineName;
  parseSpec(spec); // rejects a word where a number belongs, as a URL would
  q.set('engine', spec);

  if (root.loop !== undefined) {
    const loop = object(root.loop, 'loop');
    only(loop, ['mode', 'pipeline', 'maxSteps', 'substeps'], 'loop');
    if (loop.mode !== undefined) q.set('loop', str(loop.mode, 'loop.mode'));
    if (loop.pipeline !== undefined) q.set('pipeline', bool(loop.pipeline, 'loop.pipeline') ? '1' : '0');
    if (loop.maxSteps !== undefined) q.set('maxSteps', String(int(loop.maxSteps, 'loop.maxSteps')));
    if (loop.substeps !== undefined) q.set('substeps', String(int(loop.substeps, 'loop.substeps')));
  }

  if (root.projectile !== undefined) {
    const p = object(root.projectile, 'projectile');
    only(p, Object.keys(DEFAULT_PROJECTILE), 'projectile');
    if (p.shape !== undefined) q.set('proj', str(p.shape, 'projectile.shape'));
    for (const k of ['size', 'speed'] as const) if (p[k] !== undefined) q.set(`proj.${k}`, String(num(p[k], `projectile.${k}`)));
    if (p.mass !== undefined && p.mass !== null) q.set('proj.mass', String(num(p.mass, 'projectile.mass')));
  }
  if (root.autofire !== undefined) q.set('autofire', String(int(root.autofire, 'autofire')));

  if (root.look !== undefined) {
    const look = object(root.look, 'look');
    only(look, ['preset', 'real'], 'look');
    if (look.preset !== undefined) q.set('look', str(look.preset, 'look.preset'));
    const real = object(look.real ?? {}, 'look.real');
    only(real, Object.keys(REAL_DEFAULTS), 'look.real');
    for (const key of Object.keys(REAL_KNOBS) as RealKnob[]) {
      if (real[key] !== undefined && real[key] !== REAL_DEFAULTS[key]) q.set(`real.${key}`, String(num(real[key], `look.real.${key}`)));
    }
    if (real.stone !== undefined && real.stone !== REAL_DEFAULTS.stone) q.set('real.stone', oneOf(real.stone, STONES, 'look.real.stone'));
    if (real.groundMaterial !== undefined && real.groundMaterial !== REAL_DEFAULTS.groundMaterial) q.set('real.groundMaterial', oneOf(real.groundMaterial, GROUNDS, 'look.real.groundMaterial'));
    if (real.env !== undefined && real.env !== REAL_DEFAULTS.env) q.set('real.env', oneOf(real.env, ENVS, 'look.real.env'));
    if (real.groundAlbedo !== undefined) {
      const a = vec3(real.groundAlbedo, 'look.real.groundAlbedo');
      if (a.some((x, i) => x !== REAL_DEFAULTS.groundAlbedo[i])) q.set('real.ground', a.join(','));
    }
  }

  if (root.camera !== undefined && root.camera !== null) {
    const cam = object(root.camera, 'camera');
    only(cam, ['target', 'yaw', 'pitch', 'distance'], 'camera');
    const target = vec3(cam.target, 'camera.target');
    q.set('cam', writeCamera({ target, yaw: num(cam.yaw, 'camera.yaw'), pitch: num(cam.pitch, 'camera.pitch'), distance: num(cam.distance, 'camera.distance') }));
  }
  const view = object(root.view ?? {}, 'view');
  only(view, Object.keys(DEFAULT_FRAMING), 'view');
  writeFraming({ ...DEFAULT_FRAMING, ...Object.fromEntries(Object.entries(view).map(([k, v]) => [k, num(v, `view.${k}`)])) } as Framing, q);
  return { config: parseViewerConfig(`?${q}`), name };
}

function object(v: unknown, where: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where} must be an object`);
  return v as Json;
}
function only(o: Json, keys: string[], where: string) {
  const extra = Object.keys(o).filter((k) => !keys.includes(k));
  if (extra.length) throw new Error(`${where}: unknown ${extra.length > 1 ? 'keys' : 'key'} ${extra.join(', ')} (known: ${keys.join(', ')})`);
}
function str(v: unknown, where: string): string {
  if (typeof v !== 'string') throw new Error(`${where} must be a string`);
  return v;
}
function num(v: unknown, where: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${where} must be a number`);
  return v;
}
function int(v: unknown, where: string): number {
  if (!Number.isInteger(v)) throw new Error(`${where} must be an integer`);
  return v as number;
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} must be true or false`);
  return v;
}
function oneOf(v: unknown, known: readonly string[], where: string): string {
  if (typeof v !== 'string' || !known.includes(v)) throw new Error(`${where} must be one of ${known.join(', ')}`);
  return v;
}
function vec3(v: unknown, where: string): [number, number, number] {
  if (!Array.isArray(v) || v.length !== 3) throw new Error(`${where} must be three numbers`);
  return v.map((x, i) => num(x, `${where}[${i}]`)) as [number, number, number];
}

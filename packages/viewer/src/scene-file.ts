// A viewer setup saved as JSON (the panel's Download / Load): the scene (a scenario or a Keystone level; Bounce's e included), the
// engine (its options: Bounce is restitution) and how it is stepped, the projectile, the look, the
// camera and its framing, and the sound. The file is self-contained: it
// lists every scenario param and every real-look knob, so a later change of defaults does not
// change a saved scene. Loading goes through the URL parser (parseViewerConfig), so a file
// and a URL accept exactly the same values; unknown keys are refused, so a typo in a
// hand-edited file is an error rather than a silently ignored setting.
import { DEFAULT_SOUND, SOUND_KNOBS, type SoundKnob, type SoundOptions, writeSoundOptions } from '@tb/audio';
import { engineNames, parseSpec } from '@tb/bench';
import { ENVS, GROUNDS, TONE_MAPS, REAL_DEFAULTS, REAL_KNOBS, type RealKnob, type RealOptions, STONES } from '@tb/render';
import { SCENARIOS } from '@tb/scenarios';
import { type CameraPose, DEFAULT_FRAMING, type Framing } from './camera.ts';
import { isRackItem, type LevelDef, RACK_ITEM_NAMES, type RackItem, readShots, type Shot, writeShots } from '@tb/keystone';
import { encodeLevelParam, parseLevelDef } from './level-file.ts';
import { defaultFraming, parseViewerConfig, type ViewerConfig, writeCamera, writeFraming } from './params.ts';
import { checkWeapon, DEFAULT_GRENADE, type GrenadeSpec, isWeaponSpec, WEAPON_NAME, WEAPON_SPEC_VERSION, type WeaponSpec } from '@tb/weapons';
import { FEEL_OPTIONS, type LevelRules, type PaceFeel, writeLevelRules } from '@tb/game';
import { DEFAULT_PROJECTILE, parseGrenade, type Projectile, writeGrenade, writeProjectile } from './projectile.ts';

/** The feel options a scene file carries (those with a scene key), in their order. */
const SCENE_FEEL = FEEL_OPTIONS.filter((o) => o.scene);

/** A feel's scene-file keys: each option's value where it is off its default, or always if the option says so. */
function sceneFeel(f: PaceFeel): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const o of SCENE_FEEL) {
    const v = (f as Record<string, unknown>)[o.field];
    if (o.scene!.always || v !== o.default) out[o.scene!.key] = v;
  }
  return out;
}

export const SCENE_FILE_FORMAT = 'tower-blaster/viewer-scene';
export const SCENE_FILE_VERSION = 1;

export interface SceneFile {
  format: typeof SCENE_FILE_FORMAT;
  version: typeof SCENE_FILE_VERSION;
  /** The name typed in the panel ('' when none). */
  name: string;
  /** ISO time it was saved; informational. */
  savedAt: string;
  /**
   * sleep: null = the scenario's own setting; scale: metres per cube (ViewerConfig.scale; absent in older files: the scenario's default);
   * bounce: the e every surface gets while the engine's restitution option is on (ViewerConfig.bounce; absent in older files: DEFAULT_BOUNCE).
   * A level's scene has level (a Keystone level id, ViewerConfig.level) in place of scenario, params and seed,
   * or levelDef (a whole LevelDef, ViewerConfig.customLevel; level-file.ts) for a level of your own.
   */
  scene: ({ scenario: string; params: Record<string, number | boolean>; seed: number } | { level: string } | { levelDef: LevelDef }) & { sleep: boolean | null; scale: number; bounce: number };
  /** A @tb/bench engine spec, split up (avbd-gpu:iterations=20 is { name: 'avbd-gpu', options: { iterations: 20 } }; Bounce on is restitution: true). */
  engine: { name: string; options: Record<string, number | boolean | string> };
  /** substeps: physics steps per 1/60 s (absent in older files: 1); presettle: steps run before the scene shows (absent: the scene's default, defaultPresettle). */
  loop: { mode: 'free' | 'frame'; pipeline: boolean; maxSteps: number; substeps: number; presettle: number };
  /** shape, size, mass, speed, and weapon (absent: none) naming one of weapons. */
  projectile: Omit<Projectile, 'grenade' | 'spec'>;
  /**
   * The weapons a projectile can carry, by name, in cube units at scale 1: grenade (@tb/weapons
   * GrenadeSpec, listed whether fired or not; absent in older files: the default), and the fired
   * WeaponSpec under its name when the projectile carries one (a file may list more; proj.weapon
   * picks).
   */
  weapons: { grenade: GrenadeSpec } & { [name: string]: GrenadeSpec | WeaponSpec };
  /** Fire at the centre after this many steps; 0 = off. */
  autofire: number;
  /** real: every knob of the real look, kept whatever the preset. */
  look: { preset: string; real: RealOptions };
  /** Where the camera starts; null = framed to fit the scene. */
  camera: CameraPose | null;
  /**
   * Present only under Keystone's rules (ViewerConfig.rules, feel and shots: the line to play on load, rack: the rack played instead of the level's (ViewerConfig.rack),
   * absent for none; scoring, autobank, settle, freeze, levPoints and physics: the game's rule overrides, ViewerConfig.keystone,
   * absent when not overridden); absent: the sandbox.
   */
  rules?: { mode: 'keystone'; shots?: Shot[]; rack?: RackItem[]; /** The feel options with a scene key (@tb/game FEEL_OPTIONS: hitstop, slowmo, budget...). */ [feel: string]: unknown } & LevelRules;
  /** How the scene is framed without a camera, and the field of view (ViewerConfig.view; absent, as in files saved before it: today's DEFAULT_FRAMING, so their saved camera shows at 45 rather than 50 degrees). */
  view: Framing;
  /** Collision sound: on, material, set, room, space and every knob (absent in older files: off, the defaults; no set: real; no room: auto; no space: on). */
  sound?: SoundOptions;
}

/** The file for a config, with the camera where it is now (null: framed to fit). */
export function sceneFile(c: ViewerConfig, name: string, camera: CameraPose | null, savedAt = new Date()): SceneFile {
  return {
    format: SCENE_FILE_FORMAT,
    version: SCENE_FILE_VERSION,
    name: name.trim(),
    savedAt: savedAt.toISOString(),
    scene: { ...(c.customLevel ? { levelDef: c.customLevel } : c.level ? { level: c.level } : { scenario: c.scenario, params: { ...SCENARIOS[c.scenario]!.defaults, ...c.params }, seed: c.seed }), sleep: c.sleep, scale: c.scale, bounce: c.bounce },
    engine: parseSpec(c.engine),
    loop: { mode: c.loop, pipeline: c.pipeline, maxSteps: c.maxSteps, substeps: c.substeps, presettle: c.presettle },
    projectile: projectileOnly(c.projectile),
    weapons: { grenade: structuredClone(c.projectile.grenade ?? DEFAULT_GRENADE), ...(c.projectile.weapon && c.projectile.spec ? { [c.projectile.weapon]: structuredClone(c.projectile.spec) } : {}) },
    autofire: c.autofire,
    look: { preset: c.look, real: { ...REAL_DEFAULTS, ...c.real } },
    camera,
    view: { ...c.view },
    ...(c.rules === 'keystone' ? { rules: { mode: c.rules, ...sceneFeel(c.feel), ...(c.shots?.length ? { shots: c.shots.map((x) => ({ ...x })) } : {}), ...(c.rack ? { rack: [...c.rack] } : {}), ...structuredClone(c.keystone) } } : {}),
    sound: { ...c.sound },
  };
}

function projectileOnly({ grenade: _, spec: _s, ...p }: Projectile): Omit<Projectile, 'grenade' | 'spec'> {
  return p;
}

/** The download's file name: the name made safe, or the scenario (or level) and local time (S4-20261027-0130.json). */
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
  only(root, ['format', 'version', 'name', 'savedAt', 'scene', 'engine', 'loop', 'projectile', 'weapons', 'autofire', 'look', 'camera', 'view', 'rules', 'sound'], 'the file');
  const name = root.name === undefined ? '' : str(root.name, 'name');

  const q = new URLSearchParams();
  const scene = object(root.scene, 'scene');
  if (scene.levelDef !== undefined) {
    only(scene, ['levelDef', 'sleep', 'scale', 'bounce'], 'scene (a level of your own)');
    q.set('level.def', encodeLevelParam(parseLevelDef(scene.levelDef, 'scene.levelDef')));
  } else if (scene.level !== undefined) {
    // A level is the whole scene: the URL parser refuses a scenario, params or seed beside it.
    only(scene, ['level', 'sleep', 'scale', 'bounce'], 'scene (a level)');
    q.set('level', str(scene.level, 'scene.level'));
  } else {
    only(scene, ['scenario', 'params', 'seed', 'sleep', 'scale', 'bounce'], 'scene');
    const scenario = str(scene.scenario, 'scene.scenario').toUpperCase();
    const def = SCENARIOS[scenario];
    if (!def) throw new Error(`unknown scenario ${scenario}; known: ${Object.keys(SCENARIOS).join(', ')}`);
    q.set('scenario', scenario);
    const params = object(scene.params ?? {}, 'scene.params');
    only(params, Object.keys(def.defaults), `scene.params (${scenario})`);
    for (const [k, v] of Object.entries(params)) q.set(`param.${k}`, String(typeof v === 'boolean' ? v : num(v, `scene.params.${k}`)));
    if (scene.seed !== undefined) q.set('seed', String(int(scene.seed, 'scene.seed')));
  }
  if (scene.sleep !== undefined && scene.sleep !== null) q.set('sleep', bool(scene.sleep, 'scene.sleep') ? '1' : '0');
  if (scene.scale !== undefined) q.set('scale', String(num(scene.scale, 'scene.scale')));
  if (scene.bounce !== undefined) q.set('bounce.e', String(num(scene.bounce, 'scene.bounce')));

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
    only(loop, ['mode', 'pipeline', 'maxSteps', 'substeps', 'presettle'], 'loop');
    if (loop.mode !== undefined) q.set('loop', str(loop.mode, 'loop.mode'));
    if (loop.pipeline !== undefined) q.set('pipeline', bool(loop.pipeline, 'loop.pipeline') ? '1' : '0');
    if (loop.maxSteps !== undefined) q.set('maxSteps', String(int(loop.maxSteps, 'loop.maxSteps')));
    if (loop.substeps !== undefined) q.set('substeps', String(int(loop.substeps, 'loop.substeps')));
    if (loop.presettle !== undefined) q.set('presettle', String(int(loop.presettle, 'loop.presettle')));
  }

  if (root.projectile !== undefined) {
    const p = object(root.projectile, 'projectile');
    only(p, [...Object.keys(DEFAULT_PROJECTILE), 'preset', 'restitution', 'friction', 'blockDensity', 'weapon'], 'projectile');
    if (p.shape !== undefined) q.set('proj', str(p.shape, 'projectile.shape'));
    // A real thing (PROJECTILE_PRESETS) is a ball whose unset fields are its own.
    if (p.preset !== undefined) q.set('proj', str(p.preset, 'projectile.preset'));
    for (const k of ['size', 'speed', 'restitution', 'friction', 'blockDensity'] as const) if (p[k] !== undefined) q.set(`proj.${k}`, String(num(p[k], `projectile.${k}`)));
    if (p.mass !== undefined && p.mass !== null) q.set('proj.mass', String(num(p.mass, 'projectile.mass')));
    if (p.weapon !== undefined) q.set('proj.weapon', str(p.weapon, 'projectile.weapon'));
  }
  const wq = new URLSearchParams();
  if (root.weapons !== undefined) {
    const w = object(root.weapons, 'weapons');
    for (const [name, v] of Object.entries(w)) {
      if (name === 'grenade') continue;
      if (!WEAPON_NAME.test(name)) throw new Error(`weapons.${name}: weapon names match ${WEAPON_NAME}`);
      if (!isWeaponSpec(v)) throw new Error(`weapons.${name} must be a WeaponSpec (with version ${WEAPON_SPEC_VERSION}); only grenade has its own fields`);
      let spec: WeaponSpec;
      try {
        spec = checkWeapon({ ...v, name });
      } catch (e) {
        throw new Error(`weapons.${name}: ${e instanceof Error ? e.message : String(e)}`);
      }
      // Checked whether fired or not; the fired one goes into the config as a projectile would carry it.
      if (q.get('proj.weapon') === name) writeProjectile({ ...DEFAULT_PROJECTILE, weapon: name, spec }, wq);
    }
    for (const [k, v] of wq) q.set(k, v);
    if (w.grenade !== undefined) {
      const g = object(w.grenade, 'weapons.grenade');
      only(g, Object.keys(DEFAULT_GRENADE), 'weapons.grenade');
      const blast = object(g.blast ?? {}, 'weapons.grenade.blast');
      only(blast, Object.keys(DEFAULT_GRENADE.blast), 'weapons.grenade.blast');
      const gq = new URLSearchParams();
      if (g.fuse !== undefined) gq.set('grenade.fuse', str(g.fuse, 'weapons.grenade.fuse'));
      if (g.ground !== undefined) gq.set('grenade.ground', bool(g.ground, 'weapons.grenade.ground') ? '1' : '0');
      for (const k of ['delay', 'prox', 'arm'] as const) if (g[k] !== undefined) gq.set(`grenade.${k}`, String(num(g[k], `weapons.grenade.${k}`)));
      for (const [k, v] of Object.entries(blast)) gq.set(`grenade.${k}`, String(num(v, `weapons.grenade.blast.${k}`)));
      // Checked whether fired or not; only a grenade projectile carries it into the config.
      const spec = parseGrenade(gq);
      if (q.get('proj.weapon') === 'grenade') writeGrenade(spec, q);
    }
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
    if (real.toneMap !== undefined && real.toneMap !== REAL_DEFAULTS.toneMap) q.set('real.toneMap', oneOf(real.toneMap, TONE_MAPS, 'look.real.toneMap'));
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
  if (root.rules !== undefined) {
    const r = object(root.rules, 'rules');
    only(r, ['mode', ...SCENE_FEEL.map((o) => o.scene!.key), 'shots', 'rack', 'scoring', 'autobank', 'settle', 'freeze', 'levPoints', 'physics'], 'rules');
    q.set('rules', str(r.mode, 'rules.mode'));
    // Each feel option's scene key as its URL key (paceFeel checks the values).
    for (const o of SCENE_FEEL) {
      const v = r[o.scene!.key], at = `rules.${o.scene!.key}`;
      if (v !== undefined) q.set(o.url, o.write(o.scene!.json === 'boolean' ? bool(v, at) : o.scene!.json === 'number' ? num(v, at) : str(v, at)));
    }
    if (r.shots !== undefined) q.set('keystone.shots', shotsText(r.shots));
    // The rack as its URL key (rackOf checks the names against the level).
    if (r.rack !== undefined) {
      if (!Array.isArray(r.rack) || !r.rack.every((x) => typeof x === 'string')) throw new Error('rules.rack must be an array of rack item names');
      q.set('keystone.rack', r.rack.join(','));
    }
    // The game's rule overrides, as their URL keys (levelRules checks the values).
    const lr: LevelRules = {};
    if (r.scoring !== undefined) lr.scoring = str(r.scoring, 'rules.scoring') as LevelRules['scoring'];
    if (r.autobank !== undefined) lr.autobank = bool(r.autobank, 'rules.autobank');
    if (r.settle !== undefined) lr.settle = str(r.settle, 'rules.settle') as LevelRules['settle'];
    if (r.freeze !== undefined) lr.freeze = num(r.freeze, 'rules.freeze');
    if (r.levPoints !== undefined) lr.levPoints = str(r.levPoints, 'rules.levPoints') as LevelRules['levPoints'];
    if (r.physics !== undefined) {
      const ph = object(r.physics, 'rules.physics');
      only(ph, ['iterations', 'gapSlop', 'bounce', 'presettle', 'sleep'], 'rules.physics');
      lr.physics = {};
      if (ph.iterations !== undefined) lr.physics.iterations = num(ph.iterations, 'rules.physics.iterations');
      if (ph.gapSlop !== undefined) lr.physics.gapSlop = num(ph.gapSlop, 'rules.physics.gapSlop');
      if (ph.bounce !== undefined) lr.physics.bounce = ph.bounce === null ? null : num(ph.bounce, 'rules.physics.bounce');
      if (ph.presettle !== undefined) lr.physics.presettle = num(ph.presettle, 'rules.physics.presettle');
      if (ph.sleep !== undefined) lr.physics.sleep = bool(ph.sleep, 'rules.physics.sleep');
    }
    writeLevelRules(lr, q);
  }
  const view = object(root.view ?? {}, 'view');
  only(view, Object.keys(DEFAULT_FRAMING), 'view');
  // Keys a file lacks (older files: yaw and eye) are DEFAULT_FRAMING's, what they meant when saved; written against the scene's own default.
  const p = parseViewerConfig(`?${q}`);
  writeFraming({ ...DEFAULT_FRAMING, ...Object.fromEntries(Object.entries(view).map(([k, v]) => [k, num(v, `view.${k}`)])) } as Framing, q, defaultFraming(p.scenario, p.level));
  if (root.sound !== undefined) {
    const snd = object(root.sound, 'sound');
    only(snd, Object.keys(DEFAULT_SOUND), 'sound');
    const o = { ...DEFAULT_SOUND } as Record<string, unknown>;
    if (snd.on !== undefined) o.on = bool(snd.on, 'sound.on');
    if (snd.material !== undefined) o.material = str(snd.material, 'sound.material');
    if (snd.set !== undefined) o.set = str(snd.set, 'sound.set');
    if (snd.room !== undefined) o.room = str(snd.room, 'sound.room');
    if (snd.space !== undefined) o.space = bool(snd.space, 'sound.space');
    for (const k of Object.keys(SOUND_KNOBS) as SoundKnob[]) if (snd[k] !== undefined) o[k] = num(snd[k], `sound.${k}`);
    writeSoundOptions(o as unknown as SoundOptions, q); // the URL parser checks the ranges
  }
  return { config: parseViewerConfig(`?${q}`), name };
}

/** rules.shots as URL text: an array of shots, each with exactly its ammo's fields (readShots checks them). */
function shotsText(v: unknown): string {
  if (!Array.isArray(v) || v.length === 0) throw new Error('rules.shots must be a non-empty array of shots');
  const shots = v.map((x, i) => {
    const o = object(x, `rules.shots[${i}]`);
    if (typeof o.ammo !== 'string' || !isRackItem(o.ammo)) throw new Error(`rules.shots[${i}].ammo must be one of ${RACK_ITEM_NAMES}`);
    return o as unknown as Shot;
  });
  const text = writeShots(shots);
  let back: Shot[];
  try { back = readShots(text); } catch (e) { throw new Error(`rules.shots: ${(e as Error).message}`); }
  back.forEach((b, i) => only(shots[i] as unknown as Json, Object.keys(b), `rules.shots[${i}]`));
  return text;
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

// A Keystone level as data the viewer loads: a LevelDef (@tb/keystone level.ts)
// from a JSON file, a saved scene's scene.levelDef or the URL key level.def.
// The check is strict, as the scene file's is: unknown keys, wrong types and
// unknown materials, roles or ammo are errors naming where they are, so a typo
// in a hand-edited level is an error rather than a silently different level.
// Whether the level is any good (overlaps, unsupported bodies, tunnelling ammo)
// is validateLevel's question; the panel shows its issues without refusing.
import {
  type BuildDef, CATALOG_NAMES, checkPhysics, checkSettle, freezeProblem, checkShot, compileLevel, type CourseOverride, type Issue, type LevelDef, MATERIALS, type MaterialName, type Part, type PhysicsBlock, isRackItem, RACK_ITEM_NAMES, type RackItem, type Role, type RoleRule, ROLES, type ScenarioPart, SCORINGS, type Scoring, type Shot,
  STAR_METRICS, type StarMetric, type StarsDef, validateLevel,
} from '@tb/keystone';
import { SCENARIOS } from '@tb/scenarios';

export const LEVEL_FILE_FORMAT = 'tower-blaster/keystone-level';

type Json = Record<string, unknown>;
type V3 = [number, number, number];

const MATERIAL_NAMES = MATERIALS.map((m) => m.name) as readonly string[];

/** The LevelDef a JSON value describes, or an error saying where it is wrong. */
export function parseLevelDef(v: unknown, where = 'level'): LevelDef {
  const o = object(v, where);
  only(o, ['format', 'id', 'name', 'version', 'world', 'unit', 'gap', 'parts', 'lot', 'crownLine', 'objective', 'par', 'rack', 'launcher', 'lGold', 'solutions', 'scoring', 'stars', 'autobank', 'settle', 'freeze', 'physics', 'custom', 'build', 'charges', 'rube'], where);
  if (o.format !== undefined && o.format !== LEVEL_FILE_FORMAT) throw new Error(`${where}.format should be "${LEVEL_FILE_FORMAT}"`);
  const id = str(o.id, `${where}.id`);
  if (!/^[\w-]{1,32}$/.test(id)) throw new Error(`${where}.id must be 1 to 32 letters, digits, - or _`);
  const def: LevelDef = {
    id, name: str(o.name, `${where}.name`), version: int(o.version, `${where}.version`), world: int(o.world, `${where}.world`),
    parts: arr(o.parts, `${where}.parts`).map((p, i) => part(p, `${where}.parts[${i}]`)),
    lot: lot(o.lot, `${where}.lot`),
    crownLine: num(o.crownLine, `${where}.crownLine`),
    objective: objective(o.objective, `${where}.objective`),
    par: int(o.par, `${where}.par`),
    rack: arr(o.rack, `${where}.rack`).map((a, i) => rackItem(a, `${where}.rack[${i}]`)),
    launcher: launcher(o.launcher, `${where}.launcher`),
  };
  if (o.unit !== undefined) def.unit = positive(o.unit, `${where}.unit`);
  if (o.gap !== undefined) def.gap = num(o.gap, `${where}.gap`);
  if (o.lGold !== undefined) def.lGold = num(o.lGold, `${where}.lGold`);
  if (o.solutions !== undefined) {
    const s = object(o.solutions, `${where}.solutions`);
    only(s, ['par', 'ace'], `${where}.solutions`);
    def.solutions = {};
    for (const k of ['par', 'ace'] as const) if (s[k] !== undefined) def.solutions[k] = arr(s[k], `${where}.solutions.${k}`).map((x, i) => shot(x, `${where}.solutions.${k}[${i}]`));
  }
  if (o.scoring !== undefined) def.scoring = oneOf(o.scoring, SCORINGS, `${where}.scoring`) as Scoring;
  if (o.stars !== undefined) def.stars = stars(o.stars, `${where}.stars`);
  if (o.autobank !== undefined) def.autobank = bool(o.autobank, `${where}.autobank`);
  if (o.settle !== undefined) def.settle = checkSettle(o.settle, `${where}.settle`);
  if (o.freeze !== undefined) {
    const n = int(o.freeze, `${where}.freeze`), why = freezeProblem(n);
    if (why) throw new Error(`${where}.${why}`);
    def.freeze = n;
  }
  if (o.custom !== undefined) def.custom = bool(o.custom, `${where}.custom`);
  if (o.physics !== undefined) def.physics = physics(o.physics, `${where}.physics`);
  if (o.build !== undefined) def.build = build(o.build, `${where}.build`);
  if (o.charges !== undefined) def.charges = arr(o.charges, `${where}.charges`).map((c, i) => charge(c, `${where}.charges[${i}]`));
  if (o.rube !== undefined) {
    const r = object(o.rube, `${where}.rube`);
    only(r, ['partsPar'], `${where}.rube`);
    def.rube = { partsPar: int(r.partsPar, `${where}.rube.partsPar`) };
  }
  return def;
}

/** A charge on the structure (@tb/keystone ChargeDef), naming a built-in charge or a key of the level's weapons. */
function charge(v: unknown, where: string): NonNullable<LevelDef['charges']>[number] {
  const o = object(v, where);
  only(o, ['host', 'at', 'weapon', 'arm'], where);
  const c: NonNullable<LevelDef['charges']>[number] = { host: int(o.host, `${where}.host`), weapon: str(o.weapon, `${where}.weapon`) };
  if (o.at !== undefined) c.at = vec3(o.at, `${where}.at`);
  if (o.arm !== undefined) c.arm = oneOf(o.arm, ['plunger', 'start'], `${where}.arm`) as 'plunger' | 'start';
  return c;
}

/** An outcome level's cast thresholds (@tb/keystone StarsDef). */
function stars(v: unknown, where: string): StarsDef {
  const o = object(v, where);
  only(o, ['metric', 't2', 't3', 'best', 'castOn', 'engine', 'hash', 'n', 'seed'], where);
  const s: StarsDef = { metric: oneOf(o.metric, STAR_METRICS, `${where}.metric`) as StarMetric, t2: num(o.t2, `${where}.t2`), t3: num(o.t3, `${where}.t3`) };
  if (o.best !== undefined) s.best = num(o.best, `${where}.best`);
  for (const k of ['castOn', 'engine', 'hash'] as const) if (o[k] !== undefined) s[k] = str(o[k], `${where}.${k}`);
  for (const k of ['n', 'seed'] as const) if (o[k] !== undefined) s[k] = int(o[k], `${where}.${k}`);
  return s;
}

/** A level's physics block (@tb/keystone PhysicsBlock), ranges as checkPhysics. */
function physics(v: unknown, where: string): PhysicsBlock {
  const o = object(v, where);
  only(o, ['iterations', 'gapSlop', 'bounce', 'pairsPerBody', 'presettle'], where);
  const p: PhysicsBlock = {};
  for (const k of ['iterations', 'pairsPerBody', 'presettle'] as const) if (o[k] !== undefined) p[k] = int(o[k], `${where}.${k}`);
  if (o.gapSlop !== undefined) p.gapSlop = num(o.gapSlop, `${where}.gapSlop`);
  if (o.bounce !== undefined) p.bounce = o.bounce === null ? null : num(o.bounce, `${where}.bounce`);
  checkPhysics(p, where);
  return p;
}

/** A level's build rules (@tb/keystone BuildDef). */
function build(v: unknown, where: string): BuildDef {
  const o = object(v, where);
  only(o, ['budget', 'pieces', 'brush', 'material'], where);
  const b: BuildDef = {};
  if (o.budget !== undefined) {
    const n = int(o.budget, `${where}.budget`);
    if (n < 0) throw new Error(`${where}.budget must be 0 or more`);
    b.budget = n;
  }
  if (o.pieces !== undefined) b.pieces = arr(o.pieces, `${where}.pieces`).map((x, i) => oneOf(x, CATALOG_NAMES, `${where}.pieces[${i}]`));
  if (o.brush !== undefined) b.brush = bool(o.brush, `${where}.brush`);
  if (o.material !== undefined) b.material = oneOf(o.material, MATERIAL_NAMES, `${where}.material`) as MaterialName;
  return b;
}

function positiveHalf(v: unknown, where: string): V3 {
  const half = vec3(v, where);
  if (half.some((x) => !(x > 0))) throw new Error(`${where} must be three numbers above 0`);
  return half;
}

function part(v: unknown, where: string): Part {
  const o = object(v, where);
  const kind = oneOf(o.kind, ['block', 'slab', 'rod', 'scenario', 'piece', 'run', 'ball'], `${where}.kind`);
  if (kind === 'scenario') return scenarioPart(o, where);
  const material = oneOf(o.material, MATERIAL_NAMES, `${where}.material`) as MaterialName;
  const role = o.role === undefined ? undefined : (oneOf(o.role, ROLES, `${where}.role`) as Role);
  const placed = o.placed === undefined ? {} : o.placed === true ? { placed: true as const } : (() => { throw new Error(`${where}.placed must be true when given`); })();
  const pinned = o.pinned === undefined ? {} : o.pinned === true ? { pinned: true as const } : (() => { throw new Error(`${where}.pinned must be true when given`); })();
  if (kind === 'piece') {
    only(o, ['kind', 'at', 'half', 'yaw', 'tilt', 'pinned', 'material', 'role', 'placed'], where);
    return { kind, at: vec3(o.at, `${where}.at`), half: positiveHalf(o.half, `${where}.half`), ...(o.yaw !== undefined ? { yaw: num(o.yaw, `${where}.yaw`) } : {}), ...(o.tilt !== undefined ? { tilt: num(o.tilt, `${where}.tilt`) } : {}), ...pinned, material, ...(role ? { role } : {}), ...placed };
  }
  if (kind === 'ball') {
    only(o, ['kind', 'at', 'radius', 'pinned', 'material', 'role', 'placed'], where);
    return { kind, at: vec3(o.at, `${where}.at`), radius: positive(o.radius, `${where}.radius`), ...pinned, material, ...(role ? { role } : {}), ...placed };
  }
  if (kind === 'run') {
    only(o, ['kind', 'path', 'pitch', 'half', 'y', 'material', 'role', 'omit', 'placed'], where);
    const path = arr(o.path, `${where}.path`).map((x, i) => {
      const a = arr(x, `${where}.path[${i}]`);
      if (a.length !== 2) throw new Error(`${where}.path[${i}] must be two numbers (x, z)`);
      return [num(a[0], `${where}.path[${i}][0]`), num(a[1], `${where}.path[${i}][1]`)] as [number, number];
    });
    if (!path.length) throw new Error(`${where}.path must have at least one point`);
    const r: Part = { kind, path, pitch: positive(o.pitch, `${where}.pitch`), half: positiveHalf(o.half, `${where}.half`), material, ...(role ? { role } : {}), ...placed };
    if (o.y !== undefined) r.y = num(o.y, `${where}.y`);
    if (o.omit !== undefined) r.omit = arr(o.omit, `${where}.omit`).map((x, i) => int(x, `${where}.omit[${i}]`));
    return r;
  }
  if (kind === 'block') {
    only(o, ['kind', 'at', 'size', 'material', 'role', 'courses'], where);
    const size = vec3(o.size, `${where}.size`);
    if (size.some((x) => !Number.isInteger(x) || x < 1)) throw new Error(`${where}.size must be three whole numbers of cubes, each at least 1`);
    const p: Part = { kind, at: vec3(o.at, `${where}.at`), size, material, ...(role ? { role } : {}) };
    if (o.courses !== undefined) p.courses = arr(o.courses, `${where}.courses`).map((c, i) => course(c, `${where}.courses[${i}]`));
    return p;
  }
  only(o, ['kind', 'at', 'half', 'material', 'role'], where);
  const half = vec3(o.half, `${where}.half`);
  if (half.some((x) => !(x > 0))) throw new Error(`${where}.half must be three numbers above 0`);
  return { kind, at: vec3(o.at, `${where}.at`), half, material, ...(role ? { role } : {}) };
}

/** A scenario as a part (@tb/keystone ScenarioPart); its params are checked by building it, at compile. */
function scenarioPart(o: Json, where: string): ScenarioPart {
  only(o, ['kind', 'id', 'params', 'seed', 'at', 'material', 'role', 'roles', 'gap'], where);
  const p: ScenarioPart = { kind: 'scenario', id: oneOf(o.id, Object.keys(SCENARIOS), `${where}.id`), material: oneOf(o.material, MATERIAL_NAMES, `${where}.material`) as MaterialName };
  if (o.params !== undefined) {
    const params = object(o.params, `${where}.params`);
    for (const [k, x] of Object.entries(params)) if (typeof x !== 'boolean') num(x, `${where}.params.${k}`);
    p.params = params as Record<string, number | boolean>;
  }
  if (o.seed !== undefined) p.seed = int(o.seed, `${where}.seed`);
  if (o.at !== undefined) p.at = vec3(o.at, `${where}.at`);
  if (o.role !== undefined) p.role = oneOf(o.role, ROLES, `${where}.role`) as Role;
  if (o.gap !== undefined) p.gap = num(o.gap, `${where}.gap`);
  if (o.roles !== undefined) p.roles = arr(o.roles, `${where}.roles`).map((r, i) => roleRule(r, `${where}.roles[${i}]`));
  return p;
}

function roleRule(v: unknown, where: string): RoleRule {
  const o = object(v, where);
  only(o, ['role', 'box', 'course', 'top', 'tag'], where);
  const r: RoleRule = { role: oneOf(o.role, ROLES, `${where}.role`) as Role };
  if (o.box !== undefined) {
    const b = object(o.box, `${where}.box`);
    only(b, ['min', 'max'], `${where}.box`);
    r.box = { min: vec3(b.min, `${where}.box.min`), max: vec3(b.max, `${where}.box.max`) };
  }
  if (o.course !== undefined) {
    if (Array.isArray(o.course)) {
      if (o.course.length !== 2) throw new Error(`${where}.course must be a whole number or two of them`);
      r.course = [int(o.course[0], `${where}.course[0]`), int(o.course[1], `${where}.course[1]`)];
    } else r.course = int(o.course, `${where}.course`);
  }
  if (o.top !== undefined) r.top = bool(o.top, `${where}.top`);
  if (o.tag !== undefined) r.tag = Array.isArray(o.tag) ? o.tag.map((x, i) => int(x, `${where}.tag[${i}]`)) : int(o.tag, `${where}.tag`);
  return r;
}

function course(v: unknown, where: string): CourseOverride {
  const o = object(v, where);
  only(o, ['k', 'material', 'role', 'cells', 'omit'], where);
  const c: CourseOverride = { k: int(o.k, `${where}.k`) };
  if (o.material !== undefined) c.material = oneOf(o.material, MATERIAL_NAMES, `${where}.material`) as MaterialName;
  if (o.role !== undefined) c.role = oneOf(o.role, ROLES, `${where}.role`) as Role;
  if (o.cells !== undefined) c.cells = arr(o.cells, `${where}.cells`).map((x, i) => {
    const a = arr(x, `${where}.cells[${i}]`);
    if (a.length !== 2) throw new Error(`${where}.cells[${i}] must be two whole numbers`);
    return [int(a[0], `${where}.cells[${i}][0]`), int(a[1], `${where}.cells[${i}][1]`)] as [number, number];
  });
  if (o.omit !== undefined) c.omit = bool(o.omit, `${where}.omit`);
  return c;
}

function lot(v: unknown, where: string): LevelDef['lot'] {
  const o = object(v, where);
  only(o, ['min', 'max'], where);
  const two = (x: unknown, w: string) => {
    const a = arr(x, w);
    if (a.length !== 2) throw new Error(`${w} must be two numbers`);
    return [num(a[0], `${w}[0]`), num(a[1], `${w}[1]`)] as [number, number];
  };
  return { min: two(o.min, `${where}.min`), max: two(o.max, `${where}.max`) };
}

function objective(v: unknown, where: string): LevelDef['objective'] {
  const o = object(v, where);
  const kind = oneOf(o.kind, ['crowns', 'skyline', 'collapse', 'hold', 'bell'], `${where}.kind`);
  const footprint = o.footprintMax !== undefined ? { footprintMax: num(o.footprintMax, `${where}.footprintMax`) } : {};
  if (kind === 'crowns' || kind === 'hold') {
    only(o, ['kind', 'footprintMax'], where);
    return { kind, ...footprint };
  }
  if (kind === 'bell') {
    only(o, ['kind', 'region', 'moved', 'footprintMax'], where);
    const b: Extract<LevelDef['objective'], { kind: 'bell' }> = { kind, ...footprint };
    if (o.moved !== undefined) b.moved = positive(o.moved, `${where}.moved`);
    if (o.region !== undefined) {
      const r = object(o.region, `${where}.region`);
      only(r, ['min', 'max'], `${where}.region`);
      b.region = { min: vec3(r.min, `${where}.region.min`), max: vec3(r.max, `${where}.region.max`) };
    }
    return b;
  }
  if (kind === 'collapse') {
    only(o, ['kind', 'min', 'footprintMax'], where);
    const min = num(o.min, `${where}.min`);
    if (min < 0 || min > 1) throw new Error(`${where}.min must be from 0 to 1 (a collapse fraction)`);
    return { kind, min, ...footprint };
  }
  only(o, ['kind', 'maxH', 'footprintMax'], where);
  return { kind, maxH: num(o.maxH, `${where}.maxH`), ...footprint };
}

function rackItem(v: unknown, where: string): RackItem {
  if (typeof v !== 'string' || !isRackItem(v)) throw new Error(`${where} must be one of ${RACK_ITEM_NAMES}`);
  return v;
}

function launcher(v: unknown, where: string): LevelDef['launcher'] {
  const o = object(v, where);
  only(o, ['radius', 'y', 'dropY'], where);
  return { radius: positive(o.radius, `${where}.radius`), y: num(o.y, `${where}.y`), dropY: positive(o.dropY, `${where}.dropY`) };
}

function shot(v: unknown, where: string): Shot {
  const o = object(v, where);
  const ammo = rackItem(o.ammo, `${where}.ammo`);
  const keys = ammo === 'drop' ? ['x', 'z'] : ammo === 'cue' ? ['x', 'y', 'z', 'dir', 'power'] : ['az', 'y', 'yaw', 'pitch', 'power'];
  only(o, ['ammo', ...keys], where);
  const s = { ammo, ...Object.fromEntries(keys.map((k) => [k, int(o[k], `${where}.${k}`)])) } as Shot;
  try {
    checkShot(s);
  } catch (e) {
    throw new Error(`${where}: ${e instanceof Error ? e.message : String(e)}`);
  }
  return s;
}

/**
 * A level's static issues (validateLevel) after compiling it, or the compile's own error as one issue.
 * The viewer loads a level with issues (seeing it fail is the point of a testing ground) and shows them.
 */
export function levelIssues(def: LevelDef): Issue[] | Error {
  try {
    return validateLevel(compileLevel(def));
  } catch (e) {
    return e instanceof Error ? e : new Error(String(e));
  }
}

/** A level as the JSON a file holds (format first, then the def's own fields). */
export const levelJson = (def: LevelDef) => `${JSON.stringify({ format: LEVEL_FILE_FORMAT, ...def }, null, 2)}\n`;

/** The URL key level.def: the level's JSON, compact, as base64url (UTF-8), so a custom level is a link like any other setup. */
export function encodeLevelParam(def: LevelDef): string {
  const bytes = new TextEncoder().encode(JSON.stringify(def));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeLevelParam(raw: string): LevelDef {
  let text: string;
  try {
    const bin = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    text = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    throw new Error('level.def is not base64url-encoded UTF-8');
  }
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw new Error('level.def is not JSON');
  }
  return parseLevelDef(v, 'level.def');
}

function object(v: unknown, where: string): Json {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`${where} must be an object`);
  return v as Json;
}
function arr(v: unknown, where: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`${where} must be a list`);
  return v;
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
function positive(v: unknown, where: string): number {
  if (!(num(v, where) > 0)) throw new Error(`${where} must be above 0`);
  return v as number;
}
function int(v: unknown, where: string): number {
  if (!Number.isInteger(v)) throw new Error(`${where} must be a whole number`);
  return v as number;
}
function bool(v: unknown, where: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${where} must be true or false`);
  return v;
}
function oneOf<T extends string>(v: unknown, known: readonly T[], where: string): T {
  if (typeof v !== 'string' || !(known as readonly string[]).includes(v)) throw new Error(`${where} must be one of ${known.join(', ')}`);
  return v as T;
}
function vec3(v: unknown, where: string): V3 {
  const a = arr(v, where);
  if (a.length !== 3) throw new Error(`${where} must be three numbers`);
  return a.map((x, i) => num(x, `${where}[${i}]`)) as V3;
}

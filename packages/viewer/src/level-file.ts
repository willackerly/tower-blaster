// A Keystone level as data the viewer loads: a LevelDef (@tb/keystone level.ts)
// from a JSON file, a saved scene's scene.levelDef or the URL key level.def.
// The check is strict, as the scene file's is: unknown keys, wrong types and
// unknown materials, roles or ammo are errors naming where they are, so a typo
// in a hand-edited level is an error rather than a silently different level.
// Whether the level is any good (overlaps, unsupported bodies, tunnelling ammo)
// is validateLevel's question; the panel shows its issues without refusing.
import { AMMO_KINDS, type AmmoKind, checkShot, compileLevel, type CourseOverride, type Issue, type LevelDef, MATERIALS, type MaterialName, type Part, type Role, ROLES, type Shot, validateLevel } from '@tb/keystone';

export const LEVEL_FILE_FORMAT = 'tower-blaster/keystone-level';

type Json = Record<string, unknown>;
type V3 = [number, number, number];

const MATERIAL_NAMES = MATERIALS.map((m) => m.name) as readonly string[];

/** The LevelDef a JSON value describes, or an error saying where it is wrong. */
export function parseLevelDef(v: unknown, where = 'level'): LevelDef {
  const o = object(v, where);
  only(o, ['format', 'id', 'name', 'version', 'world', 'unit', 'gap', 'parts', 'lot', 'crownLine', 'objective', 'par', 'rack', 'launcher', 'lGold', 'solutions'], where);
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
    rack: arr(o.rack, `${where}.rack`).map((a, i) => oneOf(a, AMMO_KINDS, `${where}.rack[${i}]`) as AmmoKind),
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
  return def;
}

function part(v: unknown, where: string): Part {
  const o = object(v, where);
  const kind = oneOf(o.kind, ['block', 'slab', 'rod'], `${where}.kind`);
  const material = oneOf(o.material, MATERIAL_NAMES, `${where}.material`) as MaterialName;
  const role = o.role === undefined ? undefined : (oneOf(o.role, ROLES, `${where}.role`) as Role);
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
  const kind = oneOf(o.kind, ['crowns', 'skyline'], `${where}.kind`);
  if (kind === 'crowns') {
    only(o, ['kind'], where);
    return { kind };
  }
  only(o, ['kind', 'maxH', 'footprintMax'], where);
  return { kind, maxH: num(o.maxH, `${where}.maxH`), ...(o.footprintMax !== undefined ? { footprintMax: num(o.footprintMax, `${where}.footprintMax`) } : {}) };
}

function launcher(v: unknown, where: string): LevelDef['launcher'] {
  const o = object(v, where);
  only(o, ['radius', 'y', 'dropY'], where);
  return { radius: positive(o.radius, `${where}.radius`), y: num(o.y, `${where}.y`), dropY: positive(o.dropY, `${where}.dropY`) };
}

function shot(v: unknown, where: string): Shot {
  const o = object(v, where);
  const ammo = oneOf(o.ammo, AMMO_KINDS, `${where}.ammo`);
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

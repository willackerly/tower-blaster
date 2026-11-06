// WeaponSpec: a weapon as data (docs/design/weapons.md, plan step 4). A
// shell, rules of the form "when trigger, do actions", and named child
// munitions the actions split into, nested at most MAX_WEAPON_DEPTH deep
// with no references back up. Being a tree of bounded data, every weapon's
// worst case is countable before it is fired (weaponBudget): the GPU engine
// fixes its capacity at init, a replay needs the same numbers, and the game
// charges a weapon's yield as fired energy.
//
// Units are the world's: lengths in its length unit, speeds in units/s,
// times in s, impulses as engine-api Blast's (scaleWeapon converts, as the
// viewer's worldGrenade does for the grenade).
//
// Triggers (each a one-key object; a rule fires at most once, at the first
// step its trigger holds, and its actions apply in order at that step):
//   { after: s }                   s after the munition spawned (or, as the
//                                  second of a then, after the first held)
//   { near: m, arm?: s, ground? }  within m of another body's surface (or the
//                                  ground, unless ground is false; default
//                                  true), once arm s (default 0) have passed:
//                                  Grenades' proximity fuse
//   { apex: true }                 vertical speed <= 0 (the top of the arc;
//                                  at once for a shell thrown downwards)
//   { moved: m, speed?: v }        its centre (a charge's: its host's) at least
//                                  m from where it was in the first state
//                                  observed once its clock started, or moving
//                                  at least v (docs/design/charges.md)
//   { then: [a, b] }               b, with its clock started when a held
//   { any: [a, b, ...] }           the first of them to hold
// Actions:
//   { blast: { radius, impulse, falloff?, core?, maxDv?, maxSpeed?, offset? } }
//                                  engine-api Blast centred on the munition
//                                  (plus offset), not pushing it
//   { remove: true }               the munition is spent (engine-api RemoveEvent;
//                                  a charge: spent, no event)
//   { removeTarget: true }         a charge's host leaves the world (engine-api
//                                  RemoveEvent); a thrown munition has no target
//                                  (thrownProblems), so it is refused there
//   { split: { into, child, pattern?, angle?, spread?, at? } }
//                                  `into` of the named child, placed on a
//                                  pattern around the munition (ring, sphere or
//                                  cone; at: distance from its centre, default
//                                  its bounding radius) with its velocity plus
//                                  `spread` outward; the munition is removed
// An action after remove, removeTarget or split in the same rule is refused
// (there is nothing left to act on), as engines refuse a blast centred on a
// removed body.
//
// A charge (docs/design/charges.md) is a spec attached to a structure body, its
// host, with no body of its own (WeaponRuntime.attach): only after, moved, then
// and any triggers, and blast, remove and removeTarget actions (chargeProblems).
import type { ShapeDesc, Vec3 } from '@tb/engine-api';
import { boundingRadius } from '@tb/geom';
import { type GrenadeSpec, GRENADE_LIMITS } from './grenade.ts';

export const WEAPON_SPEC_VERSION = 1;
/** Root, children, grandchildren. */
export const MAX_WEAPON_DEPTH = 3;
/** Most bodies a weapon may spawn in all (its shell included): weaponBudget().bodies. */
export const MAX_WEAPON_BODIES = 256;
export const MAX_RULES = 8;
export const MAX_ACTIONS = 8;
/** Triggers nest (then, any) at most this deep. */
export const MAX_TRIGGER_DEPTH = 4;
export const MAX_ANY = 8;
export const MAX_SPLIT = 64;
/** Names of weapons and children: rack item `w-<name>`, safe in shot text. */
export const WEAPON_NAME = /^[a-z][a-z0-9]*$/;

/** The body a munition is: an engine-api shape and material; the root's launch speed range. */
export interface ShellSpec {
  shape: ShapeDesc;
  density: number;
  friction?: number;
  restitution?: number;
  /** Launch speed range [min, max], units/s: the root shell's (a child's comes from its split). */
  speed?: [number, number];
}

export type Trigger =
  | { after: number }
  | { near: number; arm?: number; ground?: boolean }
  | { apex: true }
  | { moved: number; speed?: number }
  | { then: [Trigger, Trigger] }
  | { any: Trigger[] };

/** engine-api Blast fields, centred on the munition (plus offset); unset ones take the engine's defaults. */
export interface BlastSpec {
  radius: number;
  impulse: number;
  falloff?: number;
  core?: number;
  maxDv?: number;
  maxSpeed?: number;
  offset?: Vec3;
}

export const SPLIT_PATTERNS = ['ring', 'sphere', 'cone'] as const;
export type SplitPattern = (typeof SPLIT_PATTERNS)[number];

export interface SplitSpec {
  into: number;
  /** A key of the splitting munition's children. */
  child: string;
  /** ring: horizontal circle; sphere: evenly over a sphere; cone: around the velocity (up when at rest). Default sphere. */
  pattern?: SplitPattern;
  /** cone: half angle, degrees (default 30). */
  angle?: number;
  /** Speed added outward along each child's direction, units/s (default 0). */
  spread?: number;
  /** Distance of each child's centre from the munition's, units (default the munition's bounding radius). */
  at?: number;
}

export type Action = { blast: BlastSpec } | { remove: true } | { removeTarget: true } | { split: SplitSpec };

export interface Rule {
  when: Trigger;
  do: Action[];
}

export interface MunitionSpec {
  shell: ShellSpec;
  rules: Rule[];
  children?: Record<string, MunitionSpec>;
}

export interface WeaponSpec extends MunitionSpec {
  version: typeof WEAPON_SPEC_VERSION;
  name?: string;
}

/** Whether a weapons-record entry is a WeaponSpec (it has `version`) rather than a GrenadeSpec. */
export function isWeaponSpec(x: unknown): x is WeaponSpec {
  return typeof x === 'object' && x !== null && 'version' in x;
}

export type WeaponIssueCode =
  | 'json' | 'version' | 'name' | 'key' | 'type' | 'range' | 'shape'
  | 'trigger' | 'action' | 'order' | 'child' | 'depth' | 'budget' | 'crowded'
  | 'unused-child' | 'never-spent' | 'charge' | 'target';

/**
 * A problem with a spec, at `path` (dotted, e.g. "children.star.rules.0.do.1").
 * Errors refuse the spec; warnings (unused-child, never-spent) do not.
 */
export interface WeaponIssue {
  code: WeaponIssueCode;
  level: 'error' | 'warn';
  path: string;
  message: string;
}

/** Accepted ranges (inclusive). */
export const WEAPON_LIMITS = {
  radius: [0.005, 20], half: [0.005, 20], density: [0.001, 1e5], friction: [0, 2], restitution: [0, 1], speed: [0, 500],
  after: [0, 60], near: [0, 20], arm: [0, 60], moved: [0.0001, 20],
  into: [1, MAX_SPLIT], angle: [0, 180], spread: [0, 500], at: [0, 20], offset: [-100, 100],
  blastRadius: GRENADE_LIMITS.radius, impulse: GRENADE_LIMITS.impulse, falloff: GRENADE_LIMITS.falloff, core: GRENADE_LIMITS.core,
  maxDv: GRENADE_LIMITS.maxDv, maxSpeed: GRENADE_LIMITS.maxSpeed,
} as const;

export class WeaponSpecError extends Error {
  constructor(readonly issues: WeaponIssue[]) {
    super(`bad weapon spec: ${issues.filter((i) => i.level === 'error').map((i) => `${i.path || '(root)'}: ${i.message} [${i.code}]`).join('; ')}`);
  }
}

type Obj = Record<string, unknown>;

/**
 * Checks `x` as a WeaponSpec. Returns the issues and, when there is no
 * error, the spec normalised: known keys only, in a fixed order, values as
 * written (defaults are not filled in), so writeWeapon(spec) is canonical.
 */
export function validateWeapon(x: unknown): { spec: WeaponSpec | null; issues: WeaponIssue[] } {
  const issues: WeaponIssue[] = [];
  const err = (code: WeaponIssueCode, path: string, message: string) => issues.push({ code, level: 'error', path, message });
  const warn = (code: WeaponIssueCode, path: string, message: string) => issues.push({ code, level: 'warn', path, message });
  const at = (path: string, k: string | number) => (path ? `${path}.${k}` : String(k));
  const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
  const keys = (o: Obj, path: string, allowed: readonly string[]) => {
    for (const k of Object.keys(o)) if (!allowed.includes(k)) err('key', at(path, k), `unknown key "${k}" (allowed: ${allowed.join(', ')})`);
  };
  const num = (v: unknown, path: string, [lo, hi]: readonly [number, number], int = false): number | undefined => {
    if (typeof v !== 'number' || !Number.isFinite(v)) { err('type', path, `must be a number, got ${JSON.stringify(v)}`); return undefined; }
    if (int && !Number.isInteger(v)) { err('range', path, `must be an integer, got ${v}`); return undefined; }
    if (v < lo || v > hi) { err('range', path, `must be from ${lo} to ${hi}, got ${v}`); return undefined; }
    return v;
  };
  const optNum = (o: Obj, k: string, path: string, range: readonly [number, number], int = false) => (o[k] === undefined ? undefined : num(o[k], at(path, k), range, int));

  const shape = (v: unknown, path: string): ShapeDesc | undefined => {
    if (!isObj(v)) { err('shape', path, 'must be { kind: "sphere", radius } or { kind: "box", half: [x, y, z] }'); return undefined; }
    if (v.kind === 'sphere') {
      keys(v, path, ['kind', 'radius']);
      const r = num(v.radius, at(path, 'radius'), WEAPON_LIMITS.radius);
      return r === undefined ? undefined : { kind: 'sphere', radius: r };
    }
    if (v.kind === 'box') {
      keys(v, path, ['kind', 'half']);
      if (!Array.isArray(v.half) || v.half.length !== 3) { err('shape', at(path, 'half'), 'must be 3 half extents'); return undefined; }
      const h = v.half.map((e, i) => num(e, at(at(path, 'half'), i), WEAPON_LIMITS.half));
      return h.every((e) => e !== undefined) ? { kind: 'box', half: h as Vec3 } : undefined;
    }
    err('shape', at(path, 'kind'), `must be "sphere" or "box", got ${JSON.stringify(v.kind)}`);
    return undefined;
  };

  const shell = (v: unknown, path: string, root: boolean): ShellSpec | undefined => {
    if (!isObj(v)) { err('type', path, 'must be an object { shape, density, friction?, restitution?, speed? }'); return undefined; }
    keys(v, path, ['shape', 'density', 'friction', 'restitution', 'speed']);
    const s = shape(v.shape, at(path, 'shape'));
    const density = num(v.density, at(path, 'density'), WEAPON_LIMITS.density);
    const friction = optNum(v, 'friction', path, WEAPON_LIMITS.friction), restitution = optNum(v, 'restitution', path, WEAPON_LIMITS.restitution);
    let speed: [number, number] | undefined;
    if (v.speed !== undefined) {
      if (!root) warn('key', at(path, 'speed'), "a child's speed comes from its split; this one is not used");
      if (!Array.isArray(v.speed) || v.speed.length !== 2) err('type', at(path, 'speed'), 'must be [min, max]');
      else {
        const lo = num(v.speed[0], at(at(path, 'speed'), 0), WEAPON_LIMITS.speed), hi = num(v.speed[1], at(at(path, 'speed'), 1), WEAPON_LIMITS.speed);
        if (lo !== undefined && hi !== undefined) {
          if (lo > hi) err('range', at(path, 'speed'), `min ${lo} is above max ${hi}`);
          else speed = [lo, hi];
        }
      }
    } else if (root) err('type', at(path, 'speed'), 'the root shell needs a launch speed range [min, max]');
    if (!s || density === undefined) return undefined;
    const out: ShellSpec = { shape: s, density };
    if (friction !== undefined) out.friction = friction;
    if (restitution !== undefined) out.restitution = restitution;
    if (speed && root) out.speed = speed;
    return out;
  };

  const trigger = (v: unknown, path: string, depth: number): Trigger | undefined => {
    if (depth > MAX_TRIGGER_DEPTH) { err('trigger', path, `triggers nest at most ${MAX_TRIGGER_DEPTH} deep`); return undefined; }
    const kinds = isObj(v) ? ['after', 'near', 'apex', 'moved', 'then', 'any'].filter((k) => k in v) : [];
    if (!isObj(v) || kinds.length !== 1) { err('trigger', path, 'must be one of { after }, { near, arm?, ground? }, { apex: true }, { moved, speed? }, { then: [a, b] }, { any: [...] }'); return undefined; }
    const kind = kinds[0]!;
    if (kind === 'after') {
      keys(v, path, ['after']);
      const s = num(v.after, at(path, 'after'), WEAPON_LIMITS.after);
      return s === undefined ? undefined : { after: s };
    }
    if (kind === 'near') {
      keys(v, path, ['near', 'arm', 'ground']);
      const d = num(v.near, at(path, 'near'), WEAPON_LIMITS.near), arm = optNum(v, 'arm', path, WEAPON_LIMITS.arm);
      if (v.ground !== undefined && typeof v.ground !== 'boolean') err('type', at(path, 'ground'), 'must be true or false');
      if (d === undefined) return undefined;
      const out: Trigger = { near: d };
      if (arm !== undefined) out.arm = arm;
      if (typeof v.ground === 'boolean') out.ground = v.ground;
      return out;
    }
    if (kind === 'moved') {
      keys(v, path, ['moved', 'speed']);
      const d = num(v.moved, at(path, 'moved'), WEAPON_LIMITS.moved), sp = optNum(v, 'speed', path, WEAPON_LIMITS.speed);
      if (d === undefined) return undefined;
      const out: Trigger = { moved: d };
      if (sp !== undefined) out.speed = sp;
      return out;
    }
    if (kind === 'apex') {
      keys(v, path, ['apex']);
      if (v.apex !== true) { err('trigger', at(path, 'apex'), 'must be true'); return undefined; }
      return { apex: true };
    }
    if (kind === 'then') {
      keys(v, path, ['then']);
      if (!Array.isArray(v.then) || v.then.length !== 2) { err('trigger', at(path, 'then'), 'must be [first, second]'); return undefined; }
      const a = trigger(v.then[0], at(at(path, 'then'), 0), depth + 1), b = trigger(v.then[1], at(at(path, 'then'), 1), depth + 1);
      return a && b ? { then: [a, b] } : undefined;
    }
    keys(v, path, ['any']);
    if (!Array.isArray(v.any) || v.any.length < 1 || v.any.length > MAX_ANY) { err('trigger', at(path, 'any'), `must list 1 to ${MAX_ANY} triggers`); return undefined; }
    const ts = v.any.map((t, i) => trigger(t, at(at(path, 'any'), i), depth + 1));
    return ts.every((t) => t !== undefined) ? { any: ts as Trigger[] } : undefined;
  };

  const blast = (v: unknown, path: string): BlastSpec | undefined => {
    if (!isObj(v)) { err('action', path, 'must be { radius, impulse, falloff?, core?, maxDv?, maxSpeed?, offset? }'); return undefined; }
    keys(v, path, ['radius', 'impulse', 'falloff', 'core', 'maxDv', 'maxSpeed', 'offset']);
    const radius = num(v.radius, at(path, 'radius'), WEAPON_LIMITS.blastRadius), impulse = num(v.impulse, at(path, 'impulse'), WEAPON_LIMITS.impulse);
    const falloff = optNum(v, 'falloff', path, WEAPON_LIMITS.falloff, true), core = optNum(v, 'core', path, WEAPON_LIMITS.core);
    const maxDv = optNum(v, 'maxDv', path, WEAPON_LIMITS.maxDv), maxSpeed = optNum(v, 'maxSpeed', path, WEAPON_LIMITS.maxSpeed);
    let offset: Vec3 | undefined;
    if (v.offset !== undefined) {
      if (!Array.isArray(v.offset) || v.offset.length !== 3) err('type', at(path, 'offset'), 'must be [x, y, z]');
      else {
        const o = v.offset.map((e, i) => num(e, at(at(path, 'offset'), i), WEAPON_LIMITS.offset));
        if (o.every((e) => e !== undefined)) offset = o as Vec3;
      }
    }
    if (radius === undefined || impulse === undefined) return undefined;
    const out: BlastSpec = { radius, impulse };
    if (falloff !== undefined) out.falloff = falloff;
    if (core !== undefined) out.core = core;
    if (maxDv !== undefined) out.maxDv = maxDv;
    if (maxSpeed !== undefined) out.maxSpeed = maxSpeed;
    if (offset) out.offset = offset;
    return out;
  };

  const split = (v: unknown, path: string, children: Obj | undefined): SplitSpec | undefined => {
    if (!isObj(v)) { err('action', path, 'must be { into, child, pattern?, angle?, spread?, at? }'); return undefined; }
    keys(v, path, ['into', 'child', 'pattern', 'angle', 'spread', 'at']);
    const into = num(v.into, at(path, 'into'), WEAPON_LIMITS.into, true);
    if (typeof v.child !== 'string' || !children || !(v.child in children)) { err('child', at(path, 'child'), `names no child of this munition: ${JSON.stringify(v.child)}`); return undefined; }
    if (v.pattern !== undefined && !SPLIT_PATTERNS.includes(v.pattern as SplitPattern)) err('range', at(path, 'pattern'), `must be one of ${SPLIT_PATTERNS.join(', ')}, got ${JSON.stringify(v.pattern)}`);
    const angle = optNum(v, 'angle', path, WEAPON_LIMITS.angle), spread = optNum(v, 'spread', path, WEAPON_LIMITS.spread), dist = optNum(v, 'at', path, WEAPON_LIMITS.at);
    if (into === undefined) return undefined;
    const out: SplitSpec = { into, child: v.child };
    if (SPLIT_PATTERNS.includes(v.pattern as SplitPattern)) out.pattern = v.pattern as SplitPattern;
    if (angle !== undefined) out.angle = angle;
    if (spread !== undefined) out.spread = spread;
    if (dist !== undefined) out.at = dist;
    return out;
  };

  const munition = (v: unknown, path: string, depth: number): MunitionSpec | undefined => {
    if (!isObj(v)) { err('type', path, 'must be an object { shell, rules, children? }'); return undefined; }
    const root = depth === 1;
    keys(v, path, root ? ['version', 'name', 'shell', 'rules', 'children'] : ['shell', 'rules', 'children']);
    const sh = shell(v.shell, at(path, 'shell'), root);
    let children: Record<string, MunitionSpec> | undefined;
    const used = new Set<string>();
    const rawChildren = v.children === undefined ? undefined : isObj(v.children) ? v.children : (err('type', at(path, 'children'), 'must be an object of named munitions'), undefined);
    if (rawChildren && Object.keys(rawChildren).length) {
      if (depth >= MAX_WEAPON_DEPTH) err('depth', at(path, 'children'), `munitions nest at most ${MAX_WEAPON_DEPTH} deep (root, children, grandchildren)`);
      else {
        children = {};
        for (const [name, c] of Object.entries(rawChildren)) {
          if (!WEAPON_NAME.test(name)) err('name', at(at(path, 'children'), name), `child names match ${WEAPON_NAME}`);
          const m = munition(c, at(at(path, 'children'), name), depth + 1);
          if (m) children[name] = m;
        }
      }
    }
    const rules: Rule[] = [];
    let spent = false;
    if (!Array.isArray(v.rules) || v.rules.length > MAX_RULES) err('type', at(path, 'rules'), `must list at most ${MAX_RULES} rules`);
    else {
      v.rules.forEach((r, ri) => {
        const rp = at(at(path, 'rules'), ri);
        if (!isObj(r)) { err('type', rp, 'must be { when, do }'); return; }
        keys(r, rp, ['when', 'do']);
        const when = trigger(r.when, at(rp, 'when'), 1);
        if (!Array.isArray(r.do) || r.do.length < 1 || r.do.length > MAX_ACTIONS) { err('action', at(rp, 'do'), `must list 1 to ${MAX_ACTIONS} actions`); return; }
        const acts: Action[] = [];
        let gone = false;
        r.do.forEach((a, ai) => {
          const ap = at(at(rp, 'do'), ai);
          const kinds = isObj(a) ? ['blast', 'remove', 'removeTarget', 'split'].filter((k) => k in a) : [];
          if (!isObj(a) || kinds.length !== 1 || Object.keys(a).length !== 1) { err('action', ap, 'must be one of { blast }, { remove: true }, { removeTarget: true }, { split }'); return; }
          if (gone) err('order', ap, 'comes after the munition was removed or split in this rule');
          if ('remove' in a) {
            if (a.remove !== true) err('action', at(ap, 'remove'), 'must be true');
            else acts.push({ remove: true });
            gone = true;
          } else if ('removeTarget' in a) {
            if (a.removeTarget !== true) err('action', at(ap, 'removeTarget'), 'must be true');
            else acts.push({ removeTarget: true });
            gone = true;
          } else if ('blast' in a) {
            const b = blast(a.blast, at(ap, 'blast'));
            if (b) acts.push({ blast: b });
          } else {
            const s = split(a.split, at(ap, 'split'), rawChildren);
            if (s) { acts.push({ split: s }); used.add(s.child); }
            gone = true;
          }
        });
        spent ||= gone;
        if (when && acts.length === r.do.length) rules.push({ when, do: acts });
      });
    }
    if (rawChildren) for (const name of Object.keys(rawChildren)) if (!used.has(name)) warn('unused-child', at(at(path, 'children'), name), 'no split names it');
    if (!spent && Array.isArray(v.rules)) warn('never-spent', at(path, 'rules'), 'no rule removes or splits the munition: it stays in the world');
    if (!sh || (Array.isArray(v.rules) && rules.length !== v.rules.length)) return undefined;
    const out: MunitionSpec = { shell: sh, rules };
    if (children) out.children = children;
    return out;
  };

  if (!isObj(x)) { err('type', '', 'a weapon spec is an object { version, name?, shell, rules, children? }'); return { spec: null, issues }; }
  if (x.version !== WEAPON_SPEC_VERSION) err('version', 'version', `must be ${WEAPON_SPEC_VERSION}, got ${JSON.stringify(x.version)}`);
  if (x.name !== undefined && (typeof x.name !== 'string' || !WEAPON_NAME.test(x.name))) err('name', 'name', `must match ${WEAPON_NAME}, got ${JSON.stringify(x.name)}`);
  const m = munition(x, '', 1);
  let spec: WeaponSpec | null = null;
  if (m && !issues.some((i) => i.level === 'error')) {
    spec = { version: WEAPON_SPEC_VERSION, ...(typeof x.name === 'string' ? { name: x.name } : {}), ...m };
    checkCrowding(spec, (path, message) => err('crowded', path, message));
    const b = weaponBudget(spec);
    if (b.bodies > MAX_WEAPON_BODIES) err('budget', '', `can spawn ${b.bodies} bodies in all, over the cap of ${MAX_WEAPON_BODIES}`);
    if (issues.some((i) => i.level === 'error')) spec = null;
  }
  return { spec, issues };
}

/** validateWeapon, throwing WeaponSpecError on any error. */
export function checkWeapon(x: unknown): WeaponSpec {
  const { spec, issues } = validateWeapon(x);
  if (!spec) throw new WeaponSpecError(issues);
  return spec;
}

/** A spec from JSON text (WeaponSpecError with code json on a syntax error). */
export function parseWeapon(text: string): WeaponSpec {
  let x: unknown;
  try {
    x = JSON.parse(text);
  } catch (e) {
    throw new WeaponSpecError([{ code: 'json', level: 'error', path: '', message: e instanceof Error ? e.message : String(e) }]);
  }
  return checkWeapon(x);
}

/** Canonical JSON text of a spec: parseWeapon(writeWeapon(s)) equals checkWeapon(s). */
export function writeWeapon(spec: WeaponSpec): string {
  return JSON.stringify(checkWeapon(spec), null, 2);
}

/** One munition of a weapon's tree: its path ('' the root, 'star', 'star.spark'), spec and depth. */
function* munitions(m: MunitionSpec, path = '', depth = 1): Generator<{ path: string; m: MunitionSpec; depth: number }> {
  yield { path, m, depth };
  for (const [name, c] of Object.entries(m.children ?? {})) yield* munitions(c, path ? `${path}.${name}` : name, depth + 1);
}

/** The static worst case of a weapon: every rule of every munition fires once (an upper bound). */
export interface WeaponBudget {
  /** Bodies it can spawn in all, its shell included: what an engine's capacity must hold for one shot. */
  bodies: number;
  /** Depth of its munition tree (1: no children). */
  depth: number;
  /** Each munition (path as in WeaponIssue, '' the root) and how many of it can exist. */
  munitions: { path: string; shell: ShellSpec; count: number }[];
  /** Each blast action and how many times it can go off: the rack's yield is sum count * Y(blast). */
  blasts: { path: string; blast: BlastSpec; count: number }[];
  /** How many removeTarget actions can go off in all (a charge's: each takes its host out). */
  targets: number;
}

export function weaponBudget(spec: MunitionSpec): WeaponBudget {
  const out: WeaponBudget = { bodies: 0, depth: 0, munitions: [], blasts: [], targets: 0 };
  const walk = (m: MunitionSpec, path: string, depth: number, count: number) => {
    out.bodies += count;
    out.depth = Math.max(out.depth, depth);
    out.munitions.push({ path, shell: m.shell, count });
    m.rules.forEach((r, ri) => r.do.forEach((a, ai) => {
      if ('blast' in a) out.blasts.push({ path: `${path ? `${path}.` : ''}rules.${ri}.do.${ai}`, blast: a.blast, count });
      if ('removeTarget' in a) out.targets += count;
    }));
    // Children in the order the spec lists them, each counted over every split naming it.
    for (const [name, c] of Object.entries(m.children ?? {})) {
      let n = 0;
      for (const r of m.rules) for (const a of r.do) if ('split' in a && a.split.child === name) n += a.split.into;
      if (n) walk(c, path ? `${path}.${name}` : name, depth + 1, count * n);
    }
  };
  walk(spec, '', 1, 1);
  return out;
}

/** Scale factors for scaleWeapon (each default 1). */
export interface WeaponScale {
  /** Shell sizes, near distances, split at, blast radius and offset. */
  length?: number;
  /** Shell launch speeds and split spreads. */
  speed?: number;
  density?: number;
  impulse?: number;
  maxDv?: number;
  maxSpeed?: number;
}

/** The spec in other units (not re-validated: the limits are for authored specs). */
export function scaleWeapon<T extends MunitionSpec>(spec: T, f: WeaponScale): T {
  const L = f.length ?? 1, V = f.speed ?? 1;
  const shape = (s: ShapeDesc): ShapeDesc => (s.kind === 'sphere' ? { kind: 'sphere', radius: s.radius * L } : { kind: 'box', half: [s.half[0] * L, s.half[1] * L, s.half[2] * L] });
  const trig = (t: Trigger): Trigger => {
    if ('near' in t) return { ...t, near: t.near * L };
    if ('moved' in t) return t.speed === undefined ? { moved: t.moved * L } : { moved: t.moved * L, speed: t.speed * V };
    if ('then' in t) return { then: [trig(t.then[0]), trig(t.then[1])] };
    if ('any' in t) return { any: t.any.map(trig) };
    return t;
  };
  const act = (a: Action): Action => {
    if ('blast' in a) {
      const b: BlastSpec = { ...a.blast, radius: a.blast.radius * L, impulse: a.blast.impulse * (f.impulse ?? 1) };
      if (b.maxDv !== undefined) b.maxDv *= f.maxDv ?? 1;
      if (b.maxSpeed !== undefined) b.maxSpeed *= f.maxSpeed ?? 1;
      if (b.offset) b.offset = [b.offset[0] * L, b.offset[1] * L, b.offset[2] * L];
      return { blast: b };
    }
    if ('split' in a) {
      const s: SplitSpec = { ...a.split };
      if (s.spread !== undefined) s.spread *= V;
      if (s.at !== undefined) s.at *= L;
      return { split: s };
    }
    return a;
  };
  const mun = (m: MunitionSpec): MunitionSpec => {
    const shell: ShellSpec = { ...m.shell, shape: shape(m.shell.shape), density: m.shell.density * (f.density ?? 1) };
    if (m.shell.speed) shell.speed = [m.shell.speed[0] * V, m.shell.speed[1] * V];
    const out: MunitionSpec = { shell, rules: m.rules.map((r) => ({ when: trig(r.when), do: r.do.map(act) })) };
    if (m.children) out.children = Object.fromEntries(Object.entries(m.children).map(([k, c]) => [k, mun(c)]));
    return out;
  };
  return { ...spec, ...mun(spec) };
}

/** Every trigger of a trigger tree, depth first. */
function* triggers(t: Trigger): Generator<Trigger> {
  yield t;
  if ('then' in t) { yield* triggers(t.then[0]); yield* triggers(t.then[1]); }
  if ('any' in t) for (const x of t.any) yield* triggers(x);
}

/**
 * Why a (valid) spec cannot be a charge (WeaponRuntime.attach; docs/design/charges.md): a charge
 * has no body of its own, so no near or apex trigger (its host touches its neighbours and rests),
 * no split and no children (it spawns nothing). Empty when it can.
 */
export function chargeProblems(spec: WeaponSpec): WeaponIssue[] {
  const out: WeaponIssue[] = [];
  const bad = (path: string, message: string) => out.push({ code: 'charge', level: 'error', path, message });
  if (spec.children && Object.keys(spec.children).length) bad('children', 'a charge spawns nothing, so it has no children');
  spec.rules.forEach((r, ri) => {
    for (const t of triggers(r.when)) {
      if ('near' in t) bad(`rules.${ri}.when`, 'a charge has no near trigger: its host always touches its neighbours');
      if ('apex' in t) bad(`rules.${ri}.when`, 'a charge has no apex trigger: its host is not flying');
    }
    r.do.forEach((a, ai) => { if ('split' in a) bad(`rules.${ri}.do.${ai}`, 'a charge cannot split: it has no body to break up'); });
  });
  return out;
}

/** Why a (valid) spec cannot be fired from the rack: removeTarget, since a thrown munition has no target. Empty when it can. */
export function thrownProblems(spec: WeaponSpec): WeaponIssue[] {
  const out: WeaponIssue[] = [];
  for (const { path, m } of munitions(spec)) {
    m.rules.forEach((r, ri) => r.do.forEach((a, ai) => {
      if ('removeTarget' in a) out.push({ code: 'target', level: 'error', path: `${path ? `${path}.` : ''}rules.${ri}.do.${ai}`, message: 'removeTarget needs a target, and only a charge has one (its host)' });
    }));
  }
  return out;
}

/** A grenade (GrenadeSpec) as a WeaponSpec with the given shell: the same fuse, blast and removal. */
export function grenadeAsSpec(g: GrenadeSpec, shell: ShellSpec, name = 'grenade'): WeaponSpec {
  const near: Trigger = { near: g.prox, arm: g.arm, ground: g.ground };
  const when: Trigger = g.fuse === 'timer' ? { after: g.delay } : g.fuse === 'prox' ? near : { then: [near, { after: g.delay }] };
  const blast: BlastSpec = { ...g.blast };
  return { version: WEAPON_SPEC_VERSION, name, shell, rules: [{ when, do: [{ blast }, { remove: true }] }] };
}


// Split patterns: unit directions from +, -, *, / and square roots only, so
// every machine places children identically (ECMAScript leaves the accuracy
// of Math.sin and Math.cos open, as it does Math.pow's).

/** cos and sin of x (|x| <= 2 pi), by range reduction to [-pi/4, pi/4] and fixed Taylor series. */
export function cosSin(x: number): [number, number] {
  const PI = 3.141592653589793, H = PI / 2;
  // x = q (pi/2) + r with |r| <= pi/4.
  const q = Math.round(x / H), r = x - q * H, r2 = r * r;
  // Horner forms of the series to r^17, well under an ulp on [-pi/4, pi/4].
  let c = 1, s = 1;
  for (let k = 16; k >= 2; k -= 2) c = 1 - (r2 / (k * (k - 1))) * c;
  for (let k = 17; k >= 3; k -= 2) s = 1 - (r2 / (k * (k - 1))) * s;
  s *= r;
  switch (((q % 4) + 4) % 4) {
    case 0: return [c, s];
    case 1: return [-s, c];
    case 2: return [-c, -s];
    default: return [s, -c];
  }
}

/**
 * The n unit directions of a split. ring: around +y in the horizontal plane;
 * sphere: a Fibonacci sphere; cone: n directions at `angle` degrees around
 * `axis` (unit; a single child goes along the axis).
 */
export function splitDirections(n: number, pattern: SplitPattern, angleDeg = 30, axis: Vec3 = [0, 1, 0]): Vec3[] {
  const TAU = 6.283185307179586, GOLDEN = 2.399963229728653;
  const out: Vec3[] = [];
  if (pattern === 'ring') {
    for (let i = 0; i < n; i++) {
      const [c, s] = cosSin((TAU * i) / n);
      out.push([c, 0, s]);
    }
    return out;
  }
  if (pattern === 'sphere') {
    for (let i = 0; i < n; i++) {
      const y = 1 - (2 * (i + 0.5)) / n, r = Math.sqrt(Math.max(0, 1 - y * y));
      const [c, s] = cosSin((GOLDEN * i) % TAU);
      out.push([r * c, y, r * s]);
    }
    return out;
  }
  // Cone: an orthonormal basis (u, w) across the axis.
  const [ax, ay, az] = axis;
  const t: Vec3 = Math.abs(ay) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let u: Vec3 = [ay * t[2] - az * t[1], az * t[0] - ax * t[2], ax * t[1] - ay * t[0]];
  const ul = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2]);
  u = [u[0] / ul, u[1] / ul, u[2] / ul];
  const w: Vec3 = [ay * u[2] - az * u[1], az * u[0] - ax * u[2], ax * u[1] - ay * u[0]];
  if (n === 1) return [[ax, ay, az]];
  const [ca, sa] = cosSin((angleDeg / 360) * TAU);
  for (let i = 0; i < n; i++) {
    const [c, s] = cosSin((TAU * i) / n);
    out.push([ca * ax + sa * (c * u[0] + s * w[0]), ca * ay + sa * (c * u[1] + s * w[1]), ca * az + sa * (c * u[2] + s * w[2])]);
  }
  return out;
}

/**
 * Refuses splits whose children would start overlapping each other: the
 * closest two child centres (at `at` from the parent's centre on the
 * pattern) must be at least two child bounding radii apart. A cone is
 * checked around +y; its spacing does not depend on the axis.
 */
function checkCrowding(spec: WeaponSpec, fail: (path: string, message: string) => void): void {
  for (const { path, m } of munitions(spec)) {
    m.rules.forEach((r, ri) => r.do.forEach((a, ai) => {
      if (!('split' in a)) return;
      const s = a.split, child = m.children![s.child]!;
      const dist = s.at ?? boundingRadius(m.shell.shape), cr = boundingRadius(child.shell.shape);
      const dirs = splitDirections(s.into, s.pattern ?? 'sphere', s.angle ?? 30);
      let gap = Infinity;
      for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
        const d = Math.hypot(dirs[i]![0] - dirs[j]![0], dirs[i]![1] - dirs[j]![1], dirs[i]![2] - dirs[j]![2]) * dist;
        gap = Math.min(gap, d);
      }
      if (gap < 2 * cr) fail(`${path ? `${path}.` : ''}rules.${ri}.do.${ai}.split`, `${s.into} of "${s.child}" (radius ${cr}) at ${dist} from the centre start ${gap.toFixed(4)} apart, closer than ${2 * cr}: raise at, or split into fewer`);
    }));
  }
}

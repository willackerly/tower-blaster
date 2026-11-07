// The weapon editor's model (docs/design/weapon-editor.md): a weapon being
// edited is a draft, plain JSON that need not be a valid WeaponSpec yet, and
// every edit is a pure function from draft to draft. validateWeapon judges a
// draft, its issues land on fields by path, and a draft with no error is the
// spec (validateWeapon's normalised one, which writeWeapon writes). No DOM
// here: the viewer's panel (and later the game's) draws these, and the tests
// drive them in Node.
//
// Paths. A munition is named by a dotted path ('' the shell, 'star' a child,
// 'star.spark' a grandchild: weaponBudget's and WeaponIssue's), and a field by
// a key path from the draft's root, e.g. ['children', 'star', 'rules', 0,
// 'do', 1, 'blast', 'radius'], whose join('.') is the validator's issue path.
import type { Action, MunitionSpec, SplitPattern, Trigger, WeaponIssue, WeaponSpec } from './spec.ts';
import { MAX_ACTIONS, MAX_ANY, MAX_RULES, MAX_WEAPON_DEPTH, SPLIT_PATTERNS, WEAPON_LIMITS, WEAPON_NAME, WEAPON_SPEC_VERSION } from './spec.ts';

/** A weapon being edited: JSON, valid or not. */
export type Draft = Record<string, unknown>;
export type KeyPath = readonly (string | number)[];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The value at `path` in `d`, or undefined. */
export function getAt(d: unknown, path: KeyPath): unknown {
  let v = d;
  for (const k of path) {
    if (Array.isArray(v) && typeof k === 'number') v = v[k];
    else if (isObj(v) && typeof k === 'string') v = v[k];
    else return undefined;
  }
  return v;
}

/**
 * `d` with `value` at `path` (a copy; `d` is untouched). undefined deletes an object key or
 * splices an array entry out. Missing objects on the way are made.
 */
export function setAt<T>(d: T, path: KeyPath, value: unknown): T {
  if (!path.length) return clone(value) as T;
  const out = clone(d) as unknown;
  let v = out as Record<string | number, unknown>;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    if (!isObj(v[k]) && !Array.isArray(v[k])) v[k] = typeof path[i + 1] === 'number' ? [] : {};
    v = v[k] as Record<string | number, unknown>;
  }
  const last = path[path.length - 1]!;
  if (value !== undefined) v[last] = clone(value);
  else if (Array.isArray(v) && typeof last === 'number') v.splice(last, 1);
  else delete v[last];
  return out as T;
}

/** The key path of munition `mun` ('' the shell, 'a.b' a grandchild). */
export const munitionKeys = (mun: string): (string | number)[] => (mun ? mun.split('.').flatMap((n) => ['children', n]) : []);

/** Every munition of the draft, shell first then depth first in listed order, with its depth (1 the shell). */
export function munitionList(d: Draft): { path: string; depth: number }[] {
  const out: { path: string; depth: number }[] = [];
  const walk = (m: unknown, path: string, depth: number) => {
    out.push({ path, depth });
    const c = isObj(m) && isObj(m.children) ? m.children : {};
    for (const name of Object.keys(c)) walk(c[name], path ? `${path}.${name}` : name, depth + 1);
  };
  walk(d, '', 1);
  return out;
}

export const TRIGGER_KINDS = ['after', 'near', 'apex', 'then', 'any'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];
export const ACTION_KINDS = ['blast', 'remove', 'split', 'thrust', 'vibrate'] as const;
export type ActionKind = (typeof ACTION_KINDS)[number];

export function triggerKind(t: unknown): TriggerKind | null {
  if (!isObj(t)) return null;
  const ks = TRIGGER_KINDS.filter((k) => k in t);
  return ks.length === 1 ? ks[0]! : null;
}

export function actionKind(a: unknown): ActionKind | null {
  if (!isObj(a)) return null;
  const ks = ACTION_KINDS.filter((k) => k in a);
  return ks.length === 1 ? ks[0]! : null;
}

/** A new trigger of a kind, with values to start from. */
export function defaultTrigger(kind: TriggerKind): Trigger {
  switch (kind) {
    case 'after': return { after: 1 };
    case 'near': return { near: 0.5, arm: 0.1 };
    case 'apex': return { apex: true };
    case 'then': return { then: [{ near: 0.5, arm: 0.1 }, { after: 0.5 }] };
    case 'any': return { any: [{ near: 0.5, arm: 0.1 }, { after: 4 }] };
  }
}

/** A new action of a kind; a split names `child` (the munition's first child when there is one). */
export function defaultAction(kind: ActionKind, child = ''): Action {
  switch (kind) {
    case 'blast': return { blast: { radius: 3, impulse: 20, core: 0.2 } };
    case 'remove': return { remove: true };
    case 'split': return { split: { into: 6, child, pattern: 'sphere', spread: 5, at: 1 } };
    case 'thrust': return { thrust: { accel: [0, 20, 0], for: 1 } };
    case 'vibrate': return { vibrate: { accel: [0, 0, 20], period: 0.2, for: 1 } };
  }
}

/** A new munition: a small ball that blows and is spent a second after it appears. */
export function defaultMunition(): MunitionSpec {
  return {
    shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 6 },
    rules: [{ when: { after: 1 }, do: [{ blast: { radius: 3, impulse: 20, core: 0.2 } }, { remove: true }] }],
  };
}

/** A new weapon to start from: one shell with a proximity fuse, a blast and its removal. */
export function newWeapon(name = 'custom'): WeaponSpec {
  return {
    version: WEAPON_SPEC_VERSION, name,
    shell: { shape: { kind: 'sphere', radius: 0.3 }, density: 8, speed: [5, 40] },
    rules: [{ when: { any: [{ near: 0.5, arm: 0.1 }, { after: 6 }] }, do: [{ blast: { radius: 4, impulse: 40, core: 0.2 } }, { remove: true }] }],
  };
}

const rulesOf = (d: Draft, mun: string): unknown[] => {
  const r = getAt(d, [...munitionKeys(mun), 'rules']);
  return Array.isArray(r) ? r : [];
};

/** A rule added to munition `mun` (at most MAX_RULES): after 1 s, remove it. */
export function addRule(d: Draft, mun: string): Draft {
  const rules = rulesOf(d, mun);
  if (rules.length >= MAX_RULES) return d;
  return setAt(d, [...munitionKeys(mun), 'rules', rules.length], { when: { after: 1 }, do: [{ remove: true }] });
}

/** An action of `kind` added to rule `rule` of munition `mun` (at most MAX_ACTIONS); one that does not spend it (blast, thrust, vibrate) goes before a spending one (remove, split) so the order stays valid. */
export function addAction(d: Draft, mun: string, rule: number, kind: ActionKind): Draft {
  const at = [...munitionKeys(mun), 'rules', rule, 'do'];
  const acts = getAt(d, at);
  const list = Array.isArray(acts) ? [...acts] : [];
  if (list.length >= MAX_ACTIONS) return d;
  const children = getAt(d, [...munitionKeys(mun), 'children']);
  const a = defaultAction(kind, isObj(children) ? Object.keys(children)[0] ?? '' : '');
  const spend = list.findIndex((x) => actionKind(x) === 'remove' || actionKind(x) === 'split');
  if (kind !== 'remove' && kind !== 'split' && spend >= 0) list.splice(spend, 0, a);
  else list.push(a);
  return setAt(d, at, list);
}

/** A trigger added to an any (at most MAX_ANY). */
export function addAnyTrigger(d: Draft, anyPath: KeyPath): Draft {
  const xs = getAt(d, [...anyPath, 'any']);
  if (!Array.isArray(xs) || xs.length >= MAX_ANY) return d;
  return setAt(d, [...anyPath, 'any', xs.length], { after: 1 });
}

/** The trigger at `path` changed to another kind (its old values dropped). */
export const setTriggerKind = (d: Draft, path: KeyPath, kind: TriggerKind): Draft => setAt(d, path, defaultTrigger(kind));

/** The action at `path` changed to another kind. */
export function setActionKind(d: Draft, mun: string, path: KeyPath, kind: ActionKind): Draft {
  const children = getAt(d, [...munitionKeys(mun), 'children']);
  return setAt(d, path, defaultAction(kind, isObj(children) ? Object.keys(children)[0] ?? '' : ''));
}

/** A free child name under `mun`: base, base2, base3, ... */
export function freeChildName(d: Draft, mun: string, base = 'part'): string {
  const c = getAt(d, [...munitionKeys(mun), 'children']);
  const taken = new Set(isObj(c) ? Object.keys(c) : []);
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
}

/**
 * A child added under `mun` (a default munition) and a split into it appended to the munition's first
 * rule that does not spend it yet, so the child is used at once; null when `mun` is already as deep
 * as munitions nest. Returns the draft and the child's path.
 */
export function addChild(d: Draft, mun: string, name = freeChildName(d, mun)): { draft: Draft; path: string } | null {
  const depth = mun ? mun.split('.').length + 1 : 1;
  if (depth >= MAX_WEAPON_DEPTH || !WEAPON_NAME.test(name)) return null;
  let out = setAt(d, [...munitionKeys(mun), 'children', name], defaultMunition());
  const rules = rulesOf(out, mun);
  const free = rules.findIndex((r) => isObj(r) && Array.isArray(r.do) && !r.do.some((a) => actionKind(a) === 'split' || actionKind(a) === 'remove'));
  const split = { split: { into: 6, child: name, pattern: 'sphere' as SplitPattern, spread: 5, at: 1 } };
  if (free >= 0) {
    const acts = getAt(out, [...munitionKeys(mun), 'rules', free, 'do']) as unknown[];
    out = setAt(out, [...munitionKeys(mun), 'rules', free, 'do', acts.length], split);
  } else if (rules.length < MAX_RULES) {
    // Every rule spends it already: a split stands in for the first spending action of the first rule.
    const r0 = rules[0];
    const acts = isObj(r0) && Array.isArray(r0.do) ? r0.do : null;
    const spend = acts ? acts.findIndex((a) => actionKind(a) === 'split' || actionKind(a) === 'remove') : -1;
    if (acts && spend >= 0 && actionKind(acts[spend]) === 'remove') out = setAt(out, [...munitionKeys(mun), 'rules', 0, 'do', spend], split);
  }
  return { draft: out, path: mun ? `${mun}.${name}` : name };
}

/** Child `from` of `mun` renamed `to` (keeping its place in the listing) and every split naming it; null for a bad or taken name. */
export function renameChild(d: Draft, mun: string, from: string, to: string): Draft | null {
  const keys = [...munitionKeys(mun), 'children'];
  const c = getAt(d, keys);
  if (!isObj(c) || !(from in c) || !WEAPON_NAME.test(to) || (to !== from && to in c)) return null;
  const renamed = Object.fromEntries(Object.entries(c).map(([k, v]) => [k === from ? to : k, v]));
  let out = setAt(d, keys, renamed);
  rulesOf(out, mun).forEach((r, ri) => {
    if (!isObj(r) || !Array.isArray(r.do)) return;
    r.do.forEach((a, ai) => {
      if (actionKind(a) === 'split' && isObj((a as Record<string, unknown>).split) && ((a as { split: { child: unknown } }).split.child === from)) {
        out = setAt(out, [...munitionKeys(mun), 'rules', ri, 'do', ai, 'split', 'child'], to);
      }
    });
  });
  return out;
}

/** Child `name` of `mun` removed, with the splits naming it (a rule left with no action goes too). */
export function removeChild(d: Draft, mun: string, name: string): Draft {
  let out = setAt(d, [...munitionKeys(mun), 'children', name], undefined);
  const c = getAt(out, [...munitionKeys(mun), 'children']);
  if (isObj(c) && !Object.keys(c).length) out = setAt(out, [...munitionKeys(mun), 'children'], undefined);
  const rules = rulesOf(out, mun).flatMap((r) => {
    if (!isObj(r) || !Array.isArray(r.do)) return [r];
    const acts = r.do.filter((a) => !(actionKind(a) === 'split' && isObj((a as Record<string, unknown>).split) && (a as { split: { child: unknown } }).split.child === name));
    return acts.length ? [{ ...r, do: acts }] : [];
  });
  return setAt(out, [...munitionKeys(mun), 'rules'], rules);
}

/** The issues whose path is `path` (exactly) or, with `within`, at or under it. */
export function issuesAt(issues: readonly WeaponIssue[], path: KeyPath, within = false): WeaponIssue[] {
  const p = path.join('.');
  return issues.filter((i) => i.path === p || (within && (p === '' || i.path.startsWith(`${p}.`))));
}

/** A number field of the form: its key, label, unit, the validator's range, and whether it may be left out. */
export interface NumberField {
  key: string;
  label: string;
  unit: string;
  range: readonly [number, number];
  optional: boolean;
  int?: boolean;
  /** Shown when left out: what the engine or runtime uses then. */
  fallback?: string;
}

const f = (key: string, label: string, unit: string, range: readonly [number, number], optional: boolean, extra: Partial<NumberField> = {}): NumberField => ({ key, label, unit, range, optional, ...extra });
const L = WEAPON_LIMITS;

/** Lengths are in the viewer's cube units (a scene cube's edge), speeds in units/s, as specs are written. */
export const SHELL_FIELDS: readonly NumberField[] = [
  f('density', 'density', 'kg/unit³', L.density, false),
  f('friction', 'friction', '', L.friction, true, { fallback: '0.5' }),
  f('restitution', 'bounce', '', L.restitution, true, { fallback: '0' }),
];
export const BLAST_FIELDS: readonly NumberField[] = [
  f('radius', 'radius', 'units', L.blastRadius, false),
  f('impulse', 'impulse', 'N s/unit²', L.impulse, false),
  f('core', 'core', 'of radius', L.core, true, { fallback: '0' }),
  f('falloff', 'falloff', 'power', L.falloff, true, { int: true, fallback: '1 (linear)' }),
  f('maxDv', 'max kick', 'units/s', L.maxDv, true, { fallback: '25' }),
  f('maxSpeed', 'max speed', 'units/s', L.maxSpeed, true, { fallback: '48' }),
];
export const SPLIT_FIELDS: readonly NumberField[] = [
  f('into', 'into', 'children', L.into, false, { int: true }),
  f('spread', 'spread', 'units/s', L.spread, true, { fallback: '0' }),
  f('at', 'at', 'units', L.at, true, { fallback: 'its radius' }),
  f('angle', 'cone angle', '°', L.angle, true, { fallback: '30' }),
];
export const TRIGGER_FIELDS: Readonly<Record<'after' | 'near', readonly NumberField[]>> = {
  after: [f('after', 'after', 's', L.after, false)],
  near: [f('near', 'within', 'units', L.near, false), f('arm', 'armed after', 's', L.arm, true, { fallback: '0' })],
};
export { SPLIT_PATTERNS };

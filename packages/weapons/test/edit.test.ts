// The weapon editor's model (edit.ts): edits are pure draft -> draft, a valid
// draft round-trips through the validator and writeWeapon unchanged (C12's
// verify: "editor round trips a WeaponSpec"), and the structural edits keep a
// valid weapon valid.
import { describe, expect, it } from 'vitest';
import {
  addAction, addAnyTrigger, addChild, addRule, BLAST_FIELDS, BUILTIN_WEAPONS, type Draft, FIREWORK, getAt, issuesAt, munitionKeys, munitionList,
  newWeapon, parseWeapon, removeChild, renameChild, setActionKind, setAt, setTriggerKind, SHELL_FIELDS, SPLIT_FIELDS, TRIGGER_FIELDS,
  TRIGGER_KINDS, validateWeapon, WEAPON_LIMITS, writeWeapon, type WeaponSpec,
} from '../src/index.ts';

const valid = (d: Draft): WeaponSpec => {
  const { spec, issues } = validateWeapon(d);
  if (!spec) throw new Error(issues.map((i) => `${i.path}: ${i.message}`).join('; '));
  return spec;
};

describe('weapon editor model', () => {
  it('round trips every built-in: draft -> spec -> text -> spec, unchanged', () => {
    for (const [name, spec] of Object.entries({ ...BUILTIN_WEAPONS, custom: newWeapon() })) {
      const draft = JSON.parse(JSON.stringify(spec)) as Draft;
      const text = writeWeapon(valid(draft));
      expect(parseWeapon(text), name).toEqual(valid(draft));
      expect(writeWeapon(parseWeapon(text)), name).toBe(text);
    }
  });

  it('setAt and getAt by key path, without touching the draft they are given', () => {
    const d = JSON.parse(JSON.stringify(FIREWORK)) as Draft;
    const path = [...munitionKeys('star'), 'rules', 0, 'do', 0, 'blast', 'radius'];
    expect(getAt(d, path)).toBe(3);
    const e = setAt(d, path, 4);
    expect(getAt(e, path)).toBe(4);
    expect(getAt(d, path)).toBe(3);
    // A field edit is the same edit as in the text.
    expect(valid(e)).toEqual(parseWeapon(writeWeapon(FIREWORK).replace('"radius": 3,', '"radius": 4,')));
    // undefined deletes a key (an optional field left out) or an array entry.
    expect(getAt(setAt(d, [...munitionKeys('star'), 'rules', 0, 'do', 0, 'blast', 'core'], undefined), [...munitionKeys('star'), 'rules', 0, 'do', 0, 'blast'])).toEqual({ radius: 3, impulse: 18.5 });
    expect((getAt(setAt(d, ['rules', 0, 'do', 0], undefined), ['rules', 0, 'do']) as unknown[]).length).toBe(0);
  });

  it('a field edit off its range is the validator\'s issue at that field', () => {
    const d = setAt(JSON.parse(JSON.stringify(FIREWORK)) as Draft, ['shell', 'density'], -1);
    const { spec, issues } = validateWeapon(d);
    expect(spec).toBeNull();
    expect(issuesAt(issues, ['shell', 'density']).map((i) => i.code)).toEqual(['range']);
    expect(issuesAt(issues, ['shell'], true)).toHaveLength(1);
    expect(issuesAt(issues, munitionKeys('star'), true)).toHaveLength(0);
  });

  it('lists munitions shell first, depth first', () => {
    let d = JSON.parse(JSON.stringify(FIREWORK)) as Draft;
    d = addChild(d, 'star', 'spark')!.draft;
    expect(munitionList(d)).toEqual([{ path: '', depth: 1 }, { path: 'star', depth: 2 }, { path: 'star.spark', depth: 3 }]);
    // No deeper than MAX_WEAPON_DEPTH.
    expect(addChild(d, 'star.spark')).toBeNull();
  });

  it('adding a child splits into it at once, and the weapon stays valid', () => {
    const r = addChild(newWeapon() as unknown as Draft, '')!;
    expect(r.path).toBe('part');
    const spec = valid(r.draft);
    // The shell's remove became a split into the new child (a split removes it too).
    expect(spec.rules[0]!.do.map((a) => Object.keys(a)[0])).toEqual(['blast', 'split']);
    expect(Object.keys(spec.children!)).toEqual(['part']);
    expect(validateWeapon(r.draft).issues.filter((i) => i.level === 'warn')).toEqual([]);
    expect(addChild(r.draft, '')!.path).toBe('part2');
  });

  it('renaming a child renames every split naming it and keeps its place', () => {
    let d = addChild(JSON.parse(JSON.stringify(FIREWORK)) as Draft, '', 'dud')!.draft;
    d = renameChild(d, '', 'star', 'comet')!;
    const spec = valid(d);
    expect(Object.keys(spec.children!)).toEqual(['comet', 'dud']);
    expect(spec.rules[0]!.do[0]).toMatchObject({ split: { child: 'comet' } });
    expect(renameChild(d, '', 'comet', 'dud')).toBeNull();
    expect(renameChild(d, '', 'comet', 'Bad')).toBeNull();
  });

  it('removing a child removes its splits, and a rule left empty', () => {
    const d = removeChild(JSON.parse(JSON.stringify(FIREWORK)) as Draft, '', 'star');
    expect(getAt(d, ['children'])).toBeUndefined();
    expect(getAt(d, ['rules'])).toEqual([]);
    // Valid, with the warning that nothing spends the shell now.
    expect(validateWeapon(d).issues.map((i) => i.code)).toEqual(['never-spent']);
  });

  it('rules, actions and trigger kinds: each default is valid where it lands', () => {
    let d = newWeapon() as unknown as Draft;
    d = addRule(d, '');
    valid(d);
    for (const k of TRIGGER_KINDS) valid(setTriggerKind(d, ['rules', 1, 'when'], k));
    d = addAction(d, '', 0, 'blast');
    // A blast goes in before the spending action, so the order stays valid.
    expect(valid(d).rules[0]!.do.map((a) => Object.keys(a)[0])).toEqual(['blast', 'blast', 'remove']);
    // So do a thrust and a vibration (they do not spend it either).
    const forced = addAction(addAction(d, '', 0, 'thrust'), '', 0, 'vibrate');
    expect(valid(forced).rules[0]!.do.map((a) => Object.keys(a)[0])).toEqual(['blast', 'blast', 'thrust', 'vibrate', 'remove']);
    d = setTriggerKind(d, ['rules', 0, 'when'], 'any');
    d = addAnyTrigger(d, ['rules', 0, 'when']);
    expect((getAt(d, ['rules', 0, 'when', 'any']) as unknown[]).length).toBe(3);
    valid(d);
    // A split needs a child: with none it is the validator's child issue.
    const s = setActionKind(d, '', ['rules', 1, 'do', 0], 'split');
    expect(validateWeapon(s).issues.some((i) => i.code === 'child')).toBe(true);
  });

  it('every form field\'s range is the validator\'s', () => {
    const L = WEAPON_LIMITS as Record<string, readonly [number, number]>;
    const by: Record<string, string> = { radius: 'blastRadius' };
    for (const f of BLAST_FIELDS) expect(f.range, f.key).toEqual(L[by[f.key] ?? f.key]);
    for (const f of [...SHELL_FIELDS, ...SPLIT_FIELDS, ...TRIGGER_FIELDS.after, ...TRIGGER_FIELDS.near]) expect(f.range, f.key).toEqual(L[f.key]);
  });
});

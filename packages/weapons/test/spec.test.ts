// WeaponSpec (spec.ts): canonical round trips, every issue code on a crafted
// spec (and not on its fixed twin), the static budget, unit scaling, and the
// machine-independent split patterns.
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_CHARGES, BUILTIN_WEAPONS, chargeProblems, checkWeapon, cosSin, DEFAULT_GRENADE, GRENADE_WEAPON, grenadeAsSpec, isWeaponSpec, MAX_WEAPON_BODIES, parseWeapon, scaleWeapon,
  splitDirections, thrownProblems, validateWeapon, type WeaponIssueCode, type WeaponSpec, WeaponSpecError, weaponBudget, writeWeapon,
} from '../src/index.ts';

const BALL = (r: number) => ({ kind: 'sphere' as const, radius: r });

/** The design write-up's firework: apex or 2 s, split into 8 stars; each star bursts into 4 sparks on contact; sparks fizzle. */
const FIREWORK: WeaponSpec = {
  version: 1, name: 'firework',
  shell: { shape: BALL(0.4), density: 4, speed: [20, 35] },
  rules: [{ when: { any: [{ apex: true }, { after: 2 }] }, do: [{ split: { into: 8, child: 'star', pattern: 'cone', angle: 40, spread: 12, at: 0.9 } }] }],
  children: {
    star: {
      shell: { shape: BALL(0.2), density: 4 },
      rules: [
        { when: { near: 0.05, arm: 0.2 }, do: [{ blast: { radius: 1.5, impulse: 6 } }, { split: { into: 4, child: 'spark', pattern: 'ring', spread: 3 } }] },
        { when: { after: 4 }, do: [{ remove: true }] },
      ],
      children: { spark: { shell: { shape: BALL(0.05), density: 2 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 0.5, impulse: 1, falloff: 2 } }, { remove: true }] }] } },
    },
  },
};

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const codes = (x: unknown, level: 'error' | 'warn' = 'error') => validateWeapon(x).issues.filter((i) => i.level === level).map((i) => i.code);

describe('WeaponSpec format', () => {
  it('round trips: parse(write(spec)) is the spec, and write is canonical (fixed key order, idempotent)', () => {
    for (const spec of [FIREWORK, GRENADE_WEAPON, grenadeAsSpec({ ...DEFAULT_GRENADE, fuse: 'proxTimer' }, { shape: { kind: 'box', half: [0.1, 0.2, 0.3] }, density: 3, friction: 0.4, restitution: 0.2, speed: [1, 2] })]) {
      expect(validateWeapon(spec).issues).toEqual([]);
      const text = writeWeapon(spec);
      expect(parseWeapon(text)).toEqual(spec);
      expect(writeWeapon(parseWeapon(text))).toBe(text);
      // Key order does not matter on input; the output order is fixed.
      const shuffled = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
      expect(writeWeapon(checkWeapon(shuffled))).toBe(text);
    }
  });

  it('the built-in weapons are clean specs (no issue at all), named as their keys, within budget', () => {
    for (const [name, spec] of Object.entries(BUILTIN_WEAPONS)) {
      expect(validateWeapon(spec).issues, name).toEqual([]);
      expect(spec.name).toBe(name);
    }
    expect(validateWeapon(GRENADE_WEAPON).issues).toEqual([]);
    // The built-in charges: clean, chargeable, and refused in the rack (they removeTarget, or are spent at once).
    for (const [name, spec] of Object.entries(BUILTIN_CHARGES)) {
      expect(validateWeapon(spec).issues, name).toEqual([]);
      expect(chargeProblems(spec), name).toEqual([]);
      expect(spec.name).toBe(name);
      expect(Object.hasOwn(BUILTIN_WEAPONS, name), name).toBe(false);
    }
    expect(Object.fromEntries(Object.entries(BUILTIN_WEAPONS).map(([k, s]) => [k, weaponBudget(s).bodies]))).toEqual({ firework: 13, cluster: 7, grenades: 1, grenadem: 1, grenadel: 1, grenadexl: 1 });
  });

  it('a weapons record tells a WeaponSpec (version) from a GrenadeSpec', () => {
    expect(isWeaponSpec(FIREWORK)).toBe(true);
    expect(isWeaponSpec(DEFAULT_GRENADE)).toBe(false);
    expect(isWeaponSpec(null)).toBe(false);
  });

  it('a grenade as a spec: its fuse as the trigger, then its blast and removal', () => {
    const shell = { shape: BALL(0.2), density: 8, speed: [5, 40] as [number, number] };
    const near = { near: DEFAULT_GRENADE.prox, arm: DEFAULT_GRENADE.arm, ground: DEFAULT_GRENADE.ground };
    const rule = (fuse: 'timer' | 'prox' | 'proxTimer') => grenadeAsSpec({ ...DEFAULT_GRENADE, fuse }, shell).rules;
    expect(rule('timer')).toEqual([{ when: { after: 1 }, do: [{ blast: DEFAULT_GRENADE.blast }, { remove: true }] }]);
    expect(rule('prox')[0]!.when).toEqual(near);
    expect(rule('proxTimer')[0]!.when).toEqual({ then: [near, { after: 1 }] });
  });

  // Each case breaks one thing; its fixed twin (fix) must be free of errors.
  const cases: { code: WeaponIssueCode; path: string; bad: (s: WeaponSpec) => unknown; fix?: (s: WeaponSpec) => unknown }[] = [
    { code: 'version', path: 'version', bad: (s) => ({ ...s, version: 2 }) },
    { code: 'name', path: 'name', bad: (s) => ({ ...s, name: 'Fire-work' }) },
    { code: 'name', path: 'children.Star', bad: (s) => ({ ...s, children: { Star: s.children!.star }, rules: [{ when: { after: 1 }, do: [{ split: { into: 8, child: 'Star', pattern: 'cone', angle: 40, at: 0.6 } }] }] }) },
    { code: 'key', path: 'shell.colour', bad: (s) => ({ ...s, shell: { ...s.shell, colour: 'red' } }) },
    { code: 'type', path: 'shell.speed', bad: (s) => ({ ...s, shell: { shape: s.shell.shape, density: 4 } }) },
    { code: 'type', path: 'shell.density', bad: (s) => ({ ...s, shell: { ...s.shell, density: '4' } }) },
    { code: 'range', path: 'shell.speed', bad: (s) => ({ ...s, shell: { ...s.shell, speed: [35, 20] } }) },
    { code: 'range', path: 'children.star.rules.0.do.0.blast.impulse', bad: (s) => { const t = clone(s); (t.children!.star!.rules[0]!.do[0] as { blast: { impulse: number } }).blast.impulse = -1; return t; } },
    { code: 'range', path: 'children.star.children.spark.rules.0.do.0.blast.falloff', bad: (s) => { const t = clone(s); (t.children!.star!.children!.spark!.rules[0]!.do[0] as { blast: { falloff: number } }).blast.falloff = 1.5; return t; } },
    { code: 'shape', path: 'shell.shape.kind', bad: (s) => ({ ...s, shell: { ...s.shell, shape: { kind: 'capsule', radius: 1 } } }) },
    { code: 'trigger', path: 'rules.0.when', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { after: 1, apex: true } }] }) },
    { code: 'trigger', path: 'rules.0.when.then', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { then: [{ after: 1 }] } }] }) },
    { code: 'trigger', path: 'rules.0.when.any.0.any.0.any.0.any.0', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { any: [{ any: [{ any: [{ any: [{ after: 1 }] }] }] }] } }] }) },
    { code: 'action', path: 'rules.0.do.0', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, do: [{ explode: true }] }] }) },
    { code: 'range', path: 'rules.0.when.any.1.moved', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { any: [{ apex: true }, { moved: 0 }] } }] }) },
    { code: 'key', path: 'rules.0.when.any.1.arm', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { any: [{ apex: true }, { moved: 1, arm: 1 }] } }] }) },
    { code: 'range', path: 'rules.0.when.any.1.speed', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, when: { any: [{ apex: true }, { moved: 1, speed: -1 }] } }] }) },
    { code: 'action', path: 'children.star.rules.1.do.0.removeTarget', bad: (s) => { const t = clone(s); t.children!.star!.rules[1]!.do = [{ removeTarget: 1 } as never]; return t; } },
    { code: 'order', path: 'children.star.rules.1.do.1', bad: (s) => { const t = clone(s); t.children!.star!.rules[1]!.do = [{ removeTarget: true }, { blast: { radius: 1, impulse: 1 } }]; return t; } },
    { code: 'order', path: 'children.star.children.spark.rules.0.do.1', bad: (s) => { const t = clone(s); t.children!.star!.children!.spark!.rules[0]!.do.reverse(); return t; } },
    { code: 'child', path: 'rules.0.do.0.split.child', bad: (s) => ({ ...s, rules: [{ ...s.rules[0]!, do: [{ split: { into: 2, child: 'comet' } }] }] }) },
    { code: 'depth', path: 'children.star.children.spark.children', bad: (s) => { const t = clone(s); t.children!.star!.children!.spark!.children = { dust: { shell: { shape: BALL(0.01), density: 1 }, rules: [] } }; return t; } },
    { code: 'budget', path: '', bad: (s) => { const t = clone(s); (t.children!.star!.rules[0]!.do[1] as { split: { into: number } }).split.into = 40; (t.children!.star!.rules[0]!.do[1] as { split: { pattern: string } }).split.pattern = 'sphere'; (t.children!.star!.rules[0]!.do[1] as { split: { at: number } }).split.at = 1; return t; } },
    { code: 'crowded', path: 'rules.0.do.0.split', bad: (s) => { const t = clone(s); (t.rules[0]!.do[0] as { split: { at: number } }).split.at = 0.2; return t; } },
  ];
  it.each(cases)('issue $code at $path', ({ code, path, bad }) => {
    expect(codes(FIREWORK)).toEqual([]);
    const { spec, issues } = validateWeapon(bad(FIREWORK));
    expect(spec).toBeNull();
    expect(issues.filter((i) => i.level === 'error').map((i) => [i.code, i.path])).toContainEqual([code, path]);
    expect(() => checkWeapon(bad(FIREWORK))).toThrow(WeaponSpecError);
  });

  it('issue json on text that is not JSON; the error lists every issue', () => {
    expect(() => parseWeapon('{ version: 1')).toThrow(/\[json\]/);
    try {
      checkWeapon({ ...FIREWORK, version: 0, name: 'X' });
    } catch (e) {
      expect((e as WeaponSpecError).issues.map((i) => i.code)).toEqual(['version', 'name']);
    }
  });

  it('warns, without refusing, on a child no split names and a munition nothing spends', () => {
    const t = clone(FIREWORK);
    t.children!.comet = { shell: { shape: BALL(0.1), density: 1 }, rules: [{ when: { after: 1 }, do: [{ remove: true }] }] };
    t.children!.star!.rules.pop();
    t.children!.star!.rules[0]!.do.pop();
    const { spec, issues } = validateWeapon(t);
    expect(spec).not.toBeNull();
    // Dropping the star's split leaves its sparks unused too.
    expect(issues.map((i) => [i.code, i.level, i.path])).toEqual([
      ['unused-child', 'warn', 'children.star.children.spark'],
      ['never-spent', 'warn', 'children.star.rules'],
      ['unused-child', 'warn', 'children.comet'],
    ]);
    // A child's speed is not used: a warning, and dropped.
    const u = clone(FIREWORK);
    u.children!.star!.shell.speed = [1, 2];
    expect(codes(u, 'warn')).toEqual(['key']);
    expect(checkWeapon(u)).toEqual(FIREWORK);
  });
});

describe('WeaponSpec budget', () => {
  it('counts every munition and blast that can exist when every rule fires: 1 shell, 8 stars, 32 sparks', () => {
    const b = weaponBudget(FIREWORK);
    expect(b.bodies).toBe(41);
    expect(b.depth).toBe(3);
    expect(b.munitions.map((m) => [m.path, m.count])).toEqual([['', 1], ['star', 8], ['star.spark', 32]]);
    expect(b.blasts.map((x) => [x.path, x.count, x.blast.radius])).toEqual([['star.rules.0.do.0', 8, 1.5], ['star.spark.rules.0.do.0', 32, 0.5]]);
    expect(weaponBudget(GRENADE_WEAPON)).toEqual({ bodies: 1, depth: 1, munitions: [{ path: '', shell: GRENADE_WEAPON.shell, count: 1 }], blasts: [{ path: 'rules.0.do.0', blast: DEFAULT_GRENADE.blast, count: 1 }], targets: 0 });
  });

  it('two splits of the same child add up (an upper bound), and the cap is MAX_WEAPON_BODIES', () => {
    const t = clone(FIREWORK);
    t.rules.push({ when: { after: 3 }, do: [{ split: { into: 2, child: 'star', pattern: 'ring', at: 1 } }] });
    expect(weaponBudget(t).bodies).toBe(1 + 10 + 40);
    expect(MAX_WEAPON_BODIES).toBe(256);
  });
});

describe('WeaponSpec units', () => {
  it('scaleWeapon scales lengths, speeds, density and blast strength together; by 1 it is the identity', () => {
    expect(scaleWeapon(FIREWORK, {})).toEqual(FIREWORK);
    const s = scaleWeapon(FIREWORK, { length: 2, speed: 4, density: 0.5, impulse: 8, maxDv: 3, maxSpeed: 5 });
    expect(s.shell).toEqual({ shape: BALL(0.8), density: 2, speed: [80, 140] });
    expect(s.rules[0]!.do[0]).toEqual({ split: { into: 8, child: 'star', pattern: 'cone', angle: 40, spread: 48, at: 1.8 } });
    expect(s.children!.star!.rules[0]!.when).toEqual({ near: 0.1, arm: 0.2 });
    expect(s.children!.star!.rules[0]!.do[0]).toEqual({ blast: { radius: 3, impulse: 48 } });
    const g = scaleWeapon(GRENADE_WEAPON, { length: 2, maxDv: 3, maxSpeed: 5 }).rules[0]!.do[0] as unknown as { blast: Record<string, number> };
    expect([g.blast.radius, g.blast.maxDv, g.blast.maxSpeed]).toEqual([10, 75, 240]);
    // Powers of two scale exactly, so scaling back is the identity.
    expect(scaleWeapon(scaleWeapon(FIREWORK, { length: 4, speed: 0.5 }), { length: 0.25, speed: 2 })).toEqual(FIREWORK);
  });
});

describe('charges: moved and removeTarget (docs/design/charges.md)', () => {
  /** A demolition charge: armed, it waits 0.5 s or until its host moves 2 cm or 0.3 m/s, then blasts and takes the host out. */
  const CHARGE: WeaponSpec = {
    version: 1, name: 'cutter',
    shell: { shape: { kind: 'box', half: [0.1, 0.05, 0.1] }, density: 2, speed: [0, 0] },
    rules: [{ when: { any: [{ after: 0.5 }, { moved: 0.02, speed: 0.3 }] }, do: [{ blast: { radius: 2, impulse: 4 } }, { removeTarget: true }] }],
  };

  it('round trips canonically; removeTarget spends the munition (no never-spent warning)', () => {
    expect(validateWeapon(CHARGE).issues).toEqual([]);
    expect(parseWeapon(writeWeapon(CHARGE))).toEqual(CHARGE);
    expect(writeWeapon(JSON.parse(JSON.stringify({ ...CHARGE, rules: [{ do: CHARGE.rules[0]!.do, when: { any: [{ after: 0.5 }, { speed: 0.3, moved: 0.02 }] } }] })) as WeaponSpec)).toBe(writeWeapon(CHARGE));
  });

  it('scaleWeapon scales moved as a length and its speed as a speed', () => {
    const s = scaleWeapon(CHARGE, { length: 2, speed: 4 });
    expect(s.rules[0]!.when).toEqual({ any: [{ after: 0.5 }, { moved: 0.04, speed: 1.2 }] });
    expect(scaleWeapon({ ...CHARGE, rules: [{ when: { moved: 0.5 }, do: [{ remove: true }] }] }, { length: 2 }).rules[0]!.when).toEqual({ moved: 1 });
  });

  it('the budget counts removeTarget actions; thrown weapons cannot have one, charges cannot near, apex or split', () => {
    expect(weaponBudget(CHARGE).targets).toBe(1);
    expect(weaponBudget(FIREWORK).targets).toBe(0);
    expect(chargeProblems(CHARGE)).toEqual([]);
    expect(thrownProblems(CHARGE).map((i) => [i.code, i.path])).toEqual([['target', 'rules.0.do.1']]);
    // A star with a removeTarget, deep in a thrown weapon: refused there too.
    const t = clone(FIREWORK);
    t.children!.star!.rules[1]!.do = [{ removeTarget: true }];
    expect(thrownProblems(t).map((i) => i.path)).toEqual(['star.rules.1.do.0']);
    expect(chargeProblems(FIREWORK).map((i) => [i.code, i.path])).toEqual([['charge', 'children'], ['charge', 'rules.0.when'], ['charge', 'rules.0.do.0']]);
    expect(chargeProblems(GRENADE_WEAPON).map((i) => i.path)).toEqual(['rules.0.when']);
    for (const w of Object.values(BUILTIN_WEAPONS)) expect(thrownProblems(w)).toEqual([]);
  });
});

describe('split patterns', () => {
  it('cosSin agrees with Math.cos and Math.sin to an ulp or two over [-2 pi, 2 pi]', () => {
    for (let i = -1000; i <= 1000; i++) {
      const x = (i / 1000) * 2 * Math.PI, [c, s] = cosSin(x);
      expect(Math.abs(c - Math.cos(x))).toBeLessThan(5e-16);
      expect(Math.abs(s - Math.sin(x))).toBeLessThan(5e-16);
    }
  });

  it('unit directions; ring and sphere spreads sum to zero (momentum kept); a cone sits at its angle around its axis', () => {
    for (const p of ['ring', 'sphere', 'cone'] as const) {
      for (const n of [1, 2, 3, 8, 13, 64]) {
        const d = splitDirections(n, p, 40, [0.6, 0, 0.8]);
        expect(d).toHaveLength(n);
        for (const v of d) expect(Math.hypot(...v)).toBeCloseTo(1, 14);
        if (p !== 'cone' && n > 1) for (let k = 0; k < 3; k++) expect(Math.abs(d.reduce((a, v) => a + v[k]!, 0))).toBeLessThan(p === 'ring' ? 1e-14 : 0.6);
        if (p === 'cone' && n > 1) for (const v of d) expect(v[0] * 0.6 + v[2] * 0.8).toBeCloseTo(Math.cos((40 * Math.PI) / 180), 14);
      }
    }
    // Same numbers on every call (no Math.random, no Math.sin).
    expect(splitDirections(8, 'sphere')).toEqual(splitDirections(8, 'sphere'));
    expect(splitDirections(4, 'ring').map((v) => v.map((x) => Math.round(x * 1e12) / 1e12 + 0))).toEqual([[1, 0, 0], [0, 0, 1], [-1, 0, 0], [0, 0, -1]]);
  });
});

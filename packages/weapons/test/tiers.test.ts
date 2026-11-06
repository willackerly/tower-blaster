// Device-tier caps (tiers.ts): what one shot may cost each tier, and the
// lowest tier each weapon fits (C12's verify: "budget caps reject a spec that
// exceeds the device tier").
import { describe, expect, it } from 'vitest';
import { BUILTIN_WEAPONS, fitsTier, GRENADE_L, GRENADE_XL, MAX_WEAPON_BODIES, tierIssues, tierOf, validateWeapon, WEAPON_TIER_CAPS, WEAPON_TIERS, weaponLoad, type WeaponSpec } from '../src/index.ts';

/** A shell splitting into n children that each blow (n bodies + 1, n blasts). */
const swarm = (n: number, impulse = 1): WeaponSpec => ({
  version: 1, name: 'swarm',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [10, 20] },
  rules: [{ when: { after: 1 }, do: [{ split: { into: n, child: 'bit', pattern: 'sphere', at: 8 } }] }],
  children: { bit: { shell: { shape: { kind: 'sphere', radius: 0.05 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 1, impulse } }, { remove: true }] }] } },
});

/** A shell splitting into a children that each split into b grandchildren that blow: 1 + a + a b bodies, a b blasts. */
const nested = (a: number, b: number): WeaponSpec => ({
  version: 1, name: 'nested',
  shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [10, 20] },
  rules: [{ when: { after: 1 }, do: [{ split: { into: a, child: 'mid', pattern: 'sphere', at: 8 } }] }],
  children: { mid: {
    shell: { shape: { kind: 'sphere', radius: 0.1 }, density: 4 },
    rules: [{ when: { after: 1 }, do: [{ split: { into: b, child: 'bit', pattern: 'sphere', at: 2 } }] }],
    children: { bit: { shell: { shape: { kind: 'sphere', radius: 0.05 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 1, impulse: 1 } }, { remove: true }] }] } },
  } },
});

describe('weapon tiers', () => {
  it('caps rise with the tier, and high stays within what the language allows', () => {
    for (const k of ['bodies', 'blasts', 'grenades'] as const) {
      expect(WEAPON_TIER_CAPS.low[k]).toBeLessThan(WEAPON_TIER_CAPS.mid[k]);
      expect(WEAPON_TIER_CAPS.mid[k]).toBeLessThan(WEAPON_TIER_CAPS.high[k]);
    }
    expect(WEAPON_TIER_CAPS.high.bodies).toBe(MAX_WEAPON_BODIES);
  });

  it('every built-in fits high; the L grenade fits low, the XL needs high', () => {
    for (const [name, spec] of Object.entries(BUILTIN_WEAPONS)) expect(fitsTier(spec, 'high'), name).toBe(true);
    expect(tierOf(GRENADE_L)).toBe('low');
    expect(tierOf(GRENADE_XL)).toBe('high');
    expect(tierOf(BUILTIN_WEAPONS.firework!)).toBe('low');
    expect(tierOf(BUILTIN_WEAPONS.cluster!)).toBe('low');
  });

  it('a load is the static budget: bodies with the shell, every blast as often as it can go off, energy in grenades', () => {
    const l = weaponLoad(swarm(40));
    expect(l.bodies).toBe(41);
    expect(l.blasts).toBe(40);
    expect(weaponLoad(GRENADE_XL).grenades).toBeCloseTo(16, 1);
  });

  it('refuses each number over the cap, naming the tier it needs', () => {
    const s = swarm(40);
    expect(validateWeapon(s).spec).not.toBeNull();
    const low = tierIssues(s, 'low');
    expect(low.map((i) => i.code)).toEqual(['tier', 'tier']);
    expect(low[0]!.message).toMatch(/41 bodies a shot is over the low tier's cap of 32 \(it needs mid\)/);
    expect(low[1]!.message).toMatch(/40 blasts a shot is over the low tier's cap of 16/);
    expect(tierIssues(s, 'mid')).toEqual([]);
    expect(tierOf(s)).toBe('mid');
  });

  it('a weapon over every tier is refused everywhere, and says so', () => {
    // 196 blasts: the language takes it (211 bodies is under its cap), no device tier does.
    const s = nested(14, 14);
    expect(weaponLoad(s)).toMatchObject({ bodies: 211, blasts: 196 });
    expect(validateWeapon(s).spec).not.toBeNull();
    expect(tierOf(s)).toBeNull();
    for (const t of WEAPON_TIERS) expect(fitsTier(s, t)).toBe(false);
    expect(tierIssues(s, 'high')[0]!.message).toMatch(/over every tier/);
  });

  it('energy alone can put a weapon over: a strong single blast', () => {
    const heavy: WeaponSpec = { ...GRENADE_XL, name: 'heavy', rules: [{ when: { after: 1 }, do: [{ blast: { ...('blast' in GRENADE_XL.rules[0]!.do[0]! ? GRENADE_XL.rules[0]!.do[0]!.blast : { radius: 1, impulse: 1 }), radius: 20 } }, { remove: true }] }] };
    expect(weaponLoad(heavy).bodies).toBe(1);
    expect(weaponLoad(heavy).grenades).toBeGreaterThan(16);
    expect(tierIssues(heavy, 'high').map((i) => i.message)).toEqual([expect.stringMatching(/grenades a shot is over the high tier's cap of 16/)]);
  });
});

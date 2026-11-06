// The rack's weapons held to the device-tier caps (roadmap C12 step 4, docs/design/weapon-editor.md):
// an arm's load (arsenal.ts armLoad) is its weapon's own load as written, on every level; a weapon over
// a tier is refused on it (armRefusal); a level carrying one over every tier does not validate.
import { describe, expect, it } from 'vitest';
import { BUILTIN_WEAPONS, DEFAULT_GRENADE, grenadeAsSpec, grenadeEnergies, weaponLoad, type WeaponSpec } from '@tb/weapons';
import { armLoad, armRefusal, B3, BIG_LEVELS, compileLevel, KEYSTONE_GRENADE, L1, LEVELS, levelGrenadeYield, TRIAL_LEVELS, UNDERCUT_LEVELS, validateLevel } from '../src/index.ts';

/** 1 shell, 14 children, 196 grandchildren that blow: legal in the language, over every tier's blasts. */
const SWARM: WeaponSpec = {
  version: 1, name: 'swarm', shell: { shape: { kind: 'sphere', radius: 0.5 }, density: 4, speed: [10, 20] },
  rules: [{ when: { after: 1 }, do: [{ split: { into: 14, child: 'mid', at: 8 } }] }],
  children: { mid: { shell: { shape: { kind: 'sphere', radius: 0.1 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ split: { into: 14, child: 'bit', at: 2 } }] }],
    children: { bit: { shell: { shape: { kind: 'sphere', radius: 0.05 }, density: 4 }, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 0.3, impulse: 0.3 } }, { remove: true }] }] } } } },
};

describe('an arm\'s load', () => {
  it('is the weapon\'s own load as written, on a plaster level and a stone one', () => {
    for (const def of [L1, B3]) {
      for (const key of Object.keys(BUILTIN_WEAPONS)) {
        const c = compileLevel({ ...def, rack: [`w-${key}`] }), got = armLoad(c, c.arms[`w-${key}`]!), want = weaponLoad(BUILTIN_WEAPONS[key]!);
        expect(got.bodies).toBe(want.bodies);
        expect(got.blasts).toBe(want.blasts);
        expect(got.grenades).toBeCloseTo(want.grenades, 6);
      }
    }
  });

  it('one grenade of energy is the M grenade\'s yield on the level, and a GrenadeSpec weapon counts against it', () => {
    const c = compileLevel({ ...L1, rack: ['w-k'], weapons: { k: KEYSTONE_GRENADE } });
    expect(levelGrenadeYield(c)).toBeGreaterThan(0);
    expect(grenadeEnergies(grenadeAsSpec(DEFAULT_GRENADE))).toBeCloseTo(1, 9);
    const k = armLoad(c, c.arms['w-k']!);
    expect(k.bodies).toBe(1);
    expect(k.blasts).toBe(1);
    // Keystone's small grenade: about 1/77 of a grenade on plaster (rack.ts).
    expect(1 / k.grenades).toBeGreaterThan(50);
    expect(1 / k.grenades).toBeLessThan(110);
  });
});

describe('refused on a tier it is over', () => {
  it('the XL needs high; the M fits low; non-weapons are never refused', () => {
    const c = compileLevel({ ...B3, rack: ['w-grenadexl', 'w-grenadem', 'marble'] });
    expect(armRefusal(c, 'w-grenadexl', 'mid')).toMatch(/^w-grenadexl not fired: 16\.00 grenades a shot is over the mid tier's cap of 8 \(it needs high\)$/);
    expect(armRefusal(c, 'w-grenadexl', 'high')).toBeNull();
    expect(armRefusal(c, 'w-grenadem', 'low')).toBeNull();
    expect(armRefusal(c, 'marble', 'low')).toBeNull();
  });

  it('every shipped level\'s and trial\'s weapons fit low (none needs a fast device)', () => {
    const over: string[] = [];
    for (const def of [...LEVELS, ...BIG_LEVELS, ...UNDERCUT_LEVELS, ...TRIAL_LEVELS]) {
      const c = compileLevel(def);
      for (const item of new Set(def.rack)) { const why = armRefusal(c, item, 'low'); if (why) over.push(`${def.id} ${why}`); }
    }
    expect(over).toEqual([]);
  });
});

describe('the validator', () => {
  it('rejects a level carrying a weapon over every tier, and passes one that fits high', () => {
    const over = validateLevel(compileLevel({ ...L1, rack: ['w-swarm'], weapons: { swarm: SWARM } }));
    expect(over.find((i) => i.code === 'weapon')?.message).toMatch(/^w-swarm: 196 blasts a shot is over the high tier's cap of 128 \(over every tier\)$/);
    const xl = validateLevel(compileLevel({ ...L1, rack: ['w-grenadexl'] }));
    expect(xl.filter((i) => i.code === 'weapon')).toEqual([]);
  });
});

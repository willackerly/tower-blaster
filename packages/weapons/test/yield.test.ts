// Nominal blast yield (yield.ts) against what the engines' blast gives a real
// lattice of cubes, and its scaling laws (spectacle-mode.md section 11, G3.3).
import { describe, expect, it } from 'vitest';
import { blastArea, blastVelocity, checkBlast } from '@tb/engine-api';
import { BUILTIN_WEAPONS, CLUSTER, CUBE_FILL, DEFAULT_GRENADE, FIREWORK, GRENADE_L, GRENADE_M, GRENADE_S, GRENADE_SIZES, GRENADE_WEAPON, GRENADE_XL, GRENADE_YIELD, grenadeEnergies, type GrenadeBlast, nominalYield, weaponYield, YIELD_SHELLS } from '@tb/weapons';

/** Kinetic energy blastVelocity gives a cubic lattice of resting cubes (edge h, pitch p, density rho) around `centre`. */
function latticeEnergy(blast: GrenadeBlast, h: number, p: number, rho: number, centre: [number, number, number]): number {
  const b = checkBlast({ centre, ...blast }), m = rho * h ** 3, area = blastArea({ kind: 'box', half: [h / 2, h / 2, h / 2] });
  const n = Math.ceil(blast.radius / p) + 1;
  let e = 0;
  for (let i = -n; i <= n; i++) for (let j = -n; j <= n; j++) for (let k = -n; k <= n; k++) {
    const v = blastVelocity(b, centre, 0, [i * p, j * p, k * p], [0, 0, 0], m, area);
    if (v) e += 0.5 * m * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  }
  return e;
}

const fillOf = (h: number, p: number, rho: number) => ({ density: (rho * h ** 3) / p ** 3, areaPerMass: blastArea({ kind: 'box', half: [h / 2, h / 2, h / 2] }) / (rho * h ** 3) });

describe('nominal blast yield', () => {
  it('is within 3% of a resting lattice of cubes for a radius of at least 4 cube edges, wherever the centre sits', () => {
    const h = 0.5, p = 0.51, rho = 250; // Keystone plaster cubes on its lattice pitch
    const blasts: GrenadeBlast[] = [
      { radius: 2, impulse: 640, falloff: 1, core: 0.2, maxDv: 15, maxSpeed: 20 }, // KEYSTONE_GRENADE at h = 0.5
      { radius: 3, impulse: 2000, falloff: 2, core: 0, maxDv: 25, maxSpeed: 48 }, // maxDv binds near the centre
      { radius: 2.5, impulse: 300, falloff: 0, core: 0, maxDv: 25, maxSpeed: 48 }, // flat
    ];
    const offsets: [number, number, number][] = [[0.13, 0.27, 0.41], [0.5, 0.5, 0.5], [0.02, 0.71, 0.33], [0.9, 0.1, 0.6]];
    for (const blast of blasts) {
      expect(blast.radius).toBeGreaterThanOrEqual(4 * h);
      const lattice = offsets.reduce((a, o) => a + latticeEnergy(blast, h, p, rho, o.map((x) => x * p) as [number, number, number]), 0) / offsets.length;
      const y = nominalYield(blast, fillOf(h, p, rho));
      expect(Math.abs(y / lattice - 1), JSON.stringify(blast)).toBeLessThan(0.03);
    }
  });

  it('scales as the radius cubed where maxDv binds everywhere: 1/2 rho maxDv^2 (4/3) pi R^3', () => {
    const fill = { density: 250, areaPerMass: 0.012 };
    const y = (radius: number) => nominalYield({ radius, impulse: 1e5, falloff: 1, core: 0.99, maxDv: 10, maxSpeed: 48 }, fill);
    // The core holds 99% of the radius at full strength and 1e5 N s/m^2 x 0.012 m^2/kg is far above maxDv to the very edge shell.
    for (const r of [1, 2, 3.7]) expect(y(r) / (0.5 * 250 * 100 * (4 / 3) * Math.PI * r ** 3) - 1).toBeCloseTo(0, 6);
    expect(y(2) / y(1)).toBeCloseTo(8, 6);
    // maxSpeed below maxDv is the cap instead.
    expect(nominalYield({ radius: 1, impulse: 1e5, falloff: 1, core: 0.99, maxDv: 10, maxSpeed: 5 }, fill) / y(1)).toBeCloseTo(0.25, 6);
  });

  it('is zero for zero impulse or an empty fill, and grows with impulse until maxDv binds', () => {
    const fill = { density: 250, areaPerMass: 0.012 }, blast = { radius: 2, impulse: 0, falloff: 1, core: 0.2, maxDv: 15, maxSpeed: 20 };
    expect(nominalYield(blast, fill)).toBe(0);
    expect(nominalYield({ ...blast, impulse: 640 }, { density: 0, areaPerMass: 0.012 })).toBe(0);
    const at = (impulse: number) => nominalYield({ ...blast, impulse }, fill);
    expect(at(200) / at(100)).toBeCloseTo(4, 9); // no cap reached: v is linear in impulse
    // Capped almost everywhere: only the thin edge shell where the linear falloff nears 0 still grows.
    expect(at(1e6) / at(1e7)).toBeGreaterThan(0.995);
    expect(at(1e6)).toBeLessThan(at(1e7));
    expect(() => nominalYield(blast, { density: -1, areaPerMass: 0 })).toThrow(/bad fill/);
    expect(() => nominalYield({ ...blast, falloff: 1.5 }, fill)).toThrow(/falloff/);
  });

  it('is a fixed sum (pinned), the same on every machine: DEFAULT_GRENADE against a solid fill of 1 kg, 1 m scene cubes', () => {
    expect(YIELD_SHELLS).toBe(1024);
    expect(nominalYield(DEFAULT_GRENADE.blast, fillOf(1, 1, 1))).toBe(PINNED_DEFAULT_YIELD);
  });
});

const PINNED_DEFAULT_YIELD = 79388.25759182297;

describe('one energy unit for every weapon: grenades', () => {
  it('one grenade is DEFAULT_GRENADE\'s yield in the viewer\'s world, and the built-in grenade spec is exactly one', () => {
    expect(CUBE_FILL).toEqual({ density: 1, areaPerMass: 1.5 });
    expect(GRENADE_YIELD).toBe(nominalYield(DEFAULT_GRENADE.blast, CUBE_FILL));
    expect(grenadeEnergies(GRENADE_WEAPON)).toBe(1);
  });
  it('a weapon\'s yield is every blast it can set off, as often as it can (defaults filled in)', () => {
    const star = FIREWORK.children!.star!.rules[0]!.do[0]!;
    if (!('blast' in star)) throw new Error('star rule changed');
    const b = checkBlast({ centre: [0, 0, 0], ...star.blast });
    expect(weaponYield(FIREWORK, CUBE_FILL)).toBe(12 * nominalYield({ radius: b.radius, impulse: b.impulse, falloff: b.falloff, core: b.core, maxDv: b.maxDv, maxSpeed: b.maxSpeed }, CUBE_FILL));
    expect(weaponYield({ ...FIREWORK, children: {}, rules: [] }, CUBE_FILL)).toBe(0);
  });
  it('the firework and the cluster carry one grenade each, within 1% (1.004 and 0.994; they were 0.39 and 0.80)', () => {
    for (const [name, spec] of Object.entries({ firework: FIREWORK, cluster: CLUSTER })) {
      const g = grenadeEnergies(spec);
      console.log(`${name}: ${g.toFixed(4)} grenades`);
      expect(Math.abs(g - 1), name).toBeLessThan(0.01);
    }
    expect(grenadeEnergies(FIREWORK)).toBeCloseTo(1.004, 3);
    expect(grenadeEnergies(CLUSTER)).toBeCloseTo(0.994, 3);
  });
});

describe('grenade sizes', () => {
  it('S, M, L, XL carry 1/4, 1, 4 and 16 grenades (within 1%), reaching further with the same kick', () => {
    const sizes = { grenades: GRENADE_S, grenadem: GRENADE_M, grenadel: GRENADE_L, grenadexl: GRENADE_XL };
    for (const [name, spec] of Object.entries(sizes) as [keyof typeof GRENADE_SIZES, typeof GRENADE_S][]) {
      expect(spec.name).toBe(name);
      expect(BUILTIN_WEAPONS[name]).toBe(spec);
      expect(Math.abs(grenadeEnergies(spec) / GRENADE_SIZES[name] - 1), name).toBeLessThan(0.01);
      const b = spec.rules[0]!.do[0]!;
      if (!('blast' in b)) throw new Error('not a blast');
      expect({ ...b.blast, radius: 0 }, name).toEqual({ ...DEFAULT_GRENADE.blast, radius: 0 });
    }
    expect(grenadeEnergies(GRENADE_M)).toBe(1);
    // M is the viewer grenade itself (the B levels' bomb's blast) in GRENADE_WEAPON's shell.
    expect(GRENADE_M.rules).toEqual(GRENADE_WEAPON.rules);
  });
});

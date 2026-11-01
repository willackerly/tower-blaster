// Rack items (rack.ts): names, what each fires, model-scale density, weapons by key.
// The pinned values were computed on main at b3bbd02, before rack items existed, so
// they prove that Keystone's own ammo, its shots and the shipped levels did not move.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { blastArea, blastKick, checkBlast, massOf } from '@tb/engine-api';
import { DEFAULT_GRENADE, PRESET_NAMES, PROJECTILE_PRESETS, STONE_DENSITY } from '@tb/weapons';
import {
  AMMO, AMMO_KINDS, ammoBody, compileLevel, GRENADE_SHELL, hashString, isLaunchItem, isRackItem, itemRef, itemSpec, KEYSTONE_GRENADE, L1, levelWeapon, LEVELS,
  MATERIALS, MODEL_DENSITY, rackBodies, type RackItem, type Shot, shotToSpawn, speedOf,
} from '@tb/keystone';

const PRESET_ITEMS = PRESET_NAMES.map((p) => `p-${p}` as RackItem);

describe('rack item names', () => {
  it('names Keystone ammo bare, presets p-<preset> and weapons w-<key>', () => {
    for (const a of AMMO_KINDS) expect(itemRef(a)).toEqual({ kind: 'ammo', ammo: a });
    for (const p of PRESET_NAMES) expect(itemRef(`p-${p}`)).toEqual({ kind: 'preset', preset: p });
    expect(itemRef('w-grenade')).toEqual({ kind: 'weapon', key: 'grenade' });
    expect(itemRef('w-a1')).toEqual({ kind: 'weapon', key: 'a1' });
  });
  it('refuses names that are none of those, and anything holding a shot-text separator', () => {
    for (const bad of ['', 'nuke', 'p-', 'p-nuke', 'p-Beachball', 'w-', 'w-Grenade', 'w-1a', 'w-a.b', 'w-a_b', 'w-a-b', 'x-grenade', 'Marble', `w-${'a'.repeat(25)}`, 'p-toString', 'p-__proto__']) {
      expect(itemRef(bad), bad).toBeNull();
      expect(isRackItem(bad), bad).toBe(false);
    }
    expect(isRackItem(`w-${'a'.repeat(24)}`)).toBe(true);
  });
  it('launch items are everything fired from the ring: all but cue and drop', () => {
    expect([...AMMO_KINDS, ...PRESET_ITEMS, 'w-grenade'].filter(isLaunchItem)).toEqual(['marble', 'cannonball', ...PRESET_ITEMS, 'w-grenade']);
  });
});

describe('what an item fires', () => {
  it("Keystone's own ammo: the body and speeds AMMO gave before rack items, op for op", () => {
    for (const a of AMMO_KINDS) for (const unit of [0.5, 0.37, 1]) {
      const s = AMMO[a], m = MATERIALS.find((x) => x.name === s.material)!;
      const spec = itemSpec(a, unit);
      expect(spec.size).toEqual('radius' in s.size ? { radius: s.size.radius * unit } : { half: s.size.half.map((x) => x * unit) });
      expect([spec.density, spec.friction, spec.restitution, spec.vMin, spec.vMax]).toEqual([m.density, m.friction, m.restitution, s.vMin, s.vMax]);
      for (const power of [0, 37, 100]) expect(speedOf(a, power)).toBe(s.vMin + ((s.vMax - s.vMin) * power) / 100);
    }
  });
  it('every shot of the shipped levels spawns the same body as on main (pinned)', () => {
    const extra: Shot[] = [
      { ammo: 'marble', az: 17, y: 9, yaw: -33, pitch: 123, power: 37 },
      { ammo: 'cannonball', az: 700, y: 3, yaw: 250, pitch: -100, power: 0 },
      { ammo: 'cue', x: -7, y: 5, z: 3, dir: 0, power: 70 },
      { ammo: 'cue', x: 2, y: 1, z: -9, dir: 3, power: 100 },
      { ammo: 'drop', x: 4, z: -8 },
    ];
    const all = LEVELS.flatMap((d) => { const c = compileLevel(d); return [...(d.solutions?.par ?? []), ...extra].map((s, i) => shotToSpawn(c.frame, s, 300 + i)); });
    expect([all.length, hashString(JSON.stringify(all))]).toEqual([31, '38a345e1746393a0']);
  });
  it('the shipped levels hash as on main (the new LevelDef fields are absent, so the hash text is unchanged)', () => {
    expect(LEVELS.map((d) => compileLevel(d).hash)).toEqual(['8bf18a8ee7c8b871', 'e7376366e5ca1e8f', 'a0e04f152baeb2aa', '3360c5054e55a940', '22b48f7125bd6c78']);
  });
  it('a preset is its real diameter, bounce, friction and speed, at model density (stone 625 = real stone 2400)', () => {
    expect(MODEL_DENSITY).toBe(625 / STONE_DENSITY);
    for (const p of PRESET_NAMES) for (const unit of [0.5, 0.25]) {
      const r = PROJECTILE_PRESETS[p], spec = itemSpec(`p-${p}`, unit);
      expect(spec).toEqual({ size: { radius: r.diameter / 2 }, density: r.density * MODEL_DENSITY, friction: r.friction, restitution: r.restitution, vMin: r.speed / 2, vMax: r.speed });
    }
  });
  it('preset masses against a plaster cube are the spec table (section 7)', () => {
    const plaster = compileLevel(L1).meta.mass[0]!;
    const ratio = (p: string) => massOf(ammoBody(`p-${p}` as RackItem, 0.5, [0, 0, 0], [0, 0, 0])) / plaster;
    const want = { beachball: 0.002, basketball: 0.005, bowlingball: 0.06, cannonball: 0.09, wreckingball: 25, boulder: 3500 };
    for (const [p, w] of Object.entries(want)) expect(Math.abs(ratio(p) / w - 1), p).toBeLessThan(0.07);
  });
  it('a w- item flies in the grenade shell whatever its weapon; p- and w- shots spawn like the marble does', () => {
    expect(itemSpec('w-grenade', 0.5)).toEqual(itemSpec('w-other', 0.5));
    expect(itemSpec('w-grenade', 0.5).size).toEqual({ radius: GRENADE_SHELL.size.radius * 0.5 } as never);
    const f = compileLevel(L1).frame;
    fc.assert(fc.property(fc.constantFrom<RackItem>(...PRESET_ITEMS, 'w-grenade'), fc.integer({ min: 0, max: 719 }), fc.integer({ min: 0, max: 40 }), fc.integer({ min: -300, max: 300 }), fc.integer({ min: -400, max: 800 }), fc.integer({ min: 0, max: 100 }), (ammo, az, y, yaw, pitch, power) => {
      const shot = { ammo, az, y, yaw, pitch, power } as Shot, ev = shotToSpawn(f, shot, 9);
      const marble = shotToSpawn(f, { ammo: 'marble', az, y, yaw, pitch, power }, 9);
      expect(ev.body.pos).toEqual(marble.body.pos);
      const dir = (v: number[]) => v.map((x) => x / Math.hypot(...v));
      dir(ev.body.linVel).forEach((x, k) => expect(x).toBeCloseTo(dir(marble.body.linVel)[k]!, 12));
      expect(Math.hypot(...ev.body.linVel)).toBeCloseTo(speedOf(ammo, power), 9);
      expect(ev.body).toEqual(ammoBody(ammo, f.unit, ev.body.pos, ev.body.linVel));
    }), { numRuns: 60 });
  });
  it('one engine body per item, so the rack adds its length', () => {
    expect(rackBodies(['marble', 'p-boulder', 'w-grenade', 'drop'])).toBe(4);
    expect(rackBodies([])).toBe(0);
  });
});

describe('weapons by key (levelWeapon)', () => {
  it('w-grenade defaults to KEYSTONE_GRENADE with lengths in h; a level may bring its own', () => {
    const g = levelWeapon({}, 'grenade')!;
    expect(g).toEqual({ ...KEYSTONE_GRENADE, prox: KEYSTONE_GRENADE.prox * 0.5, blast: { ...KEYSTONE_GRENADE.blast, radius: KEYSTONE_GRENADE.blast.radius * 0.5 } });
    const own = { ...KEYSTONE_GRENADE, fuse: 'timer' as const, blast: { ...KEYSTONE_GRENADE.blast, radius: 2 } };
    expect(levelWeapon({ unit: 0.25, weapons: { grenade: own } }, 'grenade')!.blast.radius).toBe(0.5);
    expect(levelWeapon({ weapons: { big: own } }, 'big')!.fuse).toBe('timer');
    expect(levelWeapon({ weapons: { big: own } }, 'other')).toBeNull();
    expect(levelWeapon({}, 'toString')).toBeNull();
    expect(() => levelWeapon({ weapons: { grenade: { ...own, fuse: 'boom' as never } } }, 'grenade')).toThrow(/fuse/);
  });
  it("KEYSTONE_GRENADE's core kicks a plaster cube 7.7 m/s and a stone one 3.1 m/s (DEFAULT_GRENADE: 0.48)", () => {
    const c = compileLevel(L1), half = 0.25;
    const kick = (g: typeof KEYSTONE_GRENADE, density: number) => {
      const b = checkBlast({ centre: [0, 0, 0], ...g.blast }), mass = density * (2 * half) ** 3;
      return Math.hypot(...blastKick(b, [0, 0, 0], 0, [0.1, 0, 0], mass, blastArea({ kind: 'box', half: [half, half, half] }))!);
    };
    const world = levelWeapon({}, 'grenade')!;
    expect(c.meta.mass[0]).toBe(31.25);
    expect(kick(world, 250)).toBeCloseTo(7.68, 6);
    expect(kick(world, 625)).toBeCloseTo(3.072, 6);
    expect(kick(DEFAULT_GRENADE, 250)).toBeCloseTo(0.48, 6);
  });
});

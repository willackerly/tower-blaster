import { describe, expect, it } from 'vitest';
import { combineFriction, TAG_BALL } from '@tb/engine-api';
import { AMMO_RATIO, AMMO_RATIO_MAX, compileLevel, decodeTag, encodeTag, isDud, KEYSTONE_GRENADE, type LevelDef, LEVELS, ENGINE_MAX_BODIES, MATERIALS, MAX_RACK, type RackItem, ROLES, validateLevel } from '@tb/keystone';

const tiny = (parts: LevelDef['parts'], extra: Partial<LevelDef> = {}): LevelDef => ({
  id: 'T', name: 't', version: 1, world: 0, parts, lot: { min: [-6, -6], max: [6, 6] }, crownLine: 1,
  objective: { kind: 'crowns' }, par: 1, rack: ['marble'], launcher: { radius: 10, y: 1, dropY: 10 }, ...extra,
});
const codes = (d: LevelDef) => validateLevel(compileLevel(d)).map((i) => i.code);

describe('materials and tags', () => {
  it('a plaster cube at h = 0.5 m is a 31.25 kg model block', () => {
    const c = compileLevel(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster' }]));
    expect(c.meta.mass[0]).toBe(0.125 * MATERIALS[0].density);
    expect(c.meta.mass[0]).toBe(31.25);
  });
  it("under 'min', ammo grips plaster and the ground as it did under the old average, and ice slips", () => {
    const f = (name: string) => MATERIALS.find((m) => m.name === name)!.friction;
    const ground = compileLevel(LEVELS[0]!).scene.ground!.friction;
    expect(combineFriction('min', f('steel'), f('plaster'))).toBe(combineFriction('average', 0.5, f('plaster')));
    expect(combineFriction('min', f('steel'), ground)).toBe(0.55);
    expect(combineFriction('min', f('ice'), f('plaster'))).toBe(f('ice'));
  });
  it('tags round-trip for every role and part, and ammo uses TAG_BALL', () => {
    for (const role of ROLES) for (const part of [0, 1, 17, 4095]) expect(decodeTag(encodeTag(role, part))).toEqual({ role, part });
    expect(decodeTag(TAG_BALL).role).toBe('ammo');
    expect(() => encodeTag('plain', 4096)).toThrow();
  });
});

describe('compileLevel', () => {
  it('is pure: equal inputs give deep-equal scenes and the same hash', () => {
    for (const def of LEVELS) {
      const a = compileLevel(def), b = compileLevel(structuredClone(def));
      expect(a.scene).toEqual(b.scene);
      expect(a.hash).toBe(b.hash);
    }
  });
  it('has the expected body counts and stable order (courses bottom-up, then x, then z)', () => {
    expect(LEVELS.map((d) => compileLevel(d).meta.n)).toEqual([40, 139, 40, 38, 45]);
    const c = compileLevel(tiny([{ kind: 'block', at: [0, 0, 0], size: [2, 2, 2], material: 'plaster' }]));
    const ys = Array.from({ length: 8 }, (_, i) => c.meta.home[3 * i + 1]);
    expect(ys).toEqual([0.25, 0.25, 0.25, 0.25, 0.75, 0.75, 0.75, 0.75]);
    expect(c.meta.home[0]).toBeLessThan(c.meta.home[3 * 2]!); // x before... second x after the two z
  });
  it('applies course overrides and omits cells', () => {
    const c = compileLevel(tiny([{ kind: 'block', at: [0, 0, 0], size: [3, 2, 1], material: 'plaster', courses: [{ k: 1, cells: [[1, 0]], role: 'crown' }, { k: 1, cells: [[2, 0]], omit: true }, { k: 0, material: 'stone' }] }]));
    expect(c.meta.n).toBe(5);
    expect(Array.from(c.meta.crowns)).toEqual([4]);
    expect(Array.from(c.meta.material.slice(0, 3))).toEqual([1, 1, 1]);
  });
  it('the solutions field does not change the level hash', () => {
    const def = LEVELS[0]!;
    expect(compileLevel({ ...def, solutions: { par: [{ ammo: 'drop', x: 0, z: 0 }] } }).hash).toBe(compileLevel({ ...def, solutions: undefined }).hash);
  });
});

describe('validateLevel', () => {
  it('passes every shipped level', () => {
    for (const def of LEVELS) expect(validateLevel(compileLevel(def)), def.id).toEqual([]);
  });
  it('rejects a floating cube', () => {
    expect(codes(tiny([{ kind: 'block', at: [0, 1, 0], size: [1, 1, 1], material: 'plaster' }]))).toContain('unsupported');
  });
  it('rejects overlapping bodies', () => {
    expect(codes(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster' }, { kind: 'block', at: [0.5, 0, 0], size: [1, 1, 1], material: 'plaster' }]))).toContain('overlap');
  });
  it('rejects touching bodies with a mass ratio above 10', () => {
    // A 312 kg stone slab on a 28 kg ice cube: ratio 11.1.
    expect(codes(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'ice' }, { kind: 'slab', at: [0.5, 1, 0.5], half: [2, 0.125, 2], material: 'stone' }]))).toContain('mass-ratio');
    expect(codes(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster' }, { kind: 'block', at: [0, 1, 0], size: [1, 1, 1], material: 'iron' }]))).not.toContain('mass-ratio');
  });
  it('accepts a lever balanced by its load and rejects it without the counterweight', () => {
    const lever = (withWeight: boolean) => tiny([
      { kind: 'block', at: [0, 0, -0.5], size: [1, 2, 1], material: 'plaster' },
      { kind: 'block', at: [3, 0, -0.5], size: [1, 2, 1], material: 'plaster' },
      { kind: 'slab', at: [5, 2, 0], half: [5, 0.125, 0.5], material: 'plaster' },
      ...(withWeight ? [{ kind: 'block' as const, at: [0, 2.25, -0.5] as [number, number, number], size: [2, 2, 1] as [number, number, number], material: 'stone' as const }] : []),
    ]);
    expect(codes(lever(true))).not.toContain('unsupported');
    expect(codes(lever(false))).toContain('unsupported');
  });
  it('rejects ammo that can step through the thinnest body', () => {
    const thin = (half: number) => tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster' }, { kind: 'slab', at: [0.5, 1, 0.5], half: [0.5, half, 0.5], material: 'plaster' }]);
    expect(codes(thin(0.02))).toContain('tunnelling');
    expect(codes(thin(0.125))).not.toContain('tunnelling');
  });
  it('rejects crowns that start below the crown line, a bad rack, and an empty level', () => {
    expect(codes(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster', role: 'crown' }], { crownLine: 2 }))).toContain('crown-start');
    expect(codes(tiny([{ kind: 'block', at: [0, 0, 0], size: [1, 1, 1], material: 'plaster' }], { par: 2 }))).toContain('rack');
    expect(codes(tiny([]))).toContain('empty');
  });
});

describe('validateLevel: rack items (spectacle-mode.md section 7)', () => {
  // A 3 x 3 x 3 block of one material: the lightest body is one of its cubes.
  const block = (material: LevelDef['parts'][number]['material'], rack: RackItem[], extra: Partial<LevelDef> = {}) =>
    tiny([{ kind: 'block', at: [-1.5, 0, -1.5], size: [3, 3, 3], material }], { rack, ...extra });
  const issues = (d: LevelDef) => validateLevel(compileLevel(d));
  it('every item of every kind validates on a plain stone block, and only the duds warn', () => {
    const rack: RackItem[] = ['marble', 'cannonball', 'drop', 'w-grenade', 'p-wreckingball', 'p-bowlingball', 'p-basketball', 'p-beachball'];
    expect(rack.length).toBe(MAX_RACK);
    const got = issues(block('stone', rack));
    expect(got.filter((i) => !i.warning)).toEqual([]);
    expect(got.map((i) => [i.code, i.message.split(':')[0]])).toEqual([['dud', 'p-bowlingball'], ['dud', 'p-basketball'], ['dud', 'p-beachball']]);
  });
  it('rack: a ninth item, and a name that is no item', () => {
    expect(codes(block('stone', Array(MAX_RACK).fill('marble')))).not.toContain('rack');
    expect(codes(block('stone', Array(MAX_RACK + 1).fill('marble')))).toContain('rack');
    expect(codes(block('stone', ['nuke' as RackItem]))).toContain('rack');
  });
  it('ammo-ratio: the wrecking ball is 25 x a plaster cube, 10 x a stone one; a level may raise the limit to 100', () => {
    expect(AMMO_RATIO).toBe(20);
    expect(codes(block('plaster', ['p-wreckingball']))).toContain('ammo-ratio');
    expect(codes(block('stone', ['p-wreckingball']))).not.toContain('ammo-ratio');
    expect(codes(block('plaster', ['p-wreckingball'], { limits: { ammoRatio: 30 } }))).not.toContain('ammo-ratio');
    expect(codes(block('stone', ['marble'], { limits: { ammoRatio: AMMO_RATIO_MAX + 1 } }))).toContain('ammo-ratio');
    expect(codes(block('stone', ['p-boulder'], { limits: { ammoRatio: AMMO_RATIO_MAX } }))).toContain('ammo-ratio');
    // The structure-pair mass-ratio check is a different code and stays as it was.
    expect(codes(block('plaster', ['p-wreckingball']))).not.toContain('mass-ratio');
  });
  it("dud: a bowling ball can pass 29 J of its 136 J, under the 32 J that tips plaster; Keystone's marble is no dud", () => {
    const plaster = compileLevel(block('plaster', ['marble']));
    const at = (item: RackItem) => issues(block('plaster', [item])).filter((i) => i.code === 'dud');
    expect(at('p-bowlingball')).toEqual([expect.objectContaining({ warning: true })]);
    expect(at('marble')).toEqual([]);
    expect(at('p-cannonball')).toEqual([]);
    // The rule's edges: 31.75 J tips a 31.25 kg cube of 0.5 m; a hit passing just over that is no dud.
    const tip = 31.25 * 9.81 * (Math.hypot(0.25, 0.25) - 0.25);
    expect(isDud(plaster, 1e9, tip * 0.999)).toBe(true);
    expect(isDud(plaster, 1e9, tip * 1.001)).toBe(true); // a 1e9 kg hammer passes almost nothing
    expect(isDud(plaster, 31.25, tip * 0.999)).toBe(true); // equal masses pass it all
    expect(isDud(plaster, 31.25, tip * 1.001)).toBe(false);
    // Weapons and the anvil are never duds: the blast and the drop are their point.
    expect(at('w-grenade')).toEqual([]);
    expect(at('drop')).toEqual([]);
  });
  it('tunnelling: the real cannonball (45 m/s, 14 cm) steps 0.75 m, past 0.8 x (0.14 + 0.5) m; the wrecking ball does not', () => {
    expect(codes(block('stone', ['p-cannonball']))).toContain('tunnelling');
    expect(codes(block('stone', ['p-wreckingball']))).not.toContain('tunnelling');
  });
  it("tunnelling: a weapon's blast may not kick a body faster than the thinnest one allows", () => {
    // A quarter-h slab (0.125 m): 0.8 x 2 x 0.125 m a step is 12 m/s; KEYSTONE_GRENADE caps at 20.
    const slab = (maxSpeed: number) => tiny([
      { kind: 'block', at: [-1, 0, -1], size: [2, 2, 2], material: 'stone' },
      { kind: 'slab', at: [0, 2, 0], half: [1, 0.125, 1], material: 'stone' },
    ], { rack: ['w-grenade'], weapons: { grenade: { ...KEYSTONE_GRENADE, blast: { ...KEYSTONE_GRENADE.blast, maxSpeed } } } });
    expect(codes(slab(20))).toContain('tunnelling');
    expect(codes(slab(11.9))).not.toContain('tunnelling');
  });
  it('weapon: a w- item needs its weapon, and every weapon must be a valid grenade under a valid key', () => {
    expect(codes(block('stone', ['w-big']))).toContain('weapon');
    expect(codes(block('stone', ['w-big'], { weapons: { big: KEYSTONE_GRENADE } }))).not.toContain('weapon');
    expect(codes(block('stone', ['marble'], { weapons: { big: { ...KEYSTONE_GRENADE, fuse: 'boom' as 'prox' } } }))).toContain('weapon');
    expect(codes(block('stone', ['marble'], { weapons: { Big: KEYSTONE_GRENADE } }))).toContain('weapon');
    expect(codes(block('stone', ['w-grenade']))).not.toContain('weapon'); // the built-in
  });
  it('capacity: the structure fits the engine but not with every rack item fired; count when the structure alone does not fit', () => {
    const wall = (nz: number, rack: RackItem[]) => tiny([{ kind: 'block', at: [-25, 0, -25], size: [50, 1, nz], material: 'stone' }], { rack, lot: { min: [-30, -30], max: [30, 30] }, launcher: { radius: 40, y: 1, dropY: 10 } });
    expect(ENGINE_MAX_BODIES.rapier).toBe(2500);
    expect(codes(wall(49, ['marble']))).not.toContain('capacity'); // 2450 + 1
    expect(codes(wall(50, ['marble']))).toContain('capacity'); // 2500 + 1
    expect(codes(wall(50, ['marble']))).not.toContain('count');
    expect(codes(wall(51, ['marble']))).toEqual(expect.arrayContaining(['count']));
    expect(codes(wall(51, ['marble']))).not.toContain('capacity');
  });
});

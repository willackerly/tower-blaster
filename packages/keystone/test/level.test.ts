import { describe, expect, it } from 'vitest';
import { combineFriction, TAG_BALL } from '@tb/engine-api';
import { compileLevel, decodeTag, encodeTag, type LevelDef, LEVELS, MATERIALS, ROLES, validateLevel } from '@tb/keystone';

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

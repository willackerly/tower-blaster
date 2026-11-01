// Scenario parts (docs/game/spectacle-mode.md, G2.3): a benchmark scene's
// bodies in a level, in order, at the level's scale, with roles by selector.
import { describe, expect, it } from 'vitest';
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { compileLevel, decodeTag, type LevelDef, MATERIALS, type Part, ROLE_ID, type ScenarioPart } from '@tb/keystone';
import { buildScenario, type Params } from '@tb/scenarios';

const level = (parts: Part[], extra: Partial<LevelDef> = {}): LevelDef => ({
  id: 'SP', name: 'scenario part', version: 1, world: 0, lot: { min: [-40, -40], max: [40, 40] }, crownLine: 2, objective: { kind: 'collapse', min: 0.3 },
  par: 2, rack: ['cannonball', 'cannonball'], launcher: { radius: 60, y: 2, dropY: 20 }, scoring: 'outcome', parts, ...extra,
});
const half = (b: BodyDesc) => (b.shape as { half: Vec3 }).half;

describe('scenario parts', () => {
  it.each([
    ['S3', { W: 12, H: 5, running: true }],
    ['S4', { N: 300, F: 4, H: 6, street: 3 }],
    ['S14', { towers: 4, W: 3, D: 2, H: 5, street: 2, vary: 0.5 }],
  ] as Array<[string, Params]>)('%s: the scenario\'s bodies, in order, positions times the pitch, sizes times h', (id, params) => {
    const src = buildScenario(id, params, 7).bodies;
    const c = compileLevel(level([{ kind: 'scenario', id, params, seed: 7, material: 'stone' }]));
    const h = c.frame.unit, p = c.frame.pitch * h;
    expect(c.scene.bodies).toHaveLength(src.length);
    expect(c.meta.n).toBe(src.length);
    const stone = MATERIALS[1];
    c.scene.bodies.forEach((b, i) => {
      const s = src[i]!;
      expect(b.pos).toEqual([s.pos[0] * p, s.pos[1] * h, s.pos[2] * p]);
      expect(half(b)).toEqual(half(s).map((x) => x * h));
      expect(b.rot).toEqual(s.rot);
      expect([b.density, b.friction, b.restitution]).toEqual([stone.density, stone.friction, stone.restitution]);
      expect(decodeTag(b.tag)).toEqual({ role: 'plain', part: 0 });
    });
  });

  it('S15: a Kapla tower with gap 0 keeps the planks\' exact layout, and drops the scenario\'s topple ball', () => {
    const params = { planks: 400, towers: 1 };
    const scene = buildScenario('S15', params, 2);
    expect(scene.inputs.length).toBe(1); // the topple ball
    const c = compileLevel(level([{ kind: 'scenario', id: 'S15', params, seed: 2, material: 'plaster', gap: 0 }], { unit: 0.1 }));
    expect(c.scene.inputs).toEqual([]);
    expect(c.scene.bodies.map((b) => b.pos)).toEqual(scene.bodies.map((b) => b.pos.map((x) => x * 0.1)));
    expect(c.scene.bodies.map(half)).toEqual(scene.bodies.map((b) => half(b).map((x) => x * 0.1)));
  });

  it('`at` offsets in cells (x, z) and h (y); other parts keep their own part index', () => {
    const block: Part = { kind: 'block', at: [20, 0, 0], size: [1, 2, 1], material: 'plaster', role: 'heritage' };
    const sc: ScenarioPart = { kind: 'scenario', id: 'S3', params: { W: 3, H: 2 }, material: 'plaster', at: [-5, 1, 2] };
    const c = compileLevel(level([block, sc]));
    const h = c.frame.unit, p = c.frame.pitch * h, src = buildScenario('S3', { W: 3, H: 2 }).bodies;
    expect(c.meta.n).toBe(2 + 6);
    expect(c.scene.bodies[2]!.pos).toEqual([(src[0]!.pos[0] - 5) * p, (src[0]!.pos[1] + 1) * h, 2 * p]);
    expect(Array.from(c.meta.part)).toEqual([0, 0, 1, 1, 1, 1, 1, 1]);
    expect(Array.from(c.meta.heritage)).toEqual([0, 1]);
  });

  describe('role selectors', () => {
    // S4 at F 3, H 4: towers of 36 cubes, tags 0, 1, 2 (the last one partial: 30 cubes, three in its top course).
    const params = { N: 102, F: 3, H: 4, street: 2 };
    const src = buildScenario('S4', params).bodies;
    const rolesOf = (rules: ScenarioPart['roles'], role?: ScenarioPart['role']) =>
      Array.from(compileLevel(level([{ kind: 'scenario', id: 'S4', params, material: 'plaster', roles: rules, ...(role ? { role } : {}) }])).meta.role);
    const ids = (role: 'crown' | 'heritage', got: number[]) => got.flatMap((r, i) => (r === ROLE_ID[role] ? [i] : []));
    const where = (f: (b: BodyDesc, i: number) => boolean) => src.flatMap((b, i) => (f(b, i) ? [i] : []));

    it('an empty rule picks every body; the default role is plain or the part\'s', () => {
      expect(ids('crown', rolesOf([{ role: 'crown' }]))).toEqual(src.map((_, i) => i));
      expect(new Set(rolesOf(undefined))).toEqual(new Set([ROLE_ID.plain]));
      expect(new Set(rolesOf(undefined, 'heritage'))).toEqual(new Set([ROLE_ID.heritage]));
    });
    it('by course (one, or a range), by tag (one or a list), by box: each as computed from the scenario\'s bodies', () => {
      expect(ids('crown', rolesOf([{ role: 'crown', course: 3 }]))).toEqual(where((b) => b.pos[1] === 3.5));
      expect(ids('crown', rolesOf([{ role: 'crown', course: [1, 2] }]))).toEqual(where((b) => b.pos[1] === 1.5 || b.pos[1] === 2.5));
      expect(ids('crown', rolesOf([{ role: 'crown', tag: 1 }]))).toEqual(where((b) => b.tag === 1));
      expect(ids('crown', rolesOf([{ role: 'crown', tag: [0, 2] }]))).toEqual(where((b) => b.tag !== 1));
      const box = { min: [-100, 0, -100] as Vec3, max: [0, 2, 100] as Vec3 };
      expect(ids('crown', rolesOf([{ role: 'crown', box }]))).toEqual(where((b) => b.pos[0] <= 0 && b.pos[1] <= 2));
    });
    it('top picks the highest body of each column, partial towers included', () => {
      const tops = where((b) => !src.some((o) => o.pos[0] === b.pos[0] && o.pos[2] === b.pos[2] && o.pos[1] > b.pos[1]));
      expect(tops).toHaveLength(27);
      expect(ids('crown', rolesOf([{ role: 'crown', top: true }]))).toEqual(tops);
      expect(where((b, i) => tops.includes(i) && b.tag === 2 && b.pos[1] === 2.5)).toHaveLength(6); // 30 = 27 + 3: six columns stop a course short
    });
    it('conditions in one rule must all hold; a later rule overrides an earlier one', () => {
      const r = rolesOf([{ role: 'crown', top: true }, { role: 'heritage', tag: 0 }, { role: 'plain', tag: 0, course: 0 }]);
      expect(ids('crown', r)).toEqual(where((b) => b.tag !== 0 && !src.some((o) => o.pos[0] === b.pos[0] && o.pos[2] === b.pos[2] && o.pos[1] > b.pos[1])));
      expect(ids('heritage', r)).toEqual(where((b) => b.tag === 0 && b.pos[1] > 1));
    });
  });

  it('the level hash changes with the scenario, its params, its seed, its offset and its gap, and with the scenario\'s bodies', () => {
    const base: ScenarioPart = { kind: 'scenario', id: 'S14', params: { towers: 2, W: 2, D: 2, H: 4, vary: 0.5 }, seed: 1, material: 'plaster' };
    const hash = (p: Partial<ScenarioPart>) => compileLevel(level([{ ...base, ...p }])).hash;
    const all = [hash({}), hash({ seed: 2 }), hash({ params: { ...base.params, H: 5 } }), hash({ at: [1, 0, 0] }), hash({ gap: 0 }), hash({ id: 'S3', params: { W: 4, H: 4 } })];
    expect(new Set(all).size).toBe(all.length);
    expect(hash({})).toBe(hash({})); // and is a pure function of the level
  });

  it('refuses an unknown scenario or param, naming it', () => {
    expect(() => compileLevel(level([{ kind: 'scenario', id: 'S99', material: 'plaster' }]))).toThrow(/unknown scenario S99; known: S1/);
    expect(() => compileLevel(level([{ kind: 'scenario', id: 'S3', params: { width: 3 }, material: 'plaster' }]))).toThrow(/S3 has no param width/);
  });

  it('compiles the 10k S4 city in well under a second', () => {
    const t0 = performance.now();
    const c = compileLevel(level([{ kind: 'scenario', id: 'S4', material: 'stone' }]));
    expect(c.meta.n).toBe(10_000);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
});

import { describe, expect, it } from 'vitest';
import { type BodyDesc, type CombineRule, combineFriction, type HostWorld, massOf, MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type ModeChange } from '@tb/engine-api';
import { stateHash } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { appliedMu, SLIDE, slideMu, slideScene } from '@tb/testkit';
import RAPIER from '@dimforge/rapier3d-simd-compat';
import { RapierEngine, RapierHost, RULES } from '../src/index.ts';

const cube = (pos: [number, number, number], density = 1): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density, friction: 0.6, restitution: 0, tag: 0,
});
const world: HostWorld = { gravity: [0, -9.81, 0], dt: 1 / 60, ground: { y: 0, friction: 0.6 }, sleep: true };
const on = (id: number, mode: typeof MODE_STATIC | typeof MODE_DYNAMIC, b: BodyDesc): ModeChange => ({ id, mode, pos: b.pos, rot: b.rot });

describe('RapierHost', () => {
  it('reports the weight of a resting body as a downward force on the static body under it', async () => {
    const table = [cube([0, 0.5, 0]), cube([0, 1.5, 0], 3)];
    const h = new RapierHost();
    await h.init(world, table);
    h.apply({ changes: [on(0, MODE_STATIC, table[0]!), on(1, MODE_DYNAMIC, table[1]!)], wake: [] });
    for (let i = 0; i < 60; i++) h.step();
    const s = h.read();
    expect(Array.from(s.ids)).toEqual([1]);
    expect(s.pos[1]).toBeCloseTo(1.5, 2);
    const c = s.contacts!;
    expect(Array.from(c.ids)).toEqual([0]);
    expect(c.force[0]).toBeCloseTo(0, 3);
    expect(c.force[1]! / (3 * 9.81)).toBeCloseTo(-1, 2);
    expect(c.force[2]).toBeCloseTo(0, 3);
    expect(c.magnitude[0]! / (3 * 9.81)).toBeCloseTo(1, 2);
    h.dispose();
  });

  it('reports a sideways push with the right sign', async () => {
    // A dynamic cube sliding in +x into a static one pushes it towards +x.
    const table = [cube([0, 0.5, 0]), cube([-1.2, 0.5, 0])];
    const h = new RapierHost();
    await h.init({ ...world, sleep: false }, table);
    h.apply({ changes: [on(0, MODE_STATIC, table[0]!), { ...on(1, MODE_DYNAMIC, table[1]!), linVel: [3, 0, 0] }], wake: [] });
    let fx = 0;
    for (let i = 0; i < 20; i++) { h.step(); const c = h.read().contacts!; if (c.ids.length) fx = Math.max(fx, c.force[0]!); }
    expect(fx).toBeGreaterThan(10);
    h.dispose();
  });

  it('off bodies do not collide; switching static to dynamic keeps the pose and starts at rest', async () => {
    const table = [cube([0, 0.5, 0]), cube([0, 1.5, 0])];
    const h = new RapierHost();
    await h.init(world, table);
    h.apply({ changes: [on(0, MODE_STATIC, table[0]!), on(1, MODE_DYNAMIC, table[1]!)], wake: [] });
    for (let i = 0; i < 10; i++) h.step();
    h.apply({ changes: [{ id: 0, mode: MODE_OFF }], wake: [1] });
    for (let i = 0; i < 40; i++) h.step();
    let s = h.read();
    expect(s.pos[1]).toBeCloseTo(0.5, 2); // fell through the disabled body onto the ground
    expect(h.modeOf(0)).toBe(MODE_OFF);
    h.apply({ changes: [{ id: 0, mode: MODE_DYNAMIC, pos: [3, 0.5, 0], rot: [0, 0, 0, 1] }], wake: [] });
    s = h.read();
    expect(Array.from(s.ids)).toEqual([0, 1]);
    expect(Array.from(s.pos.subarray(0, 3))).toEqual([3, 0.5, 0]);
    expect(Array.from(s.linVel.subarray(0, 3))).toEqual([0, 0, 0]);
    h.dispose();
  });

  it('leaves a body put at the pose it already has bit for bit (Rapier renormalises every rotation it is given)', async () => {
    let seed = 7;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) - 0.5;
    const table = Array.from({ length: 200 }, (_, i) => cube([3 * (i % 20), 0.5, 3 * Math.floor(i / 20)]));
    const h = new RapierHost();
    await h.init({ ...world, gravity: [0, 0, 0] }, table);
    h.apply({ changes: table.map((b, id) => {
      const q = [rand(), rand(), rand(), rand()], n = Math.hypot(...q);
      return { id, mode: MODE_DYNAMIC, pos: b.pos, rot: q.map((x) => x / n) as [number, number, number, number] };
    }), wake: [] });
    const before = h.read();
    const pose = (s: typeof before, n: number): ModeChange => ({ id: s.ids[n]!, mode: MODE_STATIC, pos: [s.pos[3 * n]!, s.pos[3 * n + 1]!, s.pos[3 * n + 2]!], rot: [s.rot[4 * n]!, s.rot[4 * n + 1]!, s.rot[4 * n + 2]!, s.rot[4 * n + 3]!] });
    h.apply({ changes: table.map((_, n) => pose(before, n)), wake: [] });
    h.apply({ changes: table.map((_, id) => ({ id, mode: MODE_DYNAMIC })), wake: [] }); // back to dynamic in place, to read the poses
    const after = h.read();
    expect(Array.from(after.pos)).toEqual(Array.from(before.pos));
    expect(Array.from(after.rot)).toEqual(Array.from(before.rot));
    h.dispose();
  });

  it('turning a sleeping body static wakes its sleeping neighbours, with or without a new pose (Rapier 0.21)', async () => {
    // Pinned because the tiers freeze rubble this way: each freeze wakes the
    // pile around it for a sleep timeout, and no wake-up flag avoids it.
    for (const shift of [null, 0, -0.001]) {
      const table = [cube([0, 0.5, 0]), cube([1, 0.5, 0])];
      const h = new RapierHost();
      await h.init(world, table);
      h.apply({ changes: [on(0, MODE_DYNAMIC, table[0]!), on(1, MODE_DYNAMIC, table[1]!)], wake: [] });
      let s = h.read();
      for (let i = 0; i < 600 && (s.awake[0] || s.awake[1]); i++) { h.step(); s = h.read(); }
      expect(Array.from(s.awake)).toEqual([0, 0]);
      const pose: Partial<ModeChange> = shift === null ? {} : { pos: [s.pos[0]! + shift, s.pos[1]!, s.pos[2]!], rot: [s.rot[0]!, s.rot[1]!, s.rot[2]!, s.rot[3]!] };
      h.apply({ changes: [{ id: 0, mode: MODE_STATIC, ...pose }], wake: [] });
      h.step();
      s = h.read();
      expect(Array.from(s.ids)).toEqual([1]);
      expect(Array.from(s.awake), `shift ${shift}`).toEqual([1]);
      h.dispose();
    }
  });

  it('rejects a bad batch without applying any of it', async () => {
    const table = [cube([0, 0.5, 0]), cube([0, 1.5, 0])];
    const h = new RapierHost();
    await h.init(world, table);
    expect(() => h.apply({ changes: [on(0, MODE_STATIC, table[0]!), { id: 1, mode: MODE_DYNAMIC }], wake: [] })).toThrow(/pose/);
    expect(h.modeOf(0)).toBe(MODE_OFF);
    expect(() => h.apply({ changes: [on(1, MODE_STATIC, table[1]!), on(0, MODE_STATIC, table[0]!)], wake: [] })).toThrow(/ascending/);
    expect(() => h.apply({ changes: [on(2, MODE_STATIC, table[0]!)], wake: [] })).toThrow(/capacity/);
    h.apply({ changes: [{ ...on(0, MODE_STATIC, table[0]!), body: table[0]! }], wake: [] }); // a first switch-on may describe the body
    expect(() => h.apply({ changes: [{ ...on(0, MODE_DYNAMIC, table[0]!), body: table[1]! }], wake: [] })).toThrow(/description is fixed/);
    expect(h.modeOf(0)).toBe(MODE_STATIC);
    expect(() => h.apply({ changes: [], wake: [0] })).toThrow(/not dynamic/);
    expect(h.modeOf(1)).toBe(MODE_OFF);
    h.dispose();
  });

  it('with every body dynamic it reproduces RapierEngine exactly', async () => {
    const scene = buildScenario('S1', { F: 3, H: 6 }, 1);
    const e = new RapierEngine();
    await e.init(scene);
    const h = new RapierHost();
    await h.init(scene, scene.bodies);
    h.apply({ changes: scene.bodies.map((b, id) => on(id, MODE_DYNAMIC, b)), wake: [] });
    for (let i = 0; i < 90; i++) { e.step(); h.step(); }
    const s = h.read();
    const snap = e.snapshot();
    expect(stateHash({ count: s.ids.length, pos: s.pos, rot: s.rot, linVel: s.linVel, angVel: s.angVel, awake: s.awake })).toBe(stateHash(snap));
    h.dispose();
    e.dispose();
  });

  describe('native lattice cells (voxels)', () => {
    const lat = { origin: [0, 0.5, 0] as [number, number, number], edge: 1, dims: [16, 3, 3] as [number, number, number], friction: 0.6 };

    it('report the weight of a body resting across two cells, split between them', async () => {
      const table = [cube([0, 0.5, 0]), cube([1, 0.5, 0]), cube([0.5, 1.5, 0], 2)];
      const h = new RapierHost();
      await h.init(world, table, [lat]);
      h.apply({ changes: [on(2, MODE_DYNAMIC, table[2]!)], wake: [], cells: [{ lattice: 0, i: 0, j: 0, k: 0, id: 0 }, { lattice: 0, i: 1, j: 0, k: 0, id: 1 }] });
      expect(h.modeOf(0)).toBe(MODE_STATIC);
      for (let i = 0; i < 30; i++) h.step();
      const c = h.read().contacts!;
      expect(Array.from(c.ids)).toEqual([0, 1]);
      for (const n of [0, 1]) expect(c.force[3 * n + 1]! / (2 * 9.81)).toBeCloseTo(-0.5, 2);
      h.dispose();
    });

    it('split a contact force only over the cells the body touches', async () => {
      // A ball on cell 0; cell 1 is within its bounding box but 0.2 m away.
      const ball: BodyDesc = { ...cube([0, 1.5, 0]), shape: { kind: 'sphere', radius: 0.5 } };
      const table = [cube([0, 0.5, 0]), cube([1, 0.5, 0]), ball];
      const h = new RapierHost();
      await h.init(world, table, [lat]);
      h.apply({ changes: [on(2, MODE_DYNAMIC, ball)], wake: [], cells: [{ lattice: 0, i: 0, j: 0, k: 0, id: 0 }, { lattice: 0, i: 1, j: 0, k: 0, id: 1 }] });
      for (let i = 0; i < 30; i++) h.step();
      const c = h.read().contacts!;
      expect(Array.from(c.ids)).toEqual([0]);
      expect(c.force[1]! / (massOf(ball) * 9.81)).toBeCloseTo(-1, 2);
      h.dispose();
    });

    it('have no internal seams: a frictionless cube slides across 16 cells without losing speed', async () => {
      const slider = { ...cube([0, 1.5, 0]), friction: 0 };
      const table = [...Array.from({ length: 16 }, (_, i) => cube([i, 0.5, 0])), slider];
      for (const sep of [false, true]) {
        const h = new RapierHost();
        await h.init({ ...world, sleep: false }, table, [{ ...lat, friction: 0 }]);
        const cells = sep ? [] : table.slice(0, 16).map((_, i) => ({ lattice: 0, i, j: 0, k: 0, id: i }));
        const statics = sep ? table.slice(0, 16).map((b, i) => on(i, MODE_STATIC, b)) : [];
        h.apply({ changes: [...statics, { ...on(16, MODE_DYNAMIC, slider), linVel: [3, 0, 0] }], wake: [], cells });
        for (let i = 0; i < 150; i++) h.step();
        const s = h.read();
        const vx = s.linVel[3 * s.ids.indexOf(16)]!;
        // Separate static boxes are the control: they catch the slider (the reason lattices are native).
        if (sep) expect(vx).toBeLessThan(2); else expect(vx).toBeCloseTo(3, 3);
        h.dispose();
      }
    });

    it('empty a cell and wake its cube as a dynamic body in the same batch', async () => {
      const table = [cube([0, 0.5, 0]), cube([0, 1.5, 0])];
      const h = new RapierHost();
      await h.init(world, table, [lat]);
      h.apply({ changes: [], wake: [], cells: [{ lattice: 0, i: 0, j: 0, k: 0, id: 0 }, { lattice: 0, i: 0, j: 1, k: 0, id: 1 }] });
      h.apply({ changes: [{ id: 1, mode: MODE_DYNAMIC, pos: table[1]!.pos, rot: table[1]!.rot }], wake: [], cells: [{ lattice: 0, i: 0, j: 1, k: 0, id: -1 }] });
      expect(h.modeOf(1)).toBe(MODE_DYNAMIC);
      for (let i = 0; i < 30; i++) h.step();
      const s = h.read();
      expect(s.pos[1]).toBeCloseTo(1.5, 2); // rests on the cell below
      expect(Array.from(s.contacts!.ids)).toEqual([0]);
      h.dispose();
    });
  });

  describe('HostWorld.frictionCombine', () => {
    // The testkit slide, on the ground and across native lattice cells (same frictions).
    const slide = async (rule: CombineRule | undefined, onCells: boolean) => {
      const scene = slideScene(rule);
      const h = new RapierHost();
      const slider = scene.bodies[0]!;
      if (!onCells) {
        await h.init(scene, scene.bodies);
        h.apply({ changes: [{ ...on(0, MODE_DYNAMIC, slider), linVel: slider.linVel }], wake: [] });
      } else {
        const table = [...Array.from({ length: 16 }, (_, i) => ({ ...cube([i, 0.5, 0]), friction: SLIDE.ground })), { ...slider, pos: [0, 1.5, 0] as [number, number, number] }];
        await h.init({ ...scene, ground: null }, table, [{ origin: [0, 0.5, 0], edge: 1, dims: [16, 1, 1], friction: SLIDE.ground }]);
        h.apply({ changes: [{ ...on(16, MODE_DYNAMIC, table[16]!), linVel: slider.linVel }], wake: [], cells: table.slice(0, 16).map((_, i) => ({ lattice: 0, i, j: 0, k: 0, id: i, rot: [0, 0, 0, 1] })) });
      }
      const vx = () => { const s = h.read(); return s.linVel[0]!; };
      h.step();
      const v1 = vx();
      for (let i = 0; i < 10; i++) h.step();
      const mu = appliedMu(v1, vx());
      const rules: number[] = [];
      (h as unknown as { world: RAPIER.World }).world.forEachCollider((c) => rules.push(c.frictionCombineRule()));
      h.dispose();
      return { mu, rules };
    };

    it.for(['average', 'min', 'max', 'multiply'] as const)('%s reaches every contact, ground and lattice cells alike', async (rule) => {
      for (const onCells of [false, true]) {
        const { mu, rules } = await slide(rule, onCells);
        // Measured within 1% on the ground and 2.1% across cells (max: 0.881 for 0.9); the closest rules are 11% apart.
        expect(Math.abs(mu / slideMu(rule) - 1), `on cells: ${onCells}`).toBeLessThan(0.03);
        expect(rules, `on cells: ${onCells}`).toEqual(Array(2).fill(RULES[rule]));
      }
    });

    it('defaults to average', async () => {
      for (const onCells of [false, true]) expect((await slide(undefined, onCells)).mu).toBe((await slide('average', onCells)).mu);
      expect(combineFriction('average', SLIDE.body, SLIDE.ground)).toBeCloseTo(0.6, 12);
    });
  });

  it.for(['average', 'min', 'max', 'multiply', undefined] as const)('HostWorld.restitutionCombine %s reaches every collider, ground and lattice cells alike, and the ground takes ground.restitution', async (rule) => {
    const table = [cube([0, 0.5, 0]), cube([0, 3, 0])];
    const h = new RapierHost();
    await h.init({ ...world, ground: { y: 0, friction: 0.6, restitution: 0.4 }, ...(rule ? { restitutionCombine: rule } : {}) }, table, [{ origin: [0, 0.5, 0], edge: 1, dims: [1, 1, 1], friction: 0.6 }]);
    h.apply({ changes: [on(1, MODE_DYNAMIC, table[1]!)], wake: [], cells: [{ lattice: 0, i: 0, j: 0, k: 0, id: 0, rot: [0, 0, 0, 1] }] });
    const rules: number[] = [], restitution: number[] = [];
    (h as unknown as { world: RAPIER.World }).world.forEachCollider((c) => { rules.push(c.restitutionCombineRule()); restitution.push(c.restitution()); });
    // Ground, the lattice's voxels, the dynamic cube; unset is average (Rapier's own).
    expect(rules).toEqual(Array(3).fill(RULES[rule ?? 'average']));
    expect(restitution[0]).toBeCloseTo(0.4, 6);
    h.dispose();
  });
});

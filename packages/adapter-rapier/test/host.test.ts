import { describe, expect, it } from 'vitest';
import { type BodyDesc, type HostWorld, MODE_DYNAMIC, MODE_OFF, MODE_STATIC, type ModeChange } from '@tb/engine-api';
import { stateHash } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { RapierEngine, RapierHost } from '../src/index.ts';

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

  it('rejects a bad batch without applying any of it', async () => {
    const table = [cube([0, 0.5, 0]), cube([0, 1.5, 0])];
    const h = new RapierHost();
    await h.init(world, table);
    expect(() => h.apply({ changes: [on(0, MODE_STATIC, table[0]!), { id: 1, mode: MODE_DYNAMIC }], wake: [] })).toThrow(/pose/);
    expect(h.modeOf(0)).toBe(MODE_OFF);
    expect(() => h.apply({ changes: [on(1, MODE_STATIC, table[1]!), on(0, MODE_STATIC, table[0]!)], wake: [] })).toThrow(/ascending/);
    expect(() => h.apply({ changes: [on(2, MODE_STATIC, table[0]!)], wake: [] })).toThrow(/capacity/);
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
});

import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { quatFromAxisAngle, quatMul } from '@tb/geom';
import { buildScenario, SCENARIOS } from '@tb/scenarios';
import { checkStorage, checkSupport, CUBE_ROTATIONS, latticesFromScene, looseColumns } from '../src/index.ts';

const count = (scene: SceneDesc) => latticesFromScene(scene, looseColumns).lattices.reduce((n, l) => n + l.count, 0);

const SMALL: Record<string, Record<string, number | boolean>> = {
  S1: { F: 4, H: 12 }, S2: { C: 12, depth: 2 }, S3: { W: 12, H: 6, running: true }, S4: { N: 900, F: 4, H: 10 },
  S5: { N: 900, F: 4, H: 10 }, S6: { N: 600 }, S7: { N: 600 }, S8: { floors: 5, bays: 2 }, S9: { H: 6 },
  S10: { F: 3, H: 5 }, S11: { N: 200 }, S12: { W: 9, H: 7, holeW: 3, holeH: 2, holeY: 1, running: true }, S13: { H: 6, deg: 4 },
  S15: { planks: 800 },
};

describe.each(Object.keys(SCENARIOS))('latticesFromScene on %s', (id) => {
  const scene = buildScenario(id, SMALL[id], 3);
  const built = latticesFromScene(scene, looseColumns);

  it('stores legal lattices whose cells hold their bodies at the exact cell pose', () => {
    const { lattices, latticeOf, cellOf } = built;
    for (const lat of lattices) {
      expect(checkStorage(lat)).toEqual([]);
      expect(checkSupport(lat, looseColumns)).toEqual([]);
    }
    let n = 0;
    cellOf.forEach((c, body) => {
      expect(c < 0).toBe(latticeOf[body]! < 0);
      if (c < 0) return;
      n++;
      const lat = lattices[latticeOf[body]!]!;
      const [i, j, k] = lat.coords(c);
      expect(lat.idAt(i, j, k)).toBe(body);
      const center = lat.center(i, j, k), p = scene.bodies[body]!.pos;
      for (let a = 0; a < 3; a++) expect(Math.abs(center[a]! - p[a]!)).toBeLessThan(1e-9 * Math.max(1, Math.abs(p[a]!)));
    });
    expect(n).toBe(lattices.reduce((m, l) => m + l.count, 0));
  });
});

describe('latticesFromScene coverage', () => {
  const one = (id: string, p = SMALL[id]) => {
    const { lattices } = latticesFromScene(buildScenario(id, p, 3), looseColumns);
    expect(lattices.length).toBeLessThanOrEqual(1);
    return lattices[0];
  };

  it('takes every cube of packed towers, a stack and a far-off tower', () => {
    for (const id of ['S1', 'S4', 'S5', 'S9', 'S10']) {
      const scene = buildScenario(id, SMALL[id], 3);
      expect(one(id)!.count, id).toBe(scene.bodies.length);
    }
  });

  it('leaves randomly rotated loose cubes and slab-and-rod towers active', () => {
    for (const id of ['S6', 'S7', 'S11', 'S8']) expect(one(id)?.count ?? 0, id).toBe(0);
  });

  it('keeps only the bottom layer of the stepped pyramid (each layer is offset by half a cube)', () => {
    const lat = one('S2')!;
    expect(lat.count).toBe(12 * 2);
    lat.forEach((_i, j) => expect(j).toBe(0));
  });

  it('keeps only the bottom row of a running-bond wall (the rest is off grid or unsupported)', () => {
    const lat = one('S3', { W: 12, H: 6, running: true })!;
    expect(lat.count).toBe(12);
    lat.forEach((_i, j) => expect(j).toBe(0));
    expect(one('S3', { W: 12, H: 6, running: false })!.count).toBe(72);
  });

  it('accepts any of the 24 cube orientations and records which', () => {
    const scene: SceneDesc = buildScenario('S1', { F: 1, H: 24 }, 1);
    scene.bodies.forEach((b, n) => { b.rot = CUBE_ROTATIONS[n]!; });
    const lat = latticesFromScene(scene, looseColumns).lattices[0]!;
    expect(lat.count).toBe(24);
    for (let j = 0; j < 24; j++) {
      const id = lat.idAt(...lat.nearest(scene.bodies[j]!.pos));
      expect(lat.rotAt(...lat.nearest(scene.bodies[j]!.pos))).toBe(id);
    }
  });

  it('rejects a cube that is off pose, tilted or moving, and everything it held up', () => {
    const base = () => buildScenario('S1', { F: 1, H: 10 }, 1);
    let s = base();
    s.bodies[4]!.pos = [1e-3, s.bodies[4]!.pos[1], 0];
    expect(count(s)).toBe(4);
    s = base();
    s.bodies[4]!.rot = quatMul(quatFromAxisAngle([0, 0, 1], 0.01), s.bodies[4]!.rot);
    expect(count(s)).toBe(4);
    s = base();
    s.bodies[4]!.linVel = [0, 0.1, 0];
    expect(count(s)).toBe(4);
  });

  it('needs a ground to rest on', () => {
    const s = buildScenario('S1', { F: 2, H: 3 }, 1);
    expect(count({ ...s, ground: null })).toBe(0);
    const lifted = { ...s, bodies: s.bodies.map((b) => ({ ...b, pos: [b.pos[0], b.pos[1] + 0.5, b.pos[2]] as typeof b.pos })) };
    expect(count(lifted)).toBe(0);
  });

  it('gives towers off a common grid their own lattices (street 6.5)', () => {
    const scene = buildScenario('S4', { N: 900, F: 4, H: 10, street: 6.5 }, 1);
    const { lattices } = latticesFromScene(scene, looseColumns);
    expect(lattices.length).toBeGreaterThan(1);
    expect(count(scene)).toBe(scene.bodies.length);
  });

  it('turns a gapped tower into one lattice per column, still legal and complete', () => {
    const scene = buildScenario('S1', { F: 3, H: 4, gap: 0.1 }, 1);
    const { lattices } = latticesFromScene(scene, looseColumns);
    expect(lattices).toHaveLength(9);
    expect(count(scene)).toBe(36);
  });
});

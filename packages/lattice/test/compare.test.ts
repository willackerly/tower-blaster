import { describe, expect, it } from 'vitest';
import type { Quat, SceneDesc, Snapshot, Vec3 } from '@tb/engine-api';
import { add, quatFromAxisAngle, quatMul, rotate } from '@tb/geom';
import { buildScenario } from '@tb/scenarios';
import { brokenBonds, compareBonds } from '../src/index.ts';

// A snapshot of the scene's own bodies with each pose mapped by f.
function snap(scene: SceneDesc, f: (p: Vec3, q: Quat, i: number) => { p: Vec3; q: Quat }): Snapshot {
  const n = scene.bodies.length;
  const s: Snapshot = { count: n, pos: new Float64Array(3 * n), rot: new Float64Array(4 * n), linVel: new Float64Array(3 * n), angVel: new Float64Array(3 * n), awake: new Uint8Array(n) };
  scene.bodies.forEach((b, i) => { const o = f(b.pos, b.rot, i); s.pos.set(o.p, 3 * i); s.rot.set(o.q, 4 * i); });
  return s;
}

describe('broken bonds', () => {
  const scene = buildScenario('S1', { F: 3, H: 4 }, 1); // 3 x 3 x 4 cubes, edge 1
  const bonds = 2 * (3 * 2) * 4 + 9 * 3; // x and z: 3 rows of 2 pairs per layer, 4 layers; y: 9 columns of 3 pairs

  it('finds every face-adjacent pair and none broken at rest', () => {
    const r = brokenBonds(scene, snap(scene, (p, q) => ({ p, q })));
    expect(r.pairs).toBe(bonds);
    expect(r.broken).toEqual([]);
  });

  it('ignores rigid motion and smooth bending of the whole tower', () => {
    const R = quatFromAxisAngle([0.3, 1, -0.2], 0.7);
    const rigid = snap(scene, (p, q) => ({ p: add(rotate(R, p), [5, 1, -3]), q: quatMul(R, q) }));
    expect(brokenBonds(scene, rigid).broken).toEqual([]);
    // Sway: each layer shifted 0.1 edge further along x and tilted 2 degrees more.
    const sway = snap(scene, (p, q) => ({ p: add(p, [0.1 * p[1], 0, 0]), q: quatMul(quatFromAxisAngle([0, 0, 1], -(2 * Math.PI / 180) * p[1]), q) }));
    expect(brokenBonds(scene, sway).broken).toEqual([]);
  });

  it('breaks every bond of a cube knocked out by 0.3 edge or turned by 20 degrees, and only those', () => {
    // Body 0 is a bottom corner cube: 3 neighbours.
    for (const f of [(p: Vec3, q: Quat) => ({ p: add(p, [-0.3, 0, 0]), q }), (p: Vec3, q: Quat) => ({ p, q: quatMul(quatFromAxisAngle([0, 1, 0], (20 * Math.PI) / 180), q) })]) {
      const s = snap(scene, (p, q, i) => (i === 0 ? f(p, q) : { p, q }));
      const r = brokenBonds(scene, s);
      expect(r.broken.length).toBe(3);
      expect(r.broken.every(([a, b]) => a === 0 || b === 0)).toBe(true);
      const c = compareBonds(scene, snap(scene, (p, q) => ({ p, q })), s);
      expect(c).toMatchObject({ bonds, brokenBondsRef: 0, brokenBondsTest: 3, brokenRef: 0, brokenTest: 4, jaccard: 0 });
    }
  });
});

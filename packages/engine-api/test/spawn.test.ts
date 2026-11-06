// Relative spawns' definition (spawn.ts): frames, the rigid motion a child inherits, and the checks.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type BodyMotion, checkSpawnFrom, headingBasis, headingOf, quatProduct, relativeBody, rotateByQuat, spawnAxes, type Vec3 } from '../src/index.ts';

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const child = (pos: Vec3, linVel: Vec3 = [0, 0, 0]): BodyDesc => ({ shape: { kind: 'sphere', radius: 0.1 }, pos, rot: [0, 0, 0, 1], linVel, angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag: 0 });
const parent: BodyMotion = { pos: [1, 2, 3], rot: [0.1, 0.2, 0.3, Math.sqrt(1 - 0.14)], linVel: [4, -1, 2], angVel: [0.3, -0.7, 1.1] };

describe('relative spawn (spawn.ts)', () => {
  it('every frame is a right-handed orthonormal basis; heading axes put local y on the velocity', () => {
    const vs: Vec3[] = [[1, 0, 0], [0, 0, -3], [0.1, 5, 0.2], [0, -1, 0], [1e-9, 0, 0], [3, 4, 0]];
    for (const v of vs) for (const axes of ['world', 'body', 'heading'] as const) {
      const [x, y, z] = spawnAxes({ ...parent, linVel: v }, axes);
      for (const [a, b, want] of [[x, x, 1], [y, y, 1], [z, z, 1], [x, y, 0], [y, z, 0], [z, x, 0]] as const) expect(dot(a, b)).toBeCloseTo(want, 14);
      const c = cross(x, y);
      for (let k = 0; k < 3; k++) expect(c[k]).toBeCloseTo(z[k]!, 14);
      if (axes === 'heading') expect(y).toEqual(headingOf(v));
    }
    // Below HEADING_MIN_SPEED: up. In level flight local x is level, across the heading.
    expect(headingOf([1e-9, 0, 0])).toEqual([0, 1, 0]);
    const [x] = headingBasis([0.6, 0, 0.8]);
    expect(x[1]).toBe(0);
    expect(dot(x, [0.6, 0, 0.8])).toBeCloseTo(0, 15);
  });

  it('a child takes the parent material point\'s velocity: V + w x r, plus its own in the frame', () => {
    for (const axes of ['world', 'body', 'heading'] as const) {
      const local: Vec3 = [0.5, -0.2, 0.9], own: Vec3 = [1, 2, -1];
      const c = relativeBody(parent, child(local, own), axes), f = spawnAxes(parent, axes);
      const r: Vec3 = [0, 1, 2].map((k) => f[0][k]! * local[0] + f[1][k]! * local[1] + f[2][k]! * local[2]) as Vec3;
      const v: Vec3 = [0, 1, 2].map((k) => f[0][k]! * own[0] + f[1][k]! * own[1] + f[2][k]! * own[2]) as Vec3;
      const wr = cross(parent.angVel, r);
      for (let k = 0; k < 3; k++) {
        expect(c.pos[k]).toBeCloseTo(parent.pos[k]! + r[k]!, 14);
        expect(c.linVel[k]).toBeCloseTo(parent.linVel[k]! + wr[k]! + v[k]!, 14);
        expect(c.angVel[k]).toBeCloseTo(parent.angVel[k]!, 14);
      }
      // Body axes compose rotations; the others keep the child's world rotation.
      expect(c.rot).toEqual(axes === 'body' ? quatProduct(parent.rot, [0, 0, 0, 1]) : [0, 0, 0, 1]);
    }
    // Body axes: rotateByQuat is the rotation of the quaternion (a quarter turn about z takes x to y).
    const q: [number, number, number, number] = [0, 0, Math.SQRT1_2, Math.SQRT1_2];
    const y = rotateByQuat(q, [1, 0, 0]);
    expect(y[0]).toBeCloseTo(0, 15); expect(y[1]).toBeCloseTo(1, 15);
  });

  it('children of one mass whose offsets and own velocities sum to zero carry the parent\'s momentum on, spin or no spin', () => {
    // Six offsets and velocities, centred (they sum to zero), in every frame.
    const d: Vec3[] = [[1, 0.2, 0], [-0.5, 0.7, 0.3], [-0.5, -0.9, -0.3], [0.3, 0, 1], [-0.1, 0, -0.6], [-0.2, 0, -0.4]];
    for (const axes of ['world', 'body', 'heading'] as const) {
      const kids = d.map((x) => relativeBody(parent, child(x, [2 * x[0], 2 * x[1], 2 * x[2]]), axes));
      const p = [0, 1, 2].map((k) => kids.reduce((a, c) => a + c.linVel[k]!, 0) / kids.length);
      for (let k = 0; k < 3; k++) expect(Math.abs(p[k]! - parent.linVel[k]!)).toBeLessThan(1e-14);
    }
  });

  it('refuses a malformed from', () => {
    expect(checkSpawnFrom({ body: 3 })).toEqual({ body: 3, axes: 'world' });
    expect(() => checkSpawnFrom({ body: -1 })).toThrow(/body id/);
    expect(() => checkSpawnFrom({ body: 1.5 })).toThrow(/body id/);
    expect(() => checkSpawnFrom({ body: 1, axes: 'up' as 'world' })).toThrow(/axes/);
    expect(() => checkSpawnFrom({ body: 1, at: 2 } as never)).toThrow(/unknown/);
  });
});

// axisSlack against the reference narrowphase it replays (geom/manifold.ts).
import { describe, expect, it } from 'vitest';
import type { Quat, Vec3 } from '@tb/engine-api';
import { NO_AXIS, quatNormalize, shapeManifold } from '@tb/geom';
import { AXIS_TIE, axisSlack } from './sat-slack.ts';

const half: Vec3 = [0.5, 0.5, 0.5];
const box = { kind: 'box' as const, half };
const axisOf = (A: { pos: Vec3; rot: Quat }, B: { pos: Vec3; rot: Quat }, margin: number, hint: number) =>
  shapeManifold(box, A.pos, A.rot, box, B.pos, B.rot, margin, true, hint)?.axis ?? null;

describe('axisSlack', () => {
  it('is the hysteresis band for two equal face separations, and names the axis across it', () => {
    // b sits 1 mm into a: a's y and b's y separate by -1e-3 each; b's must beat a's by 1e-4 + 2% of 1e-3.
    // Aligned edges tie exactly too, but no edge can win, so those ties do not matter.
    const A = { pos: [0, 0.5, 0] as Vec3, rot: [0, 0, 0, 1] as Quat }, B = { pos: [0, 1.499, 0] as Vec3, rot: [0, 0, 0, 1] as Quat };
    const r = axisSlack(half, A, half, B, NO_AXIS);
    expect(r.axis).toBe(1);
    expect(r.slack).toBeCloseTo(1.2e-4, 9);
    expect(r.alternatives).toEqual([]);
    expect(axisSlack(half, A, half, B, NO_AXIS, 2e-4).alternatives).toEqual([4]);
  });

  it('finds the near-tie of the pair the GPU first resolved the other way, and the GPU\'s axis across it (2026-10-25)', () => {
    const A = { pos: [0.5733687281608582, 10.592400550842285, -0.6739499568939209] as Vec3, rot: [0.00036478161928243935, 0.13314682245254517, 0.11063430458307266, 0.9849019646644592] as Quat };
    const B = { pos: [0.34440651535987854, 11.569979667663574, -0.6703762412071228] as Vec3, rot: [0.00011561578867258504, 0.12054425477981567, 0.1128678023815155, 0.9862707853317261] as Quat };
    expect(axisOf(A, B, 0.0938, 1)).toBe(1);
    const r = axisSlack(half, A, half, B, 1);
    expect(r.axis).toBe(1);
    expect(r.slack).toBeGreaterThan(2e-8);
    expect(r.slack).toBeLessThan(1e-7);
    expect(r.alternatives).toEqual([4]); // the GPU said 4
  });

  it('ignores a near-tie that cannot change the answer', () => {
    // A face comparison here sits 5.2e-7 m from its bar, but an edge (axis 8) wins by 0.015 m
    // either way: a GPU that answered a face would be a real mismatch, not a tie.
    const A = { pos: [0.30000001192092896, 10.5, -0.20000000298023224] as Vec3, rot: [-0.6435434818267822, 0.2219839245080948, 0.677493691444397, -0.2785269618034363] as Quat };
    const B = { pos: [1.276542067527771, 10.829812049865723, -0.2335587590932846] as Vec3, rot: [0.5427453517913818, 0.15268386900424957, -0.013176726177334785, 0.8257974982261658] as Quat };
    expect(axisOf(A, B, 0.1, NO_AXIS)).toBe(8);
    const r = axisSlack(half, A, half, B, NO_AXIS);
    expect(r.axis).toBe(8);
    expect(r.slack).toBeGreaterThan(1e-2);
    expect(r.alternatives).toEqual([]);
  });

  it('follows near-ties more than one flip deep', () => {
    // Edge on edge. Moving b 0.44 mm (and turning it 1e-6) takes the reference from face 4 to face 1,
    // which needs two comparisons within 1 mm of their bars to go the other way: inverting one at a
    // time reaches only edge 14.
    const A = { pos: [0, 0, 0] as Vec3, rot: [0, 0, 0, 1] as Quat };
    const B = { pos: [0.6706944427220152, 0.7805238033179194, 0.09670647263992577] as Vec3, rot: [0.3537868970925423, 0.3539107505358927, -0.14599282950313694, 0.8533862582877814] as Quat };
    const moved = { pos: [0.6703836128705282, 0.7807039076275204, 0.09645065833237373] as Vec3, rot: [0.35378685437759005, 0.35391029955478837, -0.14599308976058664, 0.8533864185003223] as Quat };
    expect(axisOf(A, B, 0.2, NO_AXIS)).toBe(4);
    expect(axisOf(A, moved, 0.2, NO_AXIS)).toBe(1);
    expect(axisSlack(half, A, half, B, NO_AXIS, 1e-3).alternatives).toEqual([1, 14]);
  });

  it('no move of b by a quarter of the slack changes the reference axis, and a move by a quarter of tol ends at an alternative', () => {
    // sep is 1-Lipschitz in b's position and each bar moves (1 + rel) times as much, so a move by
    // delta changes every gap by under 2.05 delta. A move of slack / 4 cannot flip a comparison that
    // matters. A move of tol / 4 can flip only comparisons within tol / 2 of their bars, every one of
    // which the search over near-ties branches on, so where it ends is the axis or an alternative.
    const TOL = 4e-3;
    let seed = 7;
    const r = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
    const rot = (): Quat => quatNormalize([r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5 + 1.2 * r()]);
    // Half the pairs are near-symmetric (b turned 45 deg about y, then x; edge on edge), where edges tie.
    const s45 = Math.sin(Math.PI / 8), c45 = Math.cos(Math.PI / 8), tilt: Quat = [s45 * c45, s45 * c45, -s45 * s45, c45 * c45];
    const near = (): Quat => quatNormalize(tilt.map((x) => x + 1e-4 * (r() - 0.5)) as Quat);
    const move = (B: { pos: Vec3; rot: Quat }, d: number) => {
      const e = [r() - 0.5, r() - 0.5, r() - 0.5], el = Math.hypot(...e);
      return { pos: B.pos.map((x, i) => x + (e[i]! / el) * d) as Vec3, rot: B.rot };
    };
    let checked = 0, edges = 0, nearTol = 0, flipped = 0;
    for (let k = 0; k < 3000; k++) {
      const sym = k % 2 === 1;
      const A = { pos: [0, 0, 0] as Vec3, rot: sym ? [0, 0, 0, 1] as Quat : rot() };
      const dir = sym ? [1 + 1e-3 * r(), 1 + 1e-3 * r(), 1e-3 * r()] : [r() - 0.5, r() - 0.5, r() - 0.5], len = Math.hypot(...dir), dist = sym ? 1.2 + 0.2 * r() : 0.8 + 0.6 * r();
      const B = { pos: dir.map((x) => (x / len) * dist) as Vec3, rot: sym ? near() : rot() };
      const hint = r() < 0.3 ? NO_AXIS : Math.floor(6 * r());
      const axis = axisOf(A, B, 0.2, hint);
      if (axis === null) continue;
      const { axis: replayed, slack, alternatives } = axisSlack(half, A, half, B, hint, TOL);
      expect(replayed).toBe(axis);
      // Each single flip within tol is one of the searched paths.
      if (slack < TOL) { nearTol++; expect(alternatives.length).toBeGreaterThan(0); }
      const after = axisOf(A, move(B, slack / 4), 0.2, hint);
      if (after === null) continue; // the margin cull (presence), not an axis choice
      expect(after, JSON.stringify({ k, A, B, hint, slack })).toBe(axis);
      checked++;
      if (axis >= 6) edges++;
      if (alternatives.length === 0) continue;
      for (let t = 0; t < 16; t++) {
        const got = axisOf(A, move(B, TOL / 4), 0.2, hint);
        if (got === null) continue;
        expect([axis, ...alternatives], JSON.stringify({ k, A, B, hint, got })).toContain(got);
        if (got !== axis) flipped++;
      }
    }
    // Seed 7: 2996 checked, 1928 edge wins, 102 within 4 mm of flipping, 18 moves that flipped.
    expect(checked).toBeGreaterThan(2500);
    expect(edges).toBeGreaterThan(1000);
    expect(nearTol).toBeGreaterThan(10);
    expect(flipped).toBeGreaterThan(5);
  });
});

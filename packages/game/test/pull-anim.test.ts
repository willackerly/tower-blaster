// The pull drawn (pull-anim.ts, playtest PT17): the slide's poses, the snapshot patch that must leave the
// snapshot as it was, and the ghost outline. CPU only; the game page's capture is pull-e2e.test.ts.
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@tb/engine-api';
import { ghostOutline, PULL_GHOST_MS, PULL_SLIDE_STEPS, pullAnimFor, pullPose, rotate, withPulled } from '../src/pull-anim.ts';

const HALF: [number, number, number] = [0.25, 0.25, 0.25];
const a = pullAnimFor(3, [1, 0.25, 0], [0, 0, 0, 1], HALF, [1, 3, 10], 1000);

describe('pull animation', () => {
  it('slides horizontally toward the camera, a block depth and more, eased out, shrinking over its second half', () => {
    expect(a.dir).toEqual([0, 0, 1]);
    expect(a.slide).toBeCloseTo(2.2 * 0.25, 9);
    expect(pullPose(a, 0)).toBeNull();
    expect(pullPose(a, PULL_SLIDE_STEPS + 1)).toBeNull();
    let last = 0, lastScale = 1;
    for (let k = 1; k <= PULL_SLIDE_STEPS; k++) {
      const p = pullPose(a, k)!;
      expect(p.pos[0]).toBe(1);
      expect(p.pos[1]).toBe(0.25);
      expect(p.pos[2]).toBeGreaterThan(last);
      expect(p.scale).toBeLessThanOrEqual(lastScale);
      last = p.pos[2];
      lastScale = p.scale;
    }
    // Ten steps in (the playtest's check): out of its slot by more than half its depth, still drawn.
    const p10 = pullPose(a, 10)!;
    expect(p10.pos[2]).toBeGreaterThan(0.25);
    expect(p10.scale).toBeGreaterThan(0.3);
    expect(p10.scale).toBeLessThan(1);
    expect(last).toBeCloseTo(a.slide, 9);
    expect(lastScale).toBeCloseTo(0.15, 9);
  });

  it('a turned block slides by its extent along the way out', () => {
    const q: [number, number, number, number] = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)]; // 45 degrees about y
    const t = pullAnimFor(0, [0, 0, 0], q, [0.5, 0.25, 0.25], [0, 0, 5], 0);
    expect(t.slide).toBeCloseTo(2.2 * (0.5 + 0.25) * Math.SQRT1_2, 6);
    expect(rotate(q, [1, 0, 0]).map((x) => +x.toFixed(9))).toEqual([+Math.SQRT1_2.toFixed(9), 0, -Math.SQRT1_2.toFixed(9)]);
    // Straight above: any horizontal way out.
    expect(pullAnimFor(0, [0, 0, 0], [0, 0, 0, 1], HALF, [0, 9, 0], 0).dir).toEqual([0, 0, 1]);
  });

  it('withPulled draws the slot at its slide pose, active and awake, and leaves the snapshot exactly as it was', () => {
    const s = emptySnapshot(5);
    s.tier = new Uint8Array(5);
    s.pos.set([1, 0.25, 0], 9);
    s.rot.set([0, 0, 0, 1], 12);
    s.tier[3] = 255; // a tombstone
    s.awake[3] = 0;
    const before = { pos: s.pos.slice(), rot: s.rot.slice(), tier: s.tier.slice(), awake: s.awake.slice() };
    let seen: { pos: number[]; tier: number; awake: number } | null = null;
    const p = withPulled(s, a, 10, () => { seen = { pos: [...s.pos.slice(9, 12)], tier: s.tier![3]!, awake: s.awake[3]! }; });
    expect(p).not.toBeNull();
    expect(seen).toEqual({ pos: [...new Float64Array(p!.pos)], tier: 0, awake: 1 });
    expect({ pos: s.pos, rot: s.rot, tier: s.tier, awake: s.awake }).toEqual(before);
    // Outside the slide: the draw sees the tombstone.
    let tier = -1;
    expect(withPulled(s, a, 20, () => { tier = s.tier![3]!; })).toBeNull();
    expect(tier).toBe(255);
    // The snapshot is put back even when the draw throws.
    expect(() => withPulled(s, a, 5, () => { throw new Error('boom'); })).toThrow('boom');
    expect({ pos: s.pos, rot: s.rot, tier: s.tier, awake: s.awake }).toEqual(before);
  });

  it('the ghost outlines the twelve edges where the block stood, every corner once, and fades out', () => {
    const g = ghostOutline(a, 0)!;
    const pts = Array.from({ length: g.xyzr.length / 4 }, (_, k) => [g.xyzr[4 * k]!, g.xyzr[4 * k + 1]!, g.xyzr[4 * k + 2]!]);
    // Every bead is on the box's surface, on an edge (two of its three coordinates at a face).
    for (const [x, y, z] of pts) {
      const at = [Math.abs(x! - 1), Math.abs(y! - 0.25), Math.abs(z!)].filter((d) => Math.abs(d - 0.25) < 1e-6).length;
      expect(at).toBeGreaterThanOrEqual(2);
    }
    const key = (p: number[]) => p.map((x) => x.toFixed(5)).join();
    expect(new Set(pts.map(key)).size).toBe(pts.length);
    for (const sx of [0.75, 1.25]) for (const sy of [0, 0.5]) for (const sz of [-0.25, 0.25]) expect(pts.some((p) => key(p) === key([sx, sy, sz]))).toBe(true);
    expect(g.colours.length).toBe(pts.length);
    const r0 = g.xyzr[3]!, rLate = ghostOutline(a, 0.9 * PULL_GHOST_MS)!.xyzr[3]!;
    expect(r0).toBeGreaterThan(0);
    expect(rLate).toBeLessThan(r0 / 2);
    expect(ghostOutline(a, PULL_GHOST_MS)).toBeNull();
    expect(ghostOutline(a, -1)).toBeNull();
  });
});

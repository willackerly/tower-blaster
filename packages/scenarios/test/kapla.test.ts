import { describe, expect, it } from 'vitest';
import type { BodyDesc, SpawnEvent } from '@tb/engine-api';
import { buildScenario, KAPLA_SCALE, layout, plankCount, STOREY } from '../src/index.ts';
import { fitShape } from '../src/kapla.ts';

type Box = { pos: number[]; half: number[] };
const boxOf = (b: BodyDesc): Box => {
  if (b.shape.kind !== 'box') throw new Error('S15 planks are boxes');
  return { pos: b.pos, half: b.shape.half };
};

/**
 * Static support of every plank: the patches where it rests on the planks
 * (or the floor) directly under it, and how far its centre lies inside their
 * convex hull (negative: outside, so it tips). Assumes axis-aligned planks,
 * which S15 builds.
 */
function supportMargins(boxes: Box[]): number[] {
  const EPS = 1e-7;
  const byTop = new Map<string, number[]>();
  const yKey = (y: number) => Math.round(y * 1e5).toString();
  boxes.forEach((b, i) => {
    const k = yKey(b.pos[1]! + b.half[1]!);
    (byTop.get(k) ?? byTop.set(k, []).get(k)!).push(i);
  });
  return boxes.map((b) => {
    const bottom = b.pos[1]! - b.half[1]!;
    const x0 = b.pos[0]! - b.half[0]!, x1 = b.pos[0]! + b.half[0]!, z0 = b.pos[2]! - b.half[2]!, z1 = b.pos[2]! + b.half[2]!;
    const pts: Array<[number, number]> = [];
    if (Math.abs(bottom) < EPS) pts.push([x0, z0], [x1, z0], [x1, z1], [x0, z1]);
    else
      for (const i of byTop.get(yKey(bottom)) ?? []) {
        const o = boxes[i]!;
        if (Math.abs(o.pos[1]! + o.half[1]! - bottom) > EPS) continue;
        const ax = Math.max(x0, o.pos[0]! - o.half[0]!), bx = Math.min(x1, o.pos[0]! + o.half[0]!);
        const az = Math.max(z0, o.pos[2]! - o.half[2]!), bz = Math.min(z1, o.pos[2]! + o.half[2]!);
        if (bx - ax > EPS && bz - az > EPS) pts.push([ax, az], [bx, az], [bx, bz], [ax, bz]);
      }
    return insideHull(pts, b.pos[0]!, b.pos[2]!);
  });
}

/** Signed distance from (x, z) to the edge of the convex hull of pts: positive inside, -Infinity with no support. */
function insideHull(pts: Array<[number, number]>, x: number, z: number): number {
  if (pts.length < 3) return -Infinity;
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const half = (list: Array<[number, number]>) => {
    const h: Array<[number, number]> = [];
    for (const q of list) {
      while (h.length >= 2 && cross(h[h.length - 2]!, h[h.length - 1]!, q) <= 0) h.pop();
      h.push(q);
    }
    return h.slice(0, -1);
  };
  const hull = [...half(p), ...half([...p].reverse())]; // counter-clockwise
  if (hull.length < 3) return -Infinity;
  let d = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const a = hull[i]!, b = hull[(i + 1) % hull.length]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    d = Math.min(d, cross(a, b, [x, z]) / len);
  }
  return d;
}

const planksOf = (s: ReturnType<typeof buildScenario>) => s.bodies.map(boxOf);

describe('S15 Kapla tower', () => {
  it('the hull check sees a plank hanging off its support', () => {
    const base = { pos: [0, 1 / 6, 0], half: [2.5, 1 / 6, 0.5] };
    expect(supportMargins([base, { pos: [0, 0.5, 0], half: [2.5, 1 / 6, 0.5] }])[1]).toBeCloseTo(0.5, 9);
    expect(supportMargins([base, { pos: [2.6, 0.5, 0], half: [2.5, 1 / 6, 0.5] }])[1]).toBeCloseTo(-0.1, 9);
    expect(supportMargins([base, { pos: [9, 0.5, 0], half: [2.5, 1 / 6, 0.5] }])[1]).toBe(-Infinity);
  });

  it.each([
    ['default 10k', {}],
    ['one tower, no spire, no jitter', { towers: 1, spire: 0, jitter: 0, planks: 3000 }],
    ['wide base, many setbacks', { cells: 9, setbacks: 6, taper: 0.2, planks: 6000 }],
    ['1-cell column', { cells: 1, towers: 1, planks: 400 }],
  ])('every plank rests with its centre over its support (%s)', (_, over) => {
    const boxes = planksOf(buildScenario('S15', { topple: false, ...over }, 3));
    const m = supportMargins(boxes);
    const worst = m.reduce((a, b) => Math.min(a, b), Infinity);
    // Thinnest by design: a pillar standing wholly on one plank, 1/6 unit (3.9 mm) from its centre to its thin edge.
    expect(worst).toBeGreaterThan(0.1);
  });

  it.each([[1000, 0.05], [10000, 0.02], [100000, 0.02]])('fits %i planks within %f', (target, tol) => {
    const s = buildScenario('S15', { planks: target, topple: false });
    expect(Math.abs(s.bodies.length - target) / target).toBeLessThan(tol);
  });

  it('counts planks without building them, for the shape the scenario fits', () => {
    const s = buildScenario('S15', { topple: false });
    const shape = fitShape({ cells: 0, towers: 5, setbacks: 4, taper: 0.35, spire: 0.15 }, 10000, 15);
    expect(plankCount(shape)).toBe(s.bodies.length);
    expect(Math.max(...s.bodies.map((b) => b.tag))).toBe(shape.storeys); // the cap is storey `storeys`
  });

  it.each([
    ['default 10k', {}],
    ['wide base, many setbacks', { cells: 9, setbacks: 6, taper: 0.2, planks: 6000 }],
    ['1-cell column', { cells: 1, towers: 1, planks: 400 }],
  ])('every pillar carries a flat plank, at setbacks and at the top too (%s)', (_, over) => {
    const boxes = planksOf(buildScenario('S15', { topple: false, ...over }, 3));
    const flats = boxes.filter((b) => b.half[1]! < 0.5);
    const yKey = (y: number) => Math.round(y * 1e5);
    const byBottom = new Map<number, Box[]>();
    for (const b of flats) { const k = yKey(b.pos[1]! - b.half[1]!); (byBottom.get(k) ?? byBottom.set(k, []).get(k)!).push(b); }
    const overlap = (a: Box, b: Box, ax: number) => Math.min(a.pos[ax]! + a.half[ax]!, b.pos[ax]! + b.half[ax]!) - Math.max(a.pos[ax]! - a.half[ax]!, b.pos[ax]! - b.half[ax]!);
    const bare = boxes.filter((p) => p.half[1]! > 1).filter((p) => !(byBottom.get(yKey(p.pos[1]! + p.half[1]!)) ?? []).some((f) => overlap(p, f, 0) > 0.1 && overlap(p, f, 2) > 0.1));
    expect(bare).toEqual([]);
    // The top is the cap: an A layer and a B layer over the last footprint.
    const top = Math.max(...boxes.map((b) => b.pos[1]! + b.half[1]!));
    expect(boxes.filter((b) => Math.abs(b.pos[1]! + b.half[1]! - top) < 1e-6).every((b) => b.half[1]! < 0.5)).toBe(true);
  });

  it('the 100k default stands about as tall as the 27.46 m record', () => {
    const s = buildScenario('S15', { planks: 100000, topple: false });
    const top = Math.max(...planksOf(s).map((b) => b.pos[1]! + b.half[1]!));
    expect(top * KAPLA_SCALE).toBeGreaterThan(26);
    expect(top * KAPLA_SCALE).toBeLessThan(31);
  });

  it('footprints only shrink going up, and satellites keep a cell of air from the centre', () => {
    const segs = layout({ cells: 9, storeys: 120, towers: 5, setbacks: 4, taper: 0.35, spire: 0.15 });
    const cellsOf = (rects: number[][]) => {
      const out = new Set<string>();
      for (const [x0, x1, z0, z1] of rects) for (let i = x0!; i < x1!; i++) for (let k = z0!; k < z1!; k++) out.add(`${i},${k}`);
      return out;
    };
    for (let i = 1; i < segs.length; i++) {
      const lo = cellsOf(segs[i - 1]!.rects), hi = cellsOf(segs[i]!.rects);
      for (const c of hi) expect(lo.has(c)).toBe(true);
      expect(segs[i]!.from).toBe(segs[i - 1]!.to);
    }
    const [centre, ...sats] = segs[0]!.rects;
    for (const r of sats) {
      const gapX = Math.max(r[0]! - centre![1]!, centre![0]! - r[1]!), gapZ = Math.max(r[2]! - centre![3]!, centre![2]! - r[3]!);
      expect(Math.max(gapX, gapZ)).toBe(1);
    }
    expect(segs[segs.length - 1]!.to).toBe(120);
  });

  it('the topple ball starts clear of the tower and heads for its axis', () => {
    for (const toppleSide of [0, 37, 200]) {
      const s = buildScenario('S15', { planks: 2000, toppleSide });
      const ball = (s.inputs[0] as SpawnEvent).body;
      expect(s.inputs[0]!.step).toBe(120);
      const [x, , z] = ball.pos, [vx, , vz] = ball.linVel;
      expect((x * vz - z * vx) / Math.hypot(vx, vz)).toBeCloseTo(0, 9); // the line of flight passes through the axis
      expect(x * vx + z * vz).toBeLessThan(0);
      // Unit-world speed: at real size (scale KAPLA_SCALE, 1/sqrt(scale) as fast) it is toppleSpeed m/s.
      expect(Math.hypot(vx, vz) / Math.sqrt(KAPLA_SCALE) * KAPLA_SCALE).toBeCloseTo(10, 9);
    }
    expect(STOREY * KAPLA_SCALE).toBeCloseTo(0.1326, 4);
  });
});

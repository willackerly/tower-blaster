// The hall's geometry (hall.ts), on its CPU twin: known rays and invariants.
import { describe, expect, it } from 'vitest';
import { HALL_MAT, hallArch, hallInside, hallLattice, hallRibs, hallScaled, hallTraceCpu, OLYMPIA, type HallParams } from '../src/hall.ts';
import type { V3 } from '../src/math.ts';

const H = OLYMPIA;
const { R, yc, spring } = hallArch(H);
const n = hallRibs(H);
const ribZ = (k: number) => (k - (n - 1) / 2) * H.bay;
const unit = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
}

describe('hall geometry (Olympia)', () => {
  it('the arch passes through the springs and the crown; 13 ribs inside the end screens', () => {
    expect(Math.hypot(H.span / 2, H.spring - yc)).toBeCloseTo(R, 9);
    expect(yc + R).toBeCloseTo(H.crown, 9);
    expect(spring * 180 / Math.PI).toBeGreaterThan(60);
    expect(n).toBe(13);
    expect(Math.abs(ribZ(0)) + H.ribWidth / 2).toBeLessThan(H.length / 2);
  });

  it('straight up between ribs: the crown lantern at the crown; off-centre, clear glass then roof panels', () => {
    const z = ribZ(6) + H.bay / 2;
    const up = hallTraceCpu(H, [0, 1.7, z], [0, 1, 0]);
    expect(up.mat).toBe(HALL_MAT.lantern);
    expect(up.t).toBeCloseTo(H.crown - 1.7, 6);
    expect(up.n[1]).toBeCloseTo(-1, 9);
    const glass = hallTraceCpu(H, [5, 1.7, z], [0, 1, 0]);
    expect(glass.mat).toBe(HALL_MAT.glass);
    expect(glass.t).toBeCloseTo(yc + Math.sqrt(R * R - 25) - 1.7, 6);
    expect(hallTraceCpu(H, [22, 1.7, z], [0, 1, 0]).mat).toBe(HALL_MAT.panel);
  });

  it('straight up under a rib: its bottom chord, 2.1 m below the glass', () => {
    const hit = hallTraceCpu(H, [5, 1.7, ribZ(6)], [0, 1, 0]);
    expect(hit.mat).toBe(HALL_MAT.iron);
    expect(hit.t).toBeCloseTo(yc + Math.sqrt((R - H.ribDepth) ** 2 - 25) - 1.7, 6);
  });

  it('level rays: a column on a bay line, else the gallery front or the outer wall; the end screen along the hall', () => {
    expect(hallTraceCpu(H, [0, 1, ribZ(6)], [1, 0, 0])).toMatchObject({ mat: HALL_MAT.iron });
    expect(hallTraceCpu(H, [0, 1, ribZ(6)], [1, 0, 0]).t).toBeCloseTo(H.span / 2 - H.column, 6);
    const wall = hallTraceCpu(H, [0, 1, ribZ(6) + H.bay / 2], [1, 0, 0]);
    expect(wall.mat).toBe(HALL_MAT.wall);
    expect(wall.t).toBeCloseTo(H.span / 2 + H.galleryDepth, 6);
    const deck = hallTraceCpu(H, [0, H.gallery - H.deck / 2, ribZ(6) + H.bay / 2], [1, 0, 0]);
    expect(deck.t).toBeCloseTo(H.span / 2, 6);
    const end = hallTraceCpu(H, [0, 20, 0], [0, 0, 1]);
    expect(end.mat).toBe(HALL_MAT.screen);
    expect(end.t).toBeCloseTo(H.length / 2, 6);
    expect(hallTraceCpu(H, [0, 3, 0], [0, 0, -1]).mat).toBe(HALL_MAT.wall);
  });

  it('every ray from inside hits something inside the hall\'s envelope, facing the ray, mirror-symmetric in x', () => {
    const r = rng(7);
    let misses = 0;
    for (let i = 0; i < 4000; i++) {
      const o: V3 = [(r() - 0.5) * 40, 0.2 + r() * 20, (r() - 0.5) * 120];
      const d = unit([r() - 0.5, r() - 0.3, r() - 0.5]);
      const hit = hallTraceCpu(H, o, d);
      if (hit.mat === HALL_MAT.none) { misses++; continue; }
      const p = o.map((x, k) => x + hit.t * d[k]!) as V3;
      expect(Math.abs(p[0])).toBeLessThanOrEqual(H.span / 2 + H.galleryDepth + 1e-6);
      expect(p[1]).toBeLessThanOrEqual(H.crown + 1e-6);
      expect(Math.abs(p[2])).toBeLessThanOrEqual(H.length / 2 + 1e-6);
      expect(hit.n[0] * d[0] + hit.n[1] * d[1] + hit.n[2] * d[2]).toBeLessThanOrEqual(1e-9);
      const m = hallTraceCpu(H, [-o[0], o[1], o[2]], [-d[0], d[1], d[2]]);
      expect(m.mat).toBe(hit.mat);
      expect(m.t).toBeCloseTo(hit.t, 6);
    }
    // Only rays heading down at the floor (which the hall leaves to the renderer's floor) miss.
    expect(misses).toBeGreaterThan(0);
    expect(misses).toBeLessThan(4000);
  });

  it('a ray down misses (the floor is the renderer\'s); a ray through a rib\'s web hole reaches the glass', () => {
    expect(hallTraceCpu(H, [0, 5, 0], [0, -1, 0]).mat).toBe(HALL_MAT.none);
    // Along the rib plane's normal (z), at web height: holes and bars both occur.
    const mats = Array.from({ length: 200 }, (_, i) => {
      const th = 0.3 + 0.001 * i, r = R - H.ribDepth / 2; // 5 m of rib at mid-web
      const p: V3 = [r * Math.sin(th), yc + r * Math.cos(th), ribZ(6) - 2];
      return hallTraceCpu(H, p, [0, 0, 1]).mat;
    });
    expect(mats).toContain(HALL_MAT.iron);
    expect(mats.some((m) => m !== HALL_MAT.iron)).toBe(true);
  });

  it('the lattice: crossing diagonals of the given bar width', () => {
    expect(hallLattice(0, 0, 1.6, 0.1)).toBe(true);
    expect(hallLattice(0.8, 0, 1.6, 0.1)).toBe(false);
    expect(hallLattice(0.8, 0.5, 1.6, 0.1)).toBe(true);
    let on = 0;
    const r = rng(3);
    for (let i = 0; i < 20000; i++) if (hallLattice(r() * 10, r(), 1.6, 0.1)) on++;
    // Two bars of width w per panel p, crossing: about 2 w sqrt(2) / p minus the overlap.
    expect(on / 20000).toBeCloseTo((2 * 0.1 * Math.SQRT2) / 1.6, 1);
  });

  it('the front-to-back walk over the bay lines finds what testing every one finds', () => {
    const r = rng(11);
    const rays: Array<[V3, V3]> = [];
    for (let i = 0; i < 20000; i++) {
      const o: V3 = [(r() - 0.5) * 50, 0.2 + r() * 25, (r() - 0.5) * 130];
      rays.push([o, unit([r() - 0.5, r() - 0.35, r() - 0.5])]);
    }
    // Level across the hall (d.z exactly 0), from on and beside the bay lines and their columns' and ribs' edges.
    for (let k = 0; k < n; k++) for (const dz of [0, H.ribWidth / 2, H.column, H.column + 1e-9, -H.column, 1.3]) {
      for (const d of [[1, 0, 0], unit([1, 1, 0]), unit([-0.2, 1, 0]), [0, 0, 1], [0, 0, -1]] as V3[]) rays.push([[3, 4, ribZ(k) + dz], d]);
    }
    let ribHits = 0;
    for (const [o, d] of rays) {
      const walk = hallTraceCpu(H, o, d), every = hallTraceCpu(H, o, d, true);
      expect(walk.mat).toBe(every.mat);
      expect(walk.t).toBe(every.t);
      if (walk.mat === HALL_MAT.iron) ribHits++;
    }
    expect(ribHits).toBeGreaterThan(1000);
  });

  it('inside: above the floor, within the walls and end screens, under the vault', () => {
    expect(hallInside(H, [0, 1.7, 0])).toBe(true);
    expect(hallInside(H, [H.span / 2 + 1, 2, 60])).toBe(true); // in an aisle, under the gallery
    expect(hallInside(H, [0, H.crown - 0.01, 0])).toBe(true);
    expect(hallInside(H, [0, H.crown + 0.01, 0])).toBe(false);
    expect(hallInside(H, [0, -0.01, 0])).toBe(false);
    expect(hallInside(H, [H.span / 2 + H.galleryDepth + 0.01, 1, 0])).toBe(false);
    expect(hallInside(H, [0, 1, H.length / 2 + 0.01])).toBe(false);
    expect(hallInside(H, [H.span / 2, H.spring + 1, 0])).toBe(false); // above the aisle's ceiling, outside the vault
  });

  it('scaled: every length times s, the same hits at s times the distance', () => {
    const s = 0.5, h = hallScaled(H, s);
    expect(h.span).toBe(H.span * s);
    expect(h.bay).toBe(H.bay * s);
    expect(h.clear).toBe(H.clear);
    const r = rng(5);
    let same = 0;
    for (let i = 0; i < 2000; i++) {
      const o: V3 = [(r() - 0.5) * 50, 0.2 + r() * 25, (r() - 0.5) * 130], d = unit([r() - 0.5, r() - 0.35, r() - 0.5]);
      const a = hallTraceCpu(H, o, d), b = hallTraceCpu(h, o.map((x) => x * s) as V3, d);
      // The balustrade's rails and lattice are a fixed size (a person's), so they may differ.
      if (a.mat === HALL_MAT.rail || b.mat === HALL_MAT.rail) continue;
      if (a.mat === b.mat && (a.mat === HALL_MAT.none || Math.abs(b.t - a.t * s) < 1e-6 * (1 + a.t))) same++;
    }
    expect(same).toBeGreaterThan(0.97 * 2000);
  });

  it('takes other proportions: a smaller hall still encloses its rays', () => {
    const small: HallParams = { ...H, span: 30, crown: 18, spring: 8, length: 60, bay: 6 };
    const hit = hallTraceCpu(small, [0, 1.7, 3], [0, 1, 0]);
    expect(hit.t).toBeCloseTo(18 - 1.7, 6);
  });
});

describe('the render bench\'s hall (bench.ts real-hall)', () => {
  it('is scaled until each world\'s eye is inside it, with room to spare', async () => {
    const { buildWorld, hallSizeFor } = await import('../src/bench.ts');
    for (const [world, n] of [['near', 10_000], ['near', 100_000], ['far', 10_000], ['far', 100_000]] as const) {
      const { eye } = buildWorld(world, n);
      const s = hallSizeFor(eye);
      expect(hallInside(hallScaled(H, s), eye)).toBe(true);
      expect(hallInside(hallScaled(H, s), eye.map((x) => x * 1.1) as V3)).toBe(true);
      if (s > 1) expect(hallInside(hallScaled(H, s - 0.25), eye.map((x) => x * 1.1) as V3)).toBe(false);
    }
    expect(hallSizeFor([0, 1.7, 0])).toBe(1);
  });
});

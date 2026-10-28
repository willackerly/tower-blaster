// The blast definition (blast.ts): what every engine's kick must match.
import { describe, expect, it } from 'vitest';
import { blastArea, blastKick, blastWeight, checkBlast, DEFAULT_BLAST_MAX_DV, MAX_BLAST_EXCLUDE } from '../src/index.ts';

describe('blast definition', () => {
  const b = checkBlast({ centre: [0, 0, 0], radius: 4, impulse: 100, maxDv: 1e9 });

  it('fills defaults: linear falloff, the speed cap, no exclusions', () => {
    const d = checkBlast({ centre: [1, 2, 3], radius: 1, impulse: 0 });
    expect(d.falloff).toBe(1);
    expect(d.maxDv).toBe(DEFAULT_BLAST_MAX_DV);
    expect(d.exclude).toEqual([]);
  });

  it('pushes radially by impulse * (1 - d/R)^falloff * area / m', () => {
    // A unit cube of 2 kg at d = 1 along +x: 100 * 0.75 * 1 / 2.
    expect(blastKick(b, 0, [1, 0, 0], 2, 1)).toEqual([37.5, 0, 0]);
    // Off-axis, quadratic falloff, area 0.25, 0.125 kg at d = 2: 100 * 0.25 * 0.25 / 0.125 = 50.
    const q = checkBlast({ ...b, falloff: 2 });
    const k = blastKick(q, 0, [0, 2 * Math.SQRT1_2, -2 * Math.SQRT1_2], 0.125, 0.25)!;
    expect(Math.hypot(...k)).toBeCloseTo(50, 12);
    expect(k[1]).toBeCloseTo(-k[2], 12);
    expect(k[0]).toBe(0);
    // Flat falloff: the same at every distance inside.
    const flat = checkBlast({ ...b, falloff: 0 });
    expect(blastKick(flat, 0, [3.99, 0, 0], 1, 1)).toEqual([100, 0, 0]);
  });

  it('a flat core, then the falloff over the rest of the radius', () => {
    const c = checkBlast({ ...b, core: 0.5, falloff: 2 });
    expect(blastWeight(c, 0)).toBe(1);
    expect(blastWeight(c, 2)).toBe(1);
    expect(blastWeight(c, 3)).toBe(0.25);
    expect(blastWeight(c, 3.9)).toBeCloseTo(0.0025, 15);
  });

  it('area is the mean silhouette: a quarter of the surface', () => {
    expect(blastArea({ kind: 'box', half: [0.5, 0.5, 0.5] })).toBe(1.5);
    expect(blastArea({ kind: 'box', half: [1, 0.5, 0.25] })).toBe(2 * (0.5 + 0.125 + 0.25));
    expect(blastArea({ kind: 'sphere', radius: 2 })).toBe(4 * Math.PI);
  });

  it('a heavier body of the same size moves slower; a body on the centre goes straight up', () => {
    const light = blastKick(b, 0, [0, 2, 0], 1, 1)!, heavy = blastKick(b, 0, [0, 2, 0], 4, 1)!;
    expect(light[1]).toBeCloseTo(4 * heavy[1], 12);
    expect(blastKick(b, 0, [0, 0, 0], 1, 1)).toEqual([0, 100, 0]);
  });

  it('nothing at or beyond the radius, for excluded ids, or past the speed cap', () => {
    expect(blastKick(b, 0, [4, 0, 0], 1, 1)).toBeNull();
    expect(blastKick(b, 0, [0, 0, 5], 1, 1)).toBeNull();
    expect(blastKick(checkBlast({ ...b, exclude: [7] }), 7, [1, 0, 0], 1, 1)).toBeNull();
    expect(blastKick(checkBlast({ ...b, exclude: [7] }), 6, [1, 0, 0], 1, 1)).not.toBeNull();
    expect(blastKick(checkBlast({ ...b, maxDv: 10 }), 0, [0, -1, 0], 1, 1)).toEqual([0, -10, 0]);
  });

  it('refuses blasts no engine should apply', () => {
    const ok = { centre: [0, 0, 0] as [number, number, number], radius: 1, impulse: 1 };
    expect(() => checkBlast({ ...ok, radius: 0 })).toThrow(/radius/);
    expect(() => checkBlast({ ...ok, radius: Infinity })).toThrow(/radius/);
    expect(() => checkBlast({ ...ok, impulse: -1 })).toThrow(/impulse/);
    expect(() => checkBlast({ ...ok, centre: [0, NaN, 0] })).toThrow(/centre/);
    expect(() => checkBlast({ ...ok, falloff: 9 })).toThrow(/falloff/);
    expect(() => checkBlast({ ...ok, falloff: 1.5 })).toThrow(/falloff/);
    expect(() => checkBlast({ ...ok, core: 1 })).toThrow(/core/);
    expect(() => checkBlast({ ...ok, maxDv: -1 })).toThrow(/maxDv/);
    expect(() => checkBlast({ ...ok, exclude: [1.5] })).toThrow(/exclude/);
    expect(() => checkBlast({ ...ok, exclude: Array.from({ length: MAX_BLAST_EXCLUDE + 1 }, (_, i) => i) })).toThrow(/exclude/);
  });
});

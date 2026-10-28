import { describe, expect, it } from 'vitest';
import { binOf, buildFrame, cellOf, DV_EDGES, type FrameInput, pitchZ, sectorOf, TOP_FIELDS } from '@tb/audio';

// Camera at the origin looking down -z, right = +x.
const base = (bodies: { pos: number[]; vel: number[]; prev: number[]; mat?: number }[], over: Partial<FrameInput> = {}): FrameInput => ({
  n: bodies.length,
  pos: bodies.flatMap((b) => b.pos), vel: bodies.flatMap((b) => b.vel), prevVel: bodies.flatMap((b) => b.prev),
  material: bodies.map((b) => b.mat ?? 0),
  metres: 1, camera: { pos: [0, 0, 0], right: [1, 0, 0] }, dt: 1 / 60, dvMin: 0.25, materials: 2, sectors: 4, top: 8, ...over,
});

describe('buildFrame (the audio tap reference)', () => {
  it('counts a body whose velocity changed by more than dvMin, and nothing at rest', () => {
    const f = buildFrame(base([
      { pos: [0, 0, -10], vel: [0, 0, 0], prev: [0, 0, 0] }, // resting
      { pos: [0, 0, -10], vel: [0, -0.16, 0], prev: [0, 0, 0] }, // one step of free fall: below dvMin
      { pos: [0, 0, -10], vel: [0, 0, 0], prev: [0, -3, 0] }, // landed at 3 m/s, dead ahead
    ]));
    expect(f.counts.reduce((a, b) => a + b, 0)).toBe(1);
    const c = cellOf(0, binOf(3), sectorOf(0, 4), 4);
    expect(f.counts[c]).toBe(1);
    expect(f.a2[c]).toBeCloseTo((3 / 10) ** 2, 6);
    expect([...f.top]).toEqual([3, 10, 0, 0, Math.fround(pitchZ(2))].map(Math.fround));
  });

  it('pans by the camera right vector, clamps distance to 0.5 m and skips silent bodies', () => {
    const f = buildFrame(base([
      { pos: [10, 0, 0], vel: [1, 0, 0], prev: [0, 0, 0] }, // hard right
      { pos: [-10, 0, 0], vel: [1, 0, 0], prev: [0, 0, 0] }, // hard left
      { pos: [0, 0, -0.1], vel: [1, 0, 0], prev: [0, 0, 0], mat: 1 }, // too close: 0.5 m
      { pos: [0, 0, -5], vel: [9, 0, 0], prev: [0, 0, 0], mat: -1 }, // silent
    ]));
    expect(f.counts[cellOf(0, binOf(1), 3, 4)]).toBe(1);
    expect(f.counts[cellOf(0, binOf(1), 0, 4)]).toBe(1);
    expect(f.a2[cellOf(1, binOf(1), 2, 4)]).toBeCloseTo(4, 6);
    expect(f.top.length / TOP_FIELDS).toBe(3);
  });

  it('converts units with the world scale, bins dv twice per bin and keeps the K loudest, loudest first', () => {
    expect(DV_EDGES.map((e) => binOf(e * 1.01))).toEqual([0, 1, 2, 3, 4, 5]);
    expect(binOf(1e3)).toBe(DV_EDGES.length - 1);
    const bodies = Array.from({ length: 20 }, (_, i) => ({ pos: [0, 0, -4 * 2], vel: [0, i + 1, 0], prev: [0, 0, 0] }));
    const f = buildFrame(base(bodies, { metres: 0.5, top: 5 }));
    expect(f.top.length).toBe(5 * TOP_FIELDS);
    expect(f.top[0]).toBeCloseTo(10, 5); // 20 units/s * 0.5 m
    expect(f.top[1]).toBeCloseTo(4, 5); // 8 units * 0.5 m
    for (let j = 1; j < 5; j++) expect(f.top[j * TOP_FIELDS]!).toBeLessThan(f.top[(j - 1) * TOP_FIELDS]!);
    expect(f.counts.reduce((a, b) => a + b, 0)).toBe(20);
  });

  it('gives each slot a fixed standard-normal pitch', () => {
    const z = Array.from({ length: 20000 }, (_, i) => pitchZ(i));
    const mean = z.reduce((a, b) => a + b, 0) / z.length, sd = Math.sqrt(z.reduce((a, b) => a + (b - mean) ** 2, 0) / z.length);
    expect(Math.abs(mean)).toBeLessThan(0.03);
    expect(sd).toBeCloseTo(1, 1);
    expect(pitchZ(7)).toBe(pitchZ(7));
  });
});

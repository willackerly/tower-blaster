import { describe, expect, it } from 'vitest';
import { buildFrame, DV_EDGES, FrameTap, type TapParams, TOP_FIELDS } from '@tb/audio';
import { rng } from '@tb/scenarios';

const P = (over: Partial<TapParams> = {}): TapParams => ({ metres: 0.25, camera: { pos: [1, 2, 30], right: [0.6, 0, -0.8] }, dvMin: 0.25, dt: 1 / 60, top: 8, ...over });

describe('FrameTap (the incremental audio tap)', () => {
  it('matches buildFrame, the reference, frame after frame', () => {
    const r = rng(7), n = 3000, mats = 3;
    const material = Array.from({ length: n }, (_, i) => (i % 17 === 0 ? -1 : i % mats));
    const pos = Float64Array.from({ length: 3 * n }, () => 40 * r() - 20);
    let vel = new Float64Array(3 * n);
    const tap = new FrameTap({ materials: mats, sectors: 4 });
    tap.setMaterials(material);
    tap.frame({ count: n, pos, linVel: vel }, P()); // first frame: records only
    for (let f = 0; f < 5; f++) {
      const prevVel = vel;
      // Most bodies still, some knocked hard, a few with exactly equal dv (ties).
      vel = Float64Array.from(prevVel, (v, k) => (k % 3 === 0 && r() < 0.3 ? v + 30 * (r() - 0.5) : k % 999 === 0 ? v + 8 : v));
      const p = P({ top: f + 4 });
      const got = tap.frame({ count: n, pos, linVel: vel }, p);
      const want = buildFrame({ n, pos, vel, prevVel, material, metres: p.metres, camera: { pos: [...p.camera.pos], right: [...p.camera.right] }, dt: p.dt, dvMin: p.dvMin, materials: mats, sectors: 4, top: p.top });
      expect(got.counts).toEqual(want.counts);
      for (let c = 0; c < want.a2.length; c++) expect(got.a2[c]).toBeCloseTo(want.a2[c]!, 4);
      expect(got.top.length).toBe(want.top.length);
      for (let j = 0; j < want.top.length; j++) expect(got.top[j]).toBeCloseTo(want.top[j]!, 5);
      expect(want.counts.reduce((a, b) => a + b, 0)).toBeGreaterThan(100);
    }
  });

  it('a new slot or a reset only records: a ball spawned fast is not an impact', () => {
    const tap = new FrameTap({ materials: 1, sectors: 2 });
    tap.setMaterials([0, 0]);
    const pos = [0, 0, 0, 1, 0, 0, 2, 0, 0];
    const total = (f: ReturnType<FrameTap['frame']>) => f.counts.reduce((a, b) => a + b, 0);
    expect(total(tap.frame({ count: 1, pos, linVel: [5, 0, 0] }, P({ metres: 1 })))).toBe(0);
    tap.setMaterial(1, 0);
    tap.setMaterial(2, 0);
    // Slots 1 and 2 appear at 30 m/s; slot 0 stops (a real impact).
    const f = tap.frame({ count: 3, pos, linVel: [0, 0, 0, 30, 0, 0, 30, 0, 0] }, P({ metres: 1 }));
    expect(total(f)).toBe(1);
    expect(f.top[0]).toBeCloseTo(5, 6);
    tap.reset();
    expect(total(tap.frame({ count: 3, pos, linVel: [9, 0, 0, 0, 0, 0, 0, 0, 0] }, P({ metres: 1 })))).toBe(0);
  });

  it('adds up the steps between its frames: a stop over three substeps is one hit', () => {
    const tap = new FrameTap({ materials: 1, sectors: 1 });
    tap.setMaterials([0]);
    const pos = [0, 0, -2];
    tap.frame({ count: 1, pos, linVel: [0, -0.6, 0] }, P({ metres: 1 }));
    // Each substep alone changes 0.2 m/s (below dvMin); the tap, called once after all three, sees 0.6.
    const f = tap.frame({ count: 1, pos, linVel: [0, 0, 0] }, P({ metres: 1 }));
    expect(f.counts[1]).toBe(1); // 0.6 m/s: bin 1 (0.5 to 1)
    expect(f.top[0]).toBeCloseTo(0.6, 6);
    expect(DV_EDGES[1]).toBe(0.5);
    expect(f.top.length).toBe(TOP_FIELDS);
  });

  it('top 0 reports no voices and silent or unmapped slots never count', () => {
    const tap = new FrameTap({ materials: 2, sectors: 1 });
    tap.setMaterials([0, -1, 5]);
    const pos = [0, 0, -1, 0, 0, -1, 0, 0, -1, 0, 0, -1];
    tap.frame({ count: 4, pos, linVel: new Float64Array(12) }, P({ metres: 1 }));
    const f = tap.frame({ count: 4, pos, linVel: [3, 0, 0, 3, 0, 0, 3, 0, 0, 3, 0, 0] }, P({ metres: 1, top: 0 }));
    expect(f.counts.reduce((a, b) => a + b, 0)).toBe(1); // slot 0 only: 1 is silent, 2 has no such material, 3 is past the map
    expect(f.top.length).toBe(0);
  });
});

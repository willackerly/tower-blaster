// Ice on the CPU: surface words (surface.ts), the URL knobs and the analytic
// path through a box (ice.ts) that the ice shader runs, checked against
// geometry worked out by hand. The GPU side is render-ice.test.ts.
import { describe, expect, it } from 'vitest';
import { CRACK_MAX, DEFAULT_ICE, fresnelDielectric, iceExit, icePath, iceUniforms, ICE_KNOBS, ICE_SPECTRUM, packSurface, parseIceOptions, refractRay, unpackSurface, writeIceOptions, type V3 } from '../src/index.ts';

const norm = (v: V3): V3 => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };

describe('surface words', () => {
  it('zero is the default surface, and ice round-trips with its crack', () => {
    expect(unpackSurface(0)).toEqual({ kind: 'default', crack: 0, at: [-1, -1, -1], seed: 0 });
    expect(packSurface({})).toBe(packSurface({ kind: 'default', crack: 0, at: [0, 0, 0], seed: 0 }));
    expect(packSurface({}) & 0xf).toBe(0);
    const w = packSurface({ kind: 'ice', crack: 5, at: [1, -1, 3 / 7], seed: 1234 });
    expect(w & 0xf).toBe(1);
    const s = unpackSurface(w);
    expect(s.kind).toBe('ice');
    expect(s.crack).toBe(5);
    expect(s.seed).toBe(1234);
    expect(s.at[0]).toBeCloseTo(1, 12);
    expect(s.at[1]).toBeCloseTo(-1, 12);
    expect(s.at[2]).toBeCloseTo(3 / 7, 12);
  });

  it('clamps the crack level and seed, snaps the origin to the 8-step grid, and refuses unknown kinds', () => {
    expect(unpackSurface(packSurface({ kind: 'ice', crack: 99 })).crack).toBe(CRACK_MAX);
    expect(unpackSurface(packSurface({ kind: 'ice', crack: -3 })).crack).toBe(0);
    expect(unpackSurface(packSurface({ kind: 'ice', seed: 1e9 })).seed).toBe(0xffff);
    for (let x = -1; x <= 1; x += 0.01) {
      const got = unpackSurface(packSurface({ kind: 'ice', at: [x, 0, 0] })).at[0];
      expect(Math.abs(got - x)).toBeLessThanOrEqual(1 / 7 + 1e-12);
    }
    expect(() => packSurface({ kind: 'glass' as never })).toThrow(/surface kind/);
  });
});

describe('ice knobs (URL keys ice.<knob>)', () => {
  it('reads every knob, refuses unknown ones, out-of-range values and fractional bounces, and writes back only what differs', () => {
    expect(parseIceOptions(new URLSearchParams())).toEqual(DEFAULT_ICE);
    const q = new URLSearchParams('ice.ior=1.5&ice.absorb=2&ice.bounces=3&ice.glint=0');
    const p = parseIceOptions(q);
    expect(p).toEqual({ ...DEFAULT_ICE, ior: 1.5, absorb: 2, bounces: 3, glint: 0 });
    const out = new URLSearchParams();
    writeIceOptions(p, out);
    expect(parseIceOptions(out)).toEqual(p);
    expect([...out.keys()].sort()).toEqual(['ice.absorb', 'ice.bounces', 'ice.glint', 'ice.ior']);
    expect(() => parseIceOptions(new URLSearchParams('ice.shiny=1'))).toThrow(/not an ice knob/);
    expect(() => parseIceOptions(new URLSearchParams('ice.ior=0.5'))).toThrow(/from 1 to 2.5/);
    expect(() => parseIceOptions(new URLSearchParams('ice.bounces=1.5'))).toThrow(/whole number/);
    expect(() => parseIceOptions(new URLSearchParams('ice.absorb='))).toThrow();
    for (const [k, r] of Object.entries(ICE_KNOBS)) expect(DEFAULT_ICE[k as keyof typeof DEFAULT_ICE]).toBeGreaterThanOrEqual(r.min);
  });

  it('uniforms are per world unit: a world of quarter-metre units absorbs a quarter as much per unit', () => {
    const u1 = iceUniforms(DEFAULT_ICE, 1), u4 = iceUniforms(DEFAULT_ICE, 0.25);
    expect(u1.absorb).toEqual(ICE_SPECTRUM.map((s) => s * DEFAULT_ICE.absorb));
    (u4.absorb as number[]).forEach((x, k) => expect(x).toBeCloseTo((u1.absorb as number[])[k]! * 0.25, 12));
    expect(u4.glintCell).toBeCloseTo(DEFAULT_ICE.glintSize * 4, 12);
  });
});

describe('the path through a box (icePath, the shader twin)', () => {
  const h: V3 = [0.5, 0.5, 0.5];

  it('Fresnel: 2% head-on for ice (n 1.31), all of it past the critical angle, and the same both ways below it', () => {
    expect(fresnelDielectric(1, 1.31)).toBeCloseTo(((1.31 - 1) / (1.31 + 1)) ** 2, 6);
    const crit = Math.asin(1 / 1.31);
    expect(fresnelDielectric(Math.cos(crit + 0.01), 1 / 1.31)).toBe(1);
    expect(fresnelDielectric(Math.cos(crit - 0.05), 1 / 1.31)).toBeLessThan(1);
    // Stokes: reflectance is the same from either side for angles related by Snell's law.
    const ti = 0.4, tt = Math.asin(Math.sin(ti) / 1.31);
    expect(fresnelDielectric(Math.cos(ti), 1.31)).toBeCloseTo(fresnelDielectric(Math.cos(tt), 1 / 1.31), 9);
  });

  it('head-on, a ray goes straight through: exits the far face after 2 h, unbent, no bounce', () => {
    const p = icePath([0.1, 0.2, 0.5], [0, 0, -1], h, 1.31, 2);
    expect(p.escaped).toBe(true);
    expect(p.bounces).toBe(0);
    expect(p.len).toBeCloseTo(1, 12);
    expect(p.first).toBeCloseTo(1, 12);
    expect(p.axis).toBe(2);
    p.d.forEach((x, k) => expect(x).toBeCloseTo([0, 0, -1][k]!, 12));
    expect(p.t).toBeCloseTo(1 - fresnelDielectric(1, 1 / 1.31), 12);
  });

  it('through two parallel faces the ray leaves parallel to how it came in (Snell twice), shifted sideways', () => {
    const din = norm([0.3, 0, -1]);
    const inside = refractRay(din, [0, 0, 1], 1 / 1.31);
    const p = icePath([-0.3, 0, 0.5], inside, h, 1.31, 2);
    expect(p.escaped && p.bounces === 0 && p.axis === 2).toBe(true);
    p.d.forEach((x, k) => expect(x).toBeCloseTo(din[k]!, 9));
    // Lateral shift: the ray bends toward the normal inside, so it lands short of the straight line.
    expect(p.p[0]).toBeLessThan(-0.3 + din[0] / -din[2]);
  });

  it('a ray steep to a side face reflects inside (total internal reflection) and leaves by another face', () => {
    // Entering the top at 40 deg it bends to 29.4 deg, so it meets the side face at 60.6 deg: past the
    // critical 49.8 (any top entry under 57.7 deg that reaches a side does), reflects, and leaves by the bottom.
    const din: V3 = [Math.sin(0.698), -Math.cos(0.698), 0];
    const inside = refractRay(din, [0, 1, 0], 1 / 1.31);
    const p = icePath([0, 0.5, 0], inside, h, 1.31, 2);
    expect(p.escaped).toBe(true);
    expect(p.bounces).toBe(1);
    expect(p.axis).toBe(1); // out through the bottom
    expect(p.len).toBeGreaterThan(p.first);
    // Without bounces it is given up on.
    const q = icePath([0, 0.5, 0], inside, h, 1.31, 0);
    expect(q.escaped).toBe(false);
    expect(q.t).toBe(0.5);
  });

  it('every escaping ray: inside the box all along, length at least the first leg, exit on the face named, energy share in (0, 1]', () => {
    let seed = 7;
    const r = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    for (let i = 0; i < 2000; i++) {
      const hh: V3 = [0.05 + r(), 0.05 + r(), 0.05 + r()];
      const ax = Math.floor(r() * 3), sg = r() < 0.5 ? -1 : 1;
      const p0: V3 = hh.map((x, k) => (k === ax ? sg * x : (2 * r() - 1) * x)) as V3;
      const n: V3 = [0, 0, 0]; n[ax] = sg;
      let v = norm([r() - 0.5, r() - 0.5, r() - 0.5]);
      if (v[0] * n[0] + v[1] * n[1] + v[2] * n[2] > 0) v = v.map((x) => -x) as V3;
      const inside = refractRay(v, n, 1 / 1.31);
      const p = icePath(p0, inside, hh, 1.31, 3);
      expect(p.len + 1e-9).toBeGreaterThanOrEqual(p.first);
      p.p.forEach((x, k) => expect(Math.abs(x)).toBeLessThanOrEqual(hh[k]! * (1 + 1e-9)));
      if (p.escaped) {
        expect(Math.abs(Math.abs(p.p[p.axis]!) - hh[p.axis]!)).toBeLessThan(1e-9);
        expect(p.t).toBeGreaterThan(0);
        expect(p.t).toBeLessThanOrEqual(1);
        expect(Math.hypot(...p.d)).toBeCloseTo(1, 9);
      }
    }
  });

  it('iceExit: an axis-parallel ray does not divide by zero', () => {
    const e = iceExit([0, 0, 0], [0, 1, 0], h);
    expect(e).toEqual({ s: 0.5, axis: 1 });
  });
});

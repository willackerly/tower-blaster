// The renderer's data path: CPU-side packing and references here, GPU
// culling and drawing in headless Chromium (SwiftShader without a GPU).
// Correctness only: timings from here are never performance results.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptySnapshot, TAG_BALL, type BodyDesc } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { Body, readStruct, Shape, TIER } from '@tb/schema';
import { RapierHost } from '@tb/adapter-rapier';
import { TieredEngine } from '@tb/lattice';
import { isSoftwareAdapter, loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { ADAPT_MAX, ADAPT_REF, adaptedExposure, HAZY_DAY, linearToSrgb, lookByName, parseRealOptions, REAL_DEFAULTS, REAL_KNOBS, realLook, writeRealOptions, CLEAR_DAY, MIE_H, mieExtinction, multiTable, normalize, OZONE, OZONE_WIDTH, RAYLEIGH, RAYLEIGH_H, skyRadiance, skyViewDir, skyViewUv, sunAtGround, sunDiscRadiance, transmittance, transmittanceHMu, transmittanceTable, transmittanceUv } from '../src/index.ts';
import { agx, aoFootReference, bevelNormal, type V3, CANDY_NIGHT, CTL, HOT_FULL, MAX_EVENTS, SPAWN_BUDGET, FX_WORDS, packFx, tintWord, unpackFx, frustumPlanes, linearToOklab, listMatches, oklabToLinear, srgbToLinear, lookAt, lookOf, lookRange, MATERIAL, multiply, SEG, packBodies, changedRanges, drawnTier, packShapes, paletteOf, perspective, unpackLook } from '../src/index.ts';
import type * as Drivers from './page.ts';

describe('looks', () => {
  const scene = buildScenario('S1', { F: 2, H: 5 });
  const range = lookRange(scene.bodies);

  it('ramp follows original height, bottom 0 to top 255', () => {
    const ramps = scene.bodies.map((b, i) => unpackLook(lookOf(b, i, range)).ramp);
    const ys = scene.bodies.map((b) => b.pos[1]);
    expect(Math.min(...ramps)).toBe(0);
    expect(Math.max(...ramps)).toBe(255);
    scene.bodies.forEach((_, i) => scene.bodies.forEach((__, j) => { if (ys[i]! < ys[j]!) expect(ramps[i]).toBeLessThanOrEqual(ramps[j]!); }));
  });

  it('packs hue, material and a per-slot seed', () => {
    const ball: BodyDesc = { ...scene.bodies[0]!, tag: TAG_BALL };
    expect(unpackLook(lookOf(ball, 7, range))).toMatchObject({ hue: paletteOf(TAG_BALL), material: MATERIAL.ball });
    expect(unpackLook(lookOf(scene.bodies[0]!, 0, range)).material).toBe(MATERIAL.candy);
    const seeds = new Set(scene.bodies.map((b, i) => unpackLook(lookOf(b, i, range)).seed));
    expect(seeds.size).toBeGreaterThan(scene.bodies.length * 0.9);
  });
});

describe('packBodies / packShapes', () => {
  it('write the schema layouts, slot i = body i', () => {
    const scene = buildScenario('S5', { N: 64, F: 2, H: 4, fireStep: 0 });
    const descs: BodyDesc[] = [...scene.bodies, scene.inputs[0]!.body];
    const s = emptySnapshot(descs.length);
    descs.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.linVel.set([i, 0, 0], 3 * i); s.awake[i] = i % 2; });
    const view = new DataView(packBodies(s, descs));
    const last = descs.length - 1;
    for (const i of [0, 1, last]) {
      const b = readStruct(view, Body, i);
      b.pos!.forEach((x, k) => expect(x).toBeCloseTo(descs[i]!.pos[k]!, 5));
      expect(b.linVel![0]).toBe(i);
      expect(b.shape).toEqual([i]);
      expect(b.flags).toEqual([i % 2]); // awake bit, tier 0 (active)
    }
    const shapes = new DataView(packShapes(descs).buffer);
    expect(readStruct(shapes, Shape, 0)).toEqual({ half: [0.5, 0.5, 0.5], kind: [0] });
    const r = (descs[last]!.shape as { radius: number }).radius;
    expect(readStruct(shapes, Shape, last)).toEqual({ half: [r, r, r].map(Math.fround), kind: [1] });
  });
});

describe('tiers in Body[] (Snapshot.tier)', () => {
  const snap = (tiers: number[]) => {
    const s = emptySnapshot(tiers.length);
    tiers.forEach((_, i) => { s.pos.set([i, 0, 0], 3 * i); s.rot.set([0, 0, 0, 1], 4 * i); });
    s.tier = Uint8Array.from(tiers);
    return s;
  };
  const descs = (n: number) => buildScenario('S1', { F: 1, H: n }).bodies;

  it('packs each body\'s tier, drawing dormant cells as static bodies until the lattice pass exists', () => {
    const view = new DataView(packBodies(snap([TIER.active, TIER.rubble, TIER.lattice]), descs(3)));
    expect([0, 1, 2].map((i) => readStruct(view, Body, i).flags![0]! >>> 8)).toEqual([TIER.active, TIER.rubble, TIER.rubble]);
    expect(drawnTier(TIER.lattice)).toBe(TIER.rubble);
  });

  it('changedRanges: new, active and changed slots, merged across small gaps; everything without tiers', () => {
    const A = TIER.active, R = TIER.rubble, L = TIER.lattice;
    const prev = Uint8Array.from([L, L, A, L, L, L, L, L, R, L]);
    expect(changedRanges(snap([L, L, A, L, L, L, L, L, R, L, A, A]), prev, 10, 1)).toEqual([[2, 3], [10, 12]]);
    expect(changedRanges(snap([L, R, L, L, L, L, L, L, A, L]), prev, 10, 1)).toEqual([[1, 3], [8, 9]]); // 1, 2 (settled) and 8 changed tier
    expect(changedRanges(snap([L, R, L, L, L, L, L, L, A, L]), prev, 10, 16)).toEqual([[1, 9]]);
    expect(changedRanges(snap([L, L, A, L, L, L, L, L, R, L]), null, 10)).toEqual([[0, 10]]);
    const s = snap([A, A]); delete s.tier;
    expect(changedRanges(s, prev, 2)).toEqual([[0, 2]]);
  });

  it('on a TieredEngine collapse, packing only the changed ranges keeps Body[] identical to a full pack, for a fraction of the bytes', { timeout: 180_000 }, async () => {
    const scene = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    const e = new TieredEngine(new RapierHost());
    await e.init(scene);
    const all = e.bodies as BodyDesc[];
    let s = await e.snapshot();
    let mirror = packBodies(s, all), tiers = s.tier!, count = s.count, written = 0, full = 0;
    for (let k = 1; k <= 300; k++) {
      await e.step();
      s = await e.snapshot();
      const ranges = changedRanges(s, tiers, count);
      const grown = new ArrayBuffer(Math.max(mirror.byteLength, s.count * Body.size));
      new Uint8Array(grown).set(new Uint8Array(mirror));
      mirror = packBodies(s, all, grown, ranges);
      const want = new Uint8Array(packBodies(s, all), 0, s.count * Body.size), got = new Uint8Array(mirror, 0, s.count * Body.size);
      let diff = -1;
      for (let b = 0; b < want.length && diff < 0; b++) if (got[b] !== want[b]) diff = b;
      expect(diff < 0 ? null : `step ${k}: slot ${Math.floor(diff / Body.size)} differs`).toBeNull();
      written += ranges.reduce((a, [f, t]) => a + t - f, 0);
      full += s.count;
      tiers = s.tier!; count = s.count;
    }
    e.dispose();
    expect(written / full).toBeLessThan(0.5); // 0.45 measured: this tower falls over
  });

  it('an intact city uploads nothing after its first frame', async () => {
    const scene = buildScenario('S4', { N: 10_000 }, 1);
    const e = new TieredEngine(new RapierHost());
    await e.init(scene);
    let s = await e.snapshot(), written = 0;
    for (let k = 1; k <= 30; k++) {
      await e.step();
      const next = await e.snapshot();
      written += changedRanges(next, s.tier!, s.count).length;
      s = next;
    }
    e.dispose();
    expect(s.count).toBe(10_000);
    expect(written).toBe(0);
  });
});

describe('frustumPlanes', () => {
  it('a point is inside every plane exactly when it projects inside the clip volume', () => {
    const m = multiply(perspective(1, 1.5, 0.5, 50), lookAt([0, 0, 0], [0, 0, -1]));
    const pl = frustumPlanes(m);
    const inside = (p: number[]) => [0, 1, 2, 3, 4, 5].every((k) => pl[4 * k]! * p[0]! + pl[4 * k + 1]! * p[1]! + pl[4 * k + 2]! * p[2]! + pl[4 * k + 3]! >= 0);
    expect(inside([0, 0, -10])).toBe(true);
    expect(inside([0, 0, 10])).toBe(false); // behind
    expect(inside([0, 0, -60])).toBe(false); // past far
    expect(inside([0, 0, -0.4])).toBe(false); // before near
    expect(inside([20, 0, -10])).toBe(false);
    expect(inside([0, -9, -10])).toBe(false);
  });
});

describe('listMatches', () => {
  it('accepts lists between must and may, in order', () => {
    expect(listMatches([1, 3], [1], [1, 3])).toBeNull();
    expect(listMatches([3, 1], [1], [1, 3])).toMatch(/ascending/);
    expect(listMatches([1], [1, 3], [1, 3])).toMatch(/missing/);
    expect(listMatches([1, 2], [1], [1, 3])).toMatch(/culled/);
  });
});

describe('look math (CPU twins)', () => {
  const r = (() => { let a = 7; return () => ((a = (a * 1103515245 + 12345) >>> 0) / 2 ** 32); })();

  it('OKLab round-trips linear sRGB', () => {
    for (let i = 0; i < 1000; i++) {
      const c: [number, number, number] = [r(), r(), r()];
      oklabToLinear(linearToOklab(c)).forEach((v, k) => expect(v).toBeCloseTo(c[k]!, 6));
    }
    // White is L = 1, a = b = 0.
    linearToOklab([1, 1, 1]).forEach((v, k) => expect(v).toBeCloseTo(k ? 0 : 1, 4));
  });

  // Monotone up to a quarter of an 8-bit step: near white, the punchy
  // saturation plus the output clamp dips luma by up to ~5e-4.
  it('AgX maps black to black, stays in 0..1, and is monotone in exposure', () => {
    expect(Math.max(...agx([0, 0, 0]))).toBeLessThan(0.01);
    for (let i = 0; i < 200; i++) {
      const c: [number, number, number] = [r() * 4, r() * 4, r() * 4];
      let prev = -1;
      for (let ev = -8; ev <= 8; ev += 0.5) {
        const out = agx(c.map((x) => x * 2 ** ev) as [number, number, number]);
        out.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(1); });
        const luma = 0.2126 * out[0] + 0.7152 * out[1] + 0.0722 * out[2];
        expect(luma).toBeGreaterThanOrEqual(prev - 1 / 1024);
        prev = luma;
      }
    }
  });

  it('every ramp colour keeps its hue ordering through OKLab (no channel clipping)', () => {
    for (const c of CANDY_NIGHT.ramp) {
      const lin = c.map(srgbToLinear) as [number, number, number];
      oklabToLinear(linearToOklab(lin)).forEach((v) => { expect(v).toBeGreaterThanOrEqual(-1e-6); expect(v).toBeLessThanOrEqual(1 + 1e-6); });
    }
  });

  it('bevel normals are unit, never face inward, and flat at face centres', () => {
    for (let i = 0; i < 5000; i++) {
      const half: [number, number, number] = [0.05 + r() * 1.5, 0.05 + r() * 1.5, 0.05 + r() * 1.5];
      const axis = Math.floor(r() * 3), sgn = r() < 0.5 ? -1 : 1;
      const faceN: [number, number, number] = [0, 0, 0];
      faceN[axis] = sgn;
      const lp = half.map((h, k) => (k === axis ? sgn * h : (r() * 2 - 1) * h)) as [number, number, number];
      const pxM = 10 ** (r() * 4 - 4), rb = 0.005 + r() * 0.2;
      const n = bevelNormal(lp, faceN, half, pxM, rb);
      expect(Math.hypot(...n)).toBeCloseTo(1, 9);
      expect(n[axis]! * sgn).toBeGreaterThan(0.3); // tilts at most to the 45 degree edge normal (and less near corners' sides)
      const centre = half.map((h, k) => (k === axis ? sgn * h : 0)) as [number, number, number];
      bevelNormal(centre, faceN, half, pxM, rb).forEach((v, k) => expect(v).toBeCloseTo(faceN[k]!, 9));
    }
  });

  it('bevel fades to the flat face once the radius is under a third of a pixel', () => {
    const half: [number, number, number] = [0.5, 0.5, 0.5];
    const edge: [number, number, number] = [0.5, 0.499, 0.2];
    expect(bevelNormal(edge, [1, 0, 0], half, 0.001, 0.06)[1]).toBeGreaterThan(0.1); // resolved: tilted
    expect(bevelNormal(edge, [1, 0, 0], half, 0.2, 0.06)).toEqual([1, 0, 0]); // 3x the radius per pixel: flat
  });
});

describe('real look options', () => {
  it('round-trip through URL keys, only the ones set, and realLook fills the rest', () => {
    const o = { sunElevation: 4, sunAzimuth: 200, visibility: 8, sunStrength: 1.5, exposure: 2, autoExposure: 0.5, groundAlbedo: [0.3, 0.25, 0.2] as V3, stone: 'granite' as const, stoneDetail: 0.5, stoneScale: 2, wear: 0.2, dirt: 0 };
    const q = new URLSearchParams();
    writeRealOptions(o, q);
    expect(parseRealOptions(q)).toEqual(o);
    const one = new URLSearchParams();
    writeRealOptions({ sunElevation: 10 }, one);
    expect([...one.keys()]).toEqual(['real.sunElevation']);
    expect(parseRealOptions(new URLSearchParams())).toEqual({});
    expect(realLook(parseRealOptions(new URLSearchParams()))).toEqual(realLook(REAL_DEFAULTS));
    expect(realLook({ visibility: 8 }).atmosphere!.visibility).toBe(8);
  });
  it('rejects values out of range or not numbers', () => {
    for (const [key, k] of Object.entries(REAL_KNOBS)) {
      expect(() => parseRealOptions(new URLSearchParams({ [`real.${key}`]: String(k.max + 1) }))).toThrow(new RegExp(`real.${key}`));
      expect(() => parseRealOptions(new URLSearchParams({ [`real.${key}`]: 'x' }))).toThrow(new RegExp(`real.${key}`));
      expect(parseRealOptions(new URLSearchParams({ [`real.${key}`]: String(k.min) }))[key as keyof typeof REAL_KNOBS]).toBe(k.min);
    }
    for (const g of ['0.2,0.2', '0.2,0.2,1.5', 'a,b,c']) expect(() => parseRealOptions(new URLSearchParams({ 'real.ground': g }))).toThrow(/real.ground/);
    expect(() => parseRealOptions(new URLSearchParams({ 'real.stone': 'marble' }))).toThrow(/real.stone/);
  });
  it('the defaults sit inside the knob ranges, and looks resolve by name', () => {
    for (const [key, k] of Object.entries(REAL_KNOBS)) {
      const v = REAL_DEFAULTS[key as keyof typeof REAL_KNOBS];
      expect(v).toBeGreaterThanOrEqual(k.min);
      expect(v).toBeLessThanOrEqual(k.max);
    }
    expect(lookByName('real', { sunElevation: 4 })).toEqual(realLook({ sunElevation: 4 }));
    expect(lookByName('hazy')).toBe(HAZY_DAY);
    expect(lookByName('nope')).toBe(CANDY_NIGHT);
    expect(lookByName('nope', {}, HAZY_DAY)).toBe(HAZY_DAY);
    expect(srgbToLinear(linearToSrgb(0.19))).toBeCloseTo(0.19, 12);
  });
});

describe('atmosphere (CPU twin)', () => {
  it('exposure adaptation: fixed at 0, unchanged at the reference light, partial in between, clamped', () => {
    const E: V3 = [9.4, 9.4, 9.4], ref = ADAPT_REF * 9.4;
    expect(adaptedExposure(ref, E, 1.1, 0.75)).toBeCloseTo(1.1, 12);
    expect(adaptedExposure(ref / 10, E, 1.1, 0)).toBe(1.1);
    // A tenth of the light: full adaptation gives 10x, 0.75 gives 10^0.75.
    expect(adaptedExposure(ref / 10, E, 1, 1)).toBeCloseTo(10, 10);
    expect(adaptedExposure(ref / 10, E, 1, 0.75)).toBeCloseTo(10 ** 0.75, 10);
    // The reference follows the sun's strength: twice the sun and twice the light leave the exposure as set.
    expect(adaptedExposure(2 * ref, [18.8, 18.8, 18.8], 1, 1)).toBeCloseTo(1, 12);
    expect(adaptedExposure(0, E, 1, 1)).toBe(ADAPT_MAX);
    expect(adaptedExposure(1e6, E, 1, 1)).toBe(1 / ADAPT_MAX);
  });

  const a = CLEAR_DAY;
  const el = (deg: number): V3 => [Math.cos((deg * Math.PI) / 180), Math.sin((deg * Math.PI) / 180), 0];
  const T = transmittanceTable(a);
  const M = multiTable(a, T, 8, 8);
  const sky = (sun: V3, dir: V3, at = a, t = T, m = M) => skyRadiance(at, t, m, sun, dir, 0.03)[0];

  it('vertical transmittance matches the analytic optical depth of the exponential layers', () => {
    const me = mieExtinction(a);
    const tau = [0, 1, 2].map((k) => RAYLEIGH[k]! * RAYLEIGH_H * (1 - Math.exp(-100 / RAYLEIGH_H)) + me * MIE_H * (1 - Math.exp(-100 / MIE_H)) + OZONE[k]! * OZONE_WIDTH);
    transmittance(a, 0, 1).forEach((t, k) => expect(Math.abs(t / Math.exp(-tau[k]!) - 1)).toBeLessThan(2e-3)); // measured 1.1e-3
  });

  it('LUT parameterizations round-trip', () => {
    for (const [h, mu] of [[0.002, 0.3], [0.01, 0.3], [40, -0.2], [1, 1], [99, -0.9], [0.5, 0]] as const) {
      const [h2, mu2] = transmittanceHMu(...transmittanceUv(h, mu));
      expect(h2 / h).toBeCloseTo(1, 9);
      expect(mu2).toBeCloseTo(mu, 6);
    }
    for (const d of [[0.3, 0.9, 0.1], [-0.7, 0.05, 0.4], [0.2, -0.3, -0.9], [0, 1, 0]] as V3[]) {
      const n = normalize(d), back = skyViewDir(...skyViewUv(n, [1, 0, 0], 0.03), 0.03);
      expect(back[1]).toBeCloseTo(n[1], 6); // elevation; azimuth is folded about the sun
      if (Math.hypot(n[0], n[2]) > 1e-3) expect(back[0] / Math.hypot(back[0], back[2])).toBeCloseTo(n[0] / Math.hypot(n[0], n[2]), 5); // cos of the azimuth from the sun
    }
  });

  it('the sky is blue overhead and paler at the horizon; the low sun is redder and dimmer', () => {
    const noon = el(60), zen = sky(noon, [0, 1, 0]), hor = sky(noon, normalize([0, 0.02, 1]));
    expect(zen[2] / zen[0]).toBeGreaterThan(1.5); // measured 1.8 (30 degrees from the sun)
    expect(hor[2] / hor[0]).toBeLessThan(0.8 * (zen[2] / zen[0])); // measured 0.69 x
    const high = sunAtGround(a, el(60)), low = sunAtGround(a, el(4));
    expect(low[0] / low[2]).toBeGreaterThan(2 * (high[0] / high[2]));
    expect(low[1]).toBeLessThan(high[1]);
    expect(sunAtGround(a, el(-3))).toEqual([0, 0, 0]); // below the horizon
  });

  it('lower visibility whitens the horizon and dims the sun', () => {
    const hazy = { ...a, visibility: 8 }, Th = transmittanceTable(hazy), Mh = multiTable(hazy, Th, 8, 8);
    const sun = el(30), dir = normalize([0, 0.05, 1]);
    const clear = sky(sun, dir), murky = sky(sun, dir, hazy, Th, Mh);
    expect(murky[2] / murky[0]).toBeLessThan(clear[2] / clear[0]);
    expect(sunAtGround(hazy, sun)[1]).toBeLessThan(0.8 * sunAtGround(a, sun)[1]);
  });

  it('the sun disc keeps its colour inside the half-float range', () => {
    for (const d of [60, 10, 2]) {
      const L = sunDiscRadiance(a, el(d)), s = sunAtGround(a, el(d));
      expect(Math.max(...L)).toBeLessThanOrEqual(6e4);
      expect(L[0] / L[2]).toBeCloseTo(s[0] / s[2], 6);
    }
  });
});

describe('fx records', () => {
  it('all-zero words mean no effect', () => {
    expect(unpackFx(new Uint32Array(FX_WORDS))).toEqual({ tint: [1, 1, 1], emissive: 0, scale: 1, anchor: false, flashAt: 0, flash: 0 });
    const w = new Uint32Array(FX_WORDS);
    packFx({}, w);
    expect(Array.from(w)).toEqual([0, 0, 0, 0]);
  });

  it('round-trip within 8-bit colour and f16 scale precision', () => {
    const w = new Uint32Array(FX_WORDS);
    for (const s of [0, 0.001, 0.25, 0.5, 0.6, 0.999, 1]) {
      packFx({ tint: [0.2, 0.5, 1], emissive: 0.75, scale: s, anchor: true, flash: 0.3, flashAt: 12.5 }, w);
      const u = unpackFx(w);
      u.tint.forEach((v, k) => expect(Math.abs(v - [0.2, 0.5, 1][k]!)).toBeLessThan(1 / 255));
      expect(Math.abs(u.emissive - 0.75)).toBeLessThan(1 / 255);
      expect(Math.abs(u.scale - s)).toBeLessThan(5e-4);
      expect(u).toMatchObject({ anchor: true, flash: Math.fround(0.3), flashAt: 12.5 });
    }
    // Hidden must be exactly 0, not a tiny positive scale.
    packFx({ scale: 0 }, w);
    expect(unpackFx(w).scale).toBe(0);
  });

  it('bulk tints are rgb8 + emissive8, r in the low byte', () => {
    const w = new Uint32Array(FX_WORDS);
    w[0] = tintWord(0x80ff4000); // emissive 0x80, b 0xff, g 0x40, r 0x00
    const u = unpackFx(w);
    expect(u.tint).toEqual([0, 0x40 / 255, 1]);
    expect(u.emissive).toBeCloseTo(0x80 / 255, 9);
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./page.ts', import.meta.url)), '__render');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __render: Record<string, (...x: unknown[]) => unknown> }).__render[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

describe('sparks', () => {
  it('the impact detector reports real speed changes only, at the support point', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sparkDetect');
    expect(r.error).toBeNull();
    expect([r.first, r.still, r.after]).toEqual([0, 0, 0]); // first sight, and frames without a step
    // Bodies 0, 7, 8, 9 only: 1 is under dvMin; 2 teleported; 3 changed tier; 4 static; 5 lattice; 6 new shape; 10, 11 new slots.
    expect(r.step.map((e) => e.packed & 0xffffff)).toEqual([0, 7, 8, 9]);
    const want = [
      { pos: [-0.5, 2, 0], strength: 5, dir: [1, 0, 0], material: 0 },
      { pos: [21, 1, 0], strength: 7, dir: [0, 1, 0], material: 3 }, // slab turned 90 degrees: support 1 m along y
      { pos: [24, 2, 0.4], strength: 4, dir: [0, 0, -1], material: 0 }, // sphere: radius
      { pos: [26.5, 2, 0], strength: 3, dir: [1, 0, 0], material: 1 },
    ];
    r.step.forEach((e, i) => {
      e.pos.forEach((v, k) => expect(v).toBeCloseTo(want[i]!.pos[k]!, 5));
      e.dir.forEach((v, k) => expect(v).toBeCloseTo(want[i]!.dir[k]!, 6));
      expect(e.strength).toBeCloseTo(want[i]!.strength, 5);
      expect(e.packed >>> 28).toBe(want[i]!.material);
    });
    expect(r.spawned).toBe(60 + 108 + 36 + 12); // floor((dv - 2.5) * 24) each
    // Once the detector has seen body 3's new tier, its next impact counts.
    expect(r.again.map((e) => e.packed & 0xffffff)).toEqual([3]);
  });

  it('spawn and flight match the CPU twins, bounces included', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sparkSim', 50);
    expect(r.error).toBeNull();
    expect(r.born).toBe(r.want);
    expect(r.spawned).toBe(r.want);
    expect(r.unmatched).toBe(0);
    expect(r.spawnErr).toBeLessThan(1e-3); // GPU trig and normalize vs f32-rounded JS; measured 1.8e-4
    expect(r.alive).toBe(r.aliveRef);
    expect(r.alive).toBeGreaterThan(100); // some live sparks left to compare after 50 frames
    expect(r.bounced).toBeGreaterThan(50); // and many of them have hit the ground
    expect(r.simErr).toBeLessThan(1e-4); // measured 2.4e-6
    // The streak draw: the whole pool while any spark lives, empty once all are dead.
    expect(r.aliveCtl).toBe(r.alive);
    expect(r.argsFlying).toEqual([6, r.pool, 0, 0]);
    expect(r.aliveDead).toBe(0);
    expect(r.argsDead).toEqual([6, 0, 0, 0]);
  });

  it('a flood of 100k impacts stays within the event and spark budgets', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sparkFlood', 100_000);
    expect(r.error).toBeNull();
    expect(r.ctl[CTL.events]).toBe(100_000); // every body counted...
    expect(r.events).toBe(MAX_EVENTS); // ...but only the first MAX_EVENTS kept,
    expect(r.distinct).toBe(MAX_EVENTS); // each a different body,
    expect(r.ctl[CTL.dropped]).toBe(100_000 - MAX_EVENTS); // the rest dropped
    expect(r.ctl[CTL.spawned]).toBe(SPAWN_BUDGET);
    expect(r.live).toBe(SPAWN_BUDGET);
  });

  it('streaks show where a burst projects, nowhere else, and not through a wall', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sparkDraw');
    expect(r.error).toBeNull();
    expect(r.near).toBeGreaterThan(2000); // summed 8-bit brightening near the open burst; measured 16.9k
    expect(r.stray).toBe(0); // the 64k dead pool slots draw nothing
    expect(r.wallPixels).toBeGreaterThan(500);
    expect(r.maxWall).toBe(0); // the burst behind the wall is hidden
  });
});

describe('lights', () => {
  it('a ball lights a cube 2 m away and the floor under it, not a cube 20 m away', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('ballLight');
    expect(r.error).toBeNull();
    expect(r.balls).toEqual([0]);
    expect(r.near[0]!.n).toBeGreaterThan(100);
    expect(r.near[0]!.mean).toBeGreaterThan(r.near[1]!.mean + 2); // measured +3.7 (its lit face is mostly turned from the camera)
    expect(r.gn).toBeGreaterThan(100);
    expect(r.ground[0]!).toBeGreaterThan(r.ground[1]! + 8); // floor around its foot: measured +14.9
    expect(r.far[0]!.n).toBeGreaterThan(100);
    expect(r.far[0]!.mean).toBe(r.far[1]!.mean); // outside the 12 m radius: identical
  });

  it('flash lights follow the CPU slot rule, decay with tau, and only a brighter impact replaces one', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('flashLights');
    expect(r.error).toBeNull();
    expect(r.slotsLit).toBe(8); // 40 impacts over 8 slots
    expect(r.wrongLit).toBe(0);
    expect(r.posErr).toBeLessThan(1e-5); // the winner's position (plus 0.5 m along its normal)
    expect(r.iErr).toBeLessThan(1e-5); // and intensity, also in the light list
    expect(r.kept).toBe(true); // a weak impact one tau later does not replace it
    expect(r.decay).toBeCloseTo(Math.exp(-1), 5);
    expect(r.replaced).toBe(true); // a strong one does
    expect(r.pack).toEqual({ n: 8, same: true }); // the scene shader loops over the lit lights only
  });

  it('the ball trail keeps its samples in order at the drawn positions and lights the path behind the ball', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('ballTrail', 20);
    expect(r.error).toBeNull();
    expect(r.used).toBe(20);
    expect(r.ordered).toBe(true);
    expect(r.posErr).toBeLessThan(1e-5);
    expect(r.behind).toBeGreaterThan(1000); // measured 25k
    expect(r.farBehind).toBeGreaterThan(1000); // 6-12 frames back, faded: measured 14k (a ribbon reading the ring forwards draws only its newest piece)
    expect(r.ahead).toBe(0);
  });
});

describe('heat', () => {
  it('comes from ball contact and hard hits only, and decays with tau', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('heatScript');
    expect(r.error).toBeNull();
    const { heatTau: tau, heatDv, heatRange } = r.cfg;
    expect([tau, heatDv, heatRange]).toEqual([0.25, 6, 6]); // the numbers below assume these
    const near = (got: number[], want: number[]) => got.forEach((v, i) => expect(Math.abs(v - want[i]!), `slot ${i}`).toBeLessThan(2e-3)); // f16 storage
    // Slots: ball, touching, near miss, rotated touching, far, dv 9, dv 4, dv 15, static touching, lattice touching.
    near(r.seen, [0, 1, 0, 1, 0, 0, 0, 0, 0, 0]);
    near(r.hit, [0, 1, 0, 1, 0, 0.5, 0, 1, 0, 0]);
    const e = Math.exp(-1);
    near(r.later, [0, 1, 0, 1, 0, 0.5 * e, 0, e, 0, 0]);
    near(r.gone, [0, e, 0, e, 0, 0.5 * e * e, 0, e * e, 0, 0]);
    expect(r.hot).toEqual([2, 4]);
  });

  it('the glow gain is 1 up to HOT_FULL hot bodies and HOT_FULL / hot beyond', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const n of [1500, 100_000]) {
      const r = await call('heatGain', n);
      expect(r.error).toBeNull();
      expect(r.cold).toEqual({ hot: 0, gain: 1, lit: 0 }); // no balls, no flashes: the scene shader's light loop is empty
      expect(r.hot.hot).toBe(n);
      expect(r.hot.gain).toBeCloseTo(Math.min(1, HOT_FULL / n), 7);
    }
  });

  it('a hard-hit cube glows, its twin does not, and the glow dims when thousands are hot', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Heat 0.5 (dv 9): below the white end, where tone mapping is not yet flat.
    const alone = await call('heatImage', 6000, false, 9);
    const crowd = await call('heatImage', 6000, true, 9);
    for (const r of [alone, crowd]) {
      expect(r.error).toBeNull();
      expect(r.n).toBeGreaterThan(300);
      expect(r.twin[1]).toBe(r.twin[0]); // the cold twin: identical
    }
    const glow = alone.hit[1]! - alone.hit[0]!, dim = crowd.hit[1]! - crowd.hit[0]!;
    expect(glow).toBeGreaterThan(40); // 8-bit luma, measured +79
    expect(dim).toBeGreaterThan(0);
    expect(dim).toBeLessThan(0.75 * glow); // gain 2000 / 6001; tone mapping compresses it to a measured 0.54
    // The bench toggle: with the glow off the hit cube does not change.
    const off = await call('heatImage', 0, false, 9, false);
    expect(off.error).toBeNull();
    expect(off.hit[1]).toBe(off.hit[0]);
  });
});

describe('AO volume', () => {
  it('compose matches its CPU twin at every level, within unorm8 rounding', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('aoCompose', 63);
    expect(r.error).toBeNull();
    expect(r.levels.map((l) => l.dims)).toEqual([[40, 24, 32], [20, 12, 16], [10, 6, 8]]);
    for (const l of r.levels) {
      expect(l.maxR).toBeLessThanOrEqual(0.6); // unorm8 conversion: nearest within 0.6 ulp
      expect(l.maxG).toBeLessThanOrEqual(0.6 + 255 * 1e-5); // and exp() within f32 slack
      expect(l.fixed).toBe(0);
    }
  });

  it('the GPU footprint matches its twin: exact at rest, a few ulps rotated, zero (not NaN) when hidden', async (ctx) => {
    if (!gpu) return ctx.skip();
    let s = 77;
    const r = () => ((s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296);
    const q = () => { const v = [r() - 0.5, r() - 0.5, r() - 0.5, r() - 0.5], l = Math.hypot(...v); return v.map((x) => x / l); };
    const cases = [
      ...Array.from({ length: 40 }, () => ({ rot: [0, 0, 0, 1], half: [0.05 + r(), 0.05 + r() * 2, 0.05 + r() * 0.3], sphere: false })),
      ...Array.from({ length: 200 }, () => ({ rot: q(), half: [0.05 + r(), 0.05 + r() * 2, 0.05 + r() * 0.3], sphere: false })),
      ...Array.from({ length: 20 }, () => ({ rot: q(), half: [0.1 + r(), 0, 0], sphere: true })),
      { rot: q(), half: [0, 0, 0], sphere: false }, { rot: [0, 0, 0, 1], half: [0, 0, 0], sphere: false }, { rot: q(), half: [0, 0, 0], sphere: true },
    ];
    const g = await call('aoFootGpu', cases);
    expect(g.error).toBeNull();
    cases.forEach((c, i) => {
      const want = aoFootReference(c.rot, c.half, c.sphere), got = g.foot[i]!;
      if (c.half[0] === 0) expect(got).toEqual([0, 0, 0]);
      else if (c.sphere || c.rot[3] === 1) expect(got).toEqual(want);
      else got.forEach((v, k) => expect(Math.abs(v - want[k]!) / want[k]!).toBeLessThan(2e-6));
    });
  });

  it('the splat equals its CPU twin on the GPU\'s own records, independent of slot order', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('aoSplat', 61, 3000, false);
    expect(r.error).toBeNull();
    expect(r.splatted).toBeGreaterThan(2500); // lattice and free slots are left out
    expect(r.touched).toBeGreaterThan(20_000);
    expect(r.mismatched).toBe(0); // unrotated: bit-exact
    expect(r.stable).toBe(true);
    expect(r.orderFree).toBe(true);
    const rot = await call('aoSplat', 62, 3000, true);
    expect(rot.error).toBeNull();
    expect(rot.orderFree).toBe(true);
    // Rotation and cube root differ by f32 rounding only: measured 185 of 44k voxels off, by 1 unit (2^-16 voxel).
    expect(rot.maxDiff).toBeLessThanOrEqual(4);
    expect(rot.relDiff).toBeLessThan(1e-5);
  });
});

describe('AO shading', () => {
  it('in the image: the floor by a tower darkens, an isolated cube and the open floor do not change', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('aoImage');
    expect(r.error).toBeNull();
    expect(r.nn).toBeGreaterThan(30);
    expect(r.near[0]! / r.near[1]!).toBeLessThan(0.9); // ambient-only light: measured 0.81 (0.82 before the grid stopped under the floor)
    // A cube at the tower's foot (mean over all its pixels): measured 0.967; own footprint centred on the shading point instead of the body, 0.987.
    expect(r.nf).toBeGreaterThan(100);
    expect(r.foot[0]! / r.foot[1]!).toBeLessThan(0.978);
    // The isolated cube: at most 1 LSB even with ambient as the only light (its own sky term at low edges, >= 0.94).
    expect(r.nc).toBeGreaterThan(100);
    expect(r.cubeDiff).toBeLessThanOrEqual(1);
    // The isolated (turned) ball too.
    expect(r.nb).toBeGreaterThan(50);
    expect(r.ballDiff).toBeLessThanOrEqual(1);
    // Where AO is 1 the shading differs from the AO-off path by f32 rounding only (and the AO-off image is bit-identical to before R5).
    // Measured 16 of 6,689 pixels by 1 LSB.
    expect(r.no).toBeGreaterThan(500);
    expect(r.openDiff).toBeLessThanOrEqual(1);
    expect(r.openChanged / r.no).toBeLessThan(0.01);
  });

  type P = { p: V3; n: V3; own: number };
  const qrotT = (q: number[], v: V3): V3 => {
    const [x, y, z, w] = q as [number, number, number, number];
    const t = [2 * (y * v[2] - z * v[1]), 2 * (z * v[0] - x * v[2]), 2 * (x * v[1] - y * v[0])];
    return [v[0] + w * t[0]! + (y * t[2]! - z * t[1]!), v[1] + w * t[1]! + (z * t[0]! - x * t[2]!), v[2] + w * t[2]! + (x * t[1]! - y * t[0]!)];
  };
  /** Face centres, edge midpoints and corners of a cube, with their (averaged) normals. */
  const cubeProbes = (c: V3, h: number, rot: number[], own: number): P[] => {
    const out: P[] = [];
    for (const sx of [-1, 0, 1]) for (const sy of [-1, 0, 1]) for (const sz of [-1, 0, 1]) {
      if (!sx && !sy && !sz) continue;
      const d = qrotT(rot, [sx * h, sy * h, sz * h]);
      out.push({ p: [c[0] + d[0], c[1] + d[1], c[2] + d[2]], n: qrotT(rot, [sx, sy, sz]), own });
    }
    return out;
  };

  it('an isolated cube or ball does not occlude itself, on any face, edge or corner', async (ctx) => {
    if (!gpu) return ctx.skip();
    const s = Math.SQRT1_2, rots = [[0, 0, 0, 1], [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)], [0.3, 0.5, -0.1, 0.8]].map((q) => { const l = Math.hypot(...q); return q.map((x) => x / l); });
    let checked = 0;
    for (const off of [[0, 0, 0], [0.13, 0.27, 0.41], [0.25, 0.25, 0.25]] as V3[]) for (const rot of rots) {
      const c: V3 = [off[0], 2 + off[1], off[2]];
      const probes = cubeProbes(c, 0.5, rot, 0);
      const r = await call('aoProbe', [{ pos: c, half: [0.5, 0.5, 0.5], rot }], probes);
      expect(r.error).toBeNull();
      r.ao.forEach(([occ, sky], i) => {
        // The design asks >= 0.97; measured >= 0.9988 over all of these (own subtraction at the wrong level scale gives 0.975).
        expect(occ, `offset ${off} rot ${rot} probe ${probes[i]!.n}`).toBeGreaterThanOrEqual(0.995);
        if (probes[i]!.n[1] > -s) expect(sky).toBeGreaterThanOrEqual(0.9); // sky only weighs faces turned up or sideways; measured >= 0.94
        checked++;
      });
    }
    const ballC: V3 = [0.2, 2.1, -0.3];
    const dirs: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1], [1, 1, 1], [-1, 1, -1], [1, -1, 1]];
    const ball = await call('aoProbe', [{ pos: ballC, half: [0.6, 0, 0], sphere: true }], dirs.map((d) => { const l = Math.hypot(...d); return { p: [ballC[0] + 0.6 * d[0] / l, ballC[1] + 0.6 * d[1] / l, ballC[2] + 0.6 * d[2] / l] as V3, n: d, own: 0 }; }));
    expect(ball.error).toBeNull();
    for (const [occ] of ball.ao) { expect(occ).toBeGreaterThanOrEqual(0.995); checked++; }
    expect(checked).toBe(3 * 3 * 26 + 9);
  });

  it('the centre of a 5x5x5 heap is dark, and the floor beside a tower darker than the open floor', async (ctx) => {
    if (!gpu) return ctx.skip();
    const heap: { pos: V3; half: V3 }[] = [];
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) for (let z = 0; z < 5; z++) heap.push({ pos: [x - 2, 0.5 + y, z - 2], half: [0.5, 0.5, 0.5] });
    const ci = heap.findIndex((b) => b.pos[0] === 0 && b.pos[1] === 2.5 && b.pos[2] === 0);
    const faces: V3[] = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    const h = await call('aoProbe', heap, faces.map((n) => ({ p: [n[0] * 0.5, 2.5 + n[1] * 0.5, n[2] * 0.5] as V3, n, own: ci })));
    expect(h.error).toBeNull();
    for (const [occ] of h.ao) expect(occ).toBeLessThanOrEqual(0.6); // measured 0.17
    const tower = Array.from({ length: 8 }, (_, y) => ({ pos: [0, 0.5 + y, 0] as V3, half: [0.5, 0.5, 0.5] as V3 }));
    const fl = await call('aoProbe', tower, [0.75, 1, 10].map((d) => ({ p: [d, 0, 0.2] as V3, n: [0, 1, 0] as V3, own: -1 })));
    expect(fl.error).toBeNull();
    const [near, mid, far] = fl.ao.map((a) => a[0]);
    expect(far).toBe(1);
    expect(near!).toBeLessThan(0.92); // measured 0.886, 0.25 m from the tower's face
    expect(near!).toBeLessThan(mid!);
    expect(mid!).toBeLessThan(far!);
  });

  it('seam cavity: an edge shared with a neighbour darkens within the band, a free edge and the rest of the face do not', async (ctx) => {
    if (!gpu) return ctx.skip();
    const H3: V3 = [0.5, 0.5, 0.5];
    const at = (c: V3, local: V3) => ({ p: [c[0] + local[0], c[1] + local[1], c[2] + local[2]] as V3, n: [0, 0, 1] as V3, own: 0, local, face: [0, 0, 1] as V3 });
    for (const off of [0, 0.13, 0.25]) {
      const a: V3 = [off, 0.5 + off, off];
      // The lower cube's front face: by its top edge, outside the band, by its right edge, centre, by its left edge, just inside the band.
      const probes = [at(a, [0, 0.45, 0.5]), at(a, [0, 0.3, 0.5]), at(a, [0.45, 0, 0.5]), at(a, [0, 0, 0.5]), at(a, [-0.45, 0, 0.5]), at(a, [0, 0.36, 0.5])];
      const run = async (others: V3[]) => {
        const r = await call('aoProbe', [{ pos: a, half: H3 }, ...others.map((pos) => ({ pos, half: H3 }))], probes);
        expect(r.error).toBeNull();
        return r.seam as number[];
      };
      const above = await run([[off, 1.5 + off, off]]), side = await run([[1 + off, 0.5 + off, off]]), alone = await run([]);
      const msg = `offset ${off}`;
      // Measured 0.926 / 0.902 / 0.870 over the offsets for both neighbours.
      expect(above[0]!, msg).toBeLessThan(0.95);
      expect(side[2]!, msg).toBeLessThan(0.95);
      // The other edges are free: measured 1 with a neighbour elsewhere, >= 0.9998 alone.
      for (const k of [2, 4]) expect(above[k]!, msg).toBeGreaterThanOrEqual(0.995);
      for (const k of [0, 4]) expect(side[k]!, msg).toBeGreaterThanOrEqual(0.995);
      for (const k of [0, 2, 4]) expect(alone[k]!, msg).toBeGreaterThanOrEqual(0.995);
      // The band fades out: 0.01 m inside it the darkening is nearly gone (no visible step at its border).
      expect(above[5]!, msg).toBeGreaterThan(0.99);
      // Outside the band no tap is taken.
      for (const s of [above, side, alone]) { expect(s[1], msg).toBe(1); expect(s[3], msg).toBe(1); }
    }
    // In the scene shader (two stacked cubes, ambient only, AO on / off): measured shared 0.936, mid 0.998, top 0.9996;
    // with box shading using aoBody (no seam), shared 0.984.
    const img = await call('seamImage');
    expect(img.error).toBeNull();
    expect(img.shared.n).toBeGreaterThan(100);
    expect(img.mid.n).toBeGreaterThan(500);
    expect(img.top.n).toBeGreaterThan(50);
    expect(img.shared.ratio).toBeLessThan(0.96);
    expect(img.mid.ratio).toBeGreaterThan(0.99);
    expect(img.top.ratio).toBeGreaterThan(0.99);
    // The bench's no-seam variant compiles the cavity out: the shared edge is as aoBody alone left it (measured 0.984; mid-face unchanged).
    const none = await call('seamImage', { aoDiag: 'no-seam' });
    expect(none.error).toBeNull();
    expect(none.shared.ratio).toBeGreaterThan(0.975);
    expect(none.mid.ratio).toBeCloseTo(img.mid.ratio, 3);
  });

  it('seam cavity level of detail: full from 2 px of band, none (no tap) under 1 px, half way at 1.5 px', async (ctx) => {
    if (!gpu) return ctx.skip();
    const H3: V3 = [0.5, 0.5, 0.5];
    const a: V3 = [0.13, 0.63, 0.13];
    // The lower cube's front face by its top edge, under a neighbour; band 0.15 m, so pxM = 0.15 / px.
    const at = (pxM: number) => ({ p: [a[0], a[1] + 0.45, a[2] + 0.5] as V3, n: [0, 0, 1] as V3, own: 0, local: [0, 0.45, 0.5] as V3, face: [0, 0, 1] as V3, pxM });
    const pxs = [100, 4, 2, 1.5, 1.01, 1, 0.5, 0.01];
    const r = await call('aoProbe', [{ pos: a, half: H3 }, { pos: [a[0], a[1] + 1, a[2]], half: H3 }], pxs.map((px) => at(0.15 / px)));
    expect(r.error).toBeNull();
    const dark = r.seam.map((v) => 1 - v), full = dark[0]!;
    expect(full).toBeGreaterThan(0.05); // measured 0.098
    expect(dark[1]).toBeCloseTo(full, 6);
    expect(dark[2]).toBeCloseTo(full, 5); // smoothstep ends at 2 px
    expect(dark[3]! / full).toBeCloseTo(0.5, 4); // smoothstep(1, 2, 1.5)
    expect(dark[4]! / full).toBeGreaterThan(0);
    expect(dark[4]! / full).toBeLessThan(0.001);
    for (const k of [5, 6, 7]) expect(r.seam[k]).toBe(1);
  });

  it('seam cavity level of detail in the image: from far away the box shading is bit-identical to no seam', async (ctx) => {
    if (!gpu) return ctx.skip();
    const near = await call('seamVsNone', 1), far = await call('seamVsNone', 12);
    expect(near.error).toBeNull();
    expect(far.error).toBeNull();
    expect(near.changed).toBeGreaterThan(50); // close up the cavity shows
    expect(far.boxPx).toBeGreaterThan(5);
    expect(far.maxDiff).toBe(0); // band under 1 px: aoSeam returns exactly 1, no tap (with fsBox's clamped pxM, one edge pixel was off by 1)
  });

  it('the AO grid follows the floor: refitted when groundY changes, not reallocated when it does not', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('aoFloorFit', [0, 0, 3, 3, 0, 0.1]);
    expect(r.error).toBeNull();
    const [a, b, c, d, e, g] = r.out;
    expect(a!.grid.origin[1]).toBe(-2); // one 2 m (level 2) texel under the floor
    expect(b!.realloc).toBe(false);
    expect(b!.grid).toEqual(a!.grid);
    expect(c!.grid.origin[1]).toBe(1);
    expect(c!.grid.dims[1]).toBeLessThan(a!.grid.dims[1]!);
    expect(c!.realloc).toBe(true);
    expect(d!.realloc).toBe(false);
    expect(e!.grid).toEqual(a!.grid);
    // A floor that moves less than a voxel keeps the grid's size (and here its origin): no new volume.
    expect(g!.grid).toEqual(a!.grid);
    expect(g!.realloc).toBe(false);
  });
});

describe('GPU cull and compaction', () => {
  it('lists, counts and records match the CPU reference', async (ctx) => {
    if (!gpu) return ctx.skip();
    const cases = [
      { seed: 1, count: 3000, capacity: 3000, alpha: 0.37, noCull: false },
      { seed: 2, count: 1000, capacity: 1500, alpha: 1, noCull: false }, // free tail beyond count
      { seed: 3, count: 600, capacity: 600, alpha: 0, noCull: false },
      { seed: 4, count: 600, capacity: 700, alpha: 0.5, noCull: true },
      { seed: 5, count: 1, capacity: 1, alpha: 0.5, noCull: false },
      { seed: 6, count: 0, capacity: 64, alpha: 0.5, noCull: false },
      { seed: 7, count: 3000, capacity: 3000, alpha: 0.6, noCull: false, fx: true }, // FX scale, anchor, hidden
      { seed: 8, count: 3000, capacity: 3000, alpha: 0.4, noCull: false, lodDepth: 30 }, // near and far boxes
      { seed: 9, count: 600, capacity: 600, alpha: 1, noCull: false, lodDepth: -1e30 }, // every visible box far
    ];
    const out = await call('cull', cases);
    for (const r of out) {
      expect(r.error, `seed ${r.seed}`).toBeNull();
      expect(r.lists, `seed ${r.seed}`).toEqual([null, null, null, null, null]);
      expect(r.argsOk).toBe(true);
      expect(r.recordErr, `seed ${r.seed}`).toBeLessThan(2e-5);
    }
    // The random camera culls some but not all.
    expect(out[0]!.counts[0]).toBeGreaterThan(50);
    expect(out[0]!.counts[0]).toBeLessThan(2500);
    expect(out[5]!.listed).toBe(0);
    // boxFar: empty without a lodDepth; split at 30 m; everything at -1e30.
    for (const r of out.slice(0, 7)) expect(r.counts[SEG.boxFar], `seed ${r.seed}`).toBe(0);
    expect(out[7]!.counts[SEG.box]).toBeGreaterThan(50);
    expect(out[7]!.counts[SEG.boxFar]).toBeGreaterThan(50);
    expect(out[8]!.counts[SEG.box]).toBe(0);
    expect(out[8]!.counts[SEG.boxFar]).toBeGreaterThan(10);
  });
});

describe('drawing', () => {
  it('ID pixels at stable probes equal a CPU raycast', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Seed 11 caught spheres drawn inside out (back faces kept by the cull mode).
    for (const seed of [11, 12, 13]) {
      const r = await call('idProbes', seed);
      expect(r.error).toBeNull();
      expect(r.probes).toBeGreaterThan(500);
      expect(r.hitProbes).toBeGreaterThan(50);
      expect(r.mismatches, r.examples.join('; ')).toBe(0);
    }
  });

  // A packed tower showed dark vertical dashes: at edge pixels the MSAA
  // shading point lies outside the triangle, and a face guessed from the
  // extrapolated local position named the neighbouring face (that guess
  // makes 1735 of these pixels unstable).
  it('tower faces shade as their own face at every sub-pixel edge', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('towerFaces');
    expect(r.error).toBeNull();
    expect(r.checked).toBeGreaterThan(2000);
    expect(r.unstable, r.examples.join('; ')).toBe(0);
    // A few pixels on a shared edge see the neighbour's inner face: the two
    // meet exactly there, and snapped vertices decide either way. Measured
    // 5 of 2897; neither depth32float nor dilating boxes by up to 1 px
    // removes them, and in the shaded image they are one sample of four on
    // an already darkened seam.
    expect(r.wrong, r.examples.join('; ')).toBeLessThan(r.checked * 0.005);
  });

  it('colour and bevel WGSL match their TypeScript twins', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('lookTwins', 41);
    expect(r.error).toBeNull();
    expect(r.agxErr).toBeLessThan(1 / 1024); // a quarter of an 8-bit step
    expect(r.labErr).toBeLessThan(1e-5);
    expect(r.bevErr).toBeLessThan(1e-4);
  });

  it('bloom without Karis weighting conserves energy and falls off monotonically', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('bloomEnergy', false);
    expect(r.error).toBeNull();
    expect(r.finite).toBe(true);
    expect(r.levels).toBe(5);
    expect(r.meanRatio).toBeGreaterThan(0.95);
    expect(r.meanRatio).toBeLessThan(1.05);
    expect(r.rises).toBe(0);
    // Karis weighting tames the single-pixel firefly: much less energy, still finite.
    const k = await call('bloomEnergy', true);
    expect(k.finite).toBe(true);
    expect(k.meanRatio).toBeLessThan(0.5);
  });

  it('FX scale hides, shrinks and regrows bodies exactly; clearFx restores', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const seed of [51, 52]) {
      const r = await call('fxScale', seed);
      expect(r.error).toBeNull();
      expect(r.probes).toBeGreaterThan(500);
      expect(r.hits).toBeGreaterThan(50);
      expect(r.mismatches, r.examples.join('; ')).toBe(0);
      expect(r.hiddenSeen).toBe(0);
      expect(r.restoreDiff).toBe(0);
    }
  });

  it('FX tint, glow, flash and overlay show in the final image', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('fxColour');
    expect(r.error).toBeNull();
    const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(r.red[0]! / r.red[1]!).toBeGreaterThan(1.5 * (r.plain[0]! / r.plain[1]!)); // tint shifts towards red
    expect(luma(r.glow)).toBeGreaterThan(luma(r.plain) + 20); // glow brightens
    expect(luma(r.flashMid)).toBeGreaterThan(luma(r.plain) + 5); // halfway through the flash
    expect(luma(r.flashMid)).toBeLessThan(luma(r.glow));
    expect(Math.abs(luma(r.flashDone) - luma(r.plain))).toBeLessThan(1); // flash over: as if none
    expect(r.backBehindBox).toBe(true);
    expect(r.frontDelta).toBeGreaterThan(30); // the front sphere is drawn
    expect(r.backDelta).toBeLessThan(3); // the one behind the box is hidden by depth
  });

  it('the hexagon fan draws and casts the same boxes as the 36-vertex cube', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const seed of [61, 62]) {
      const r = await call('fanVsCube', seed, 50);
      expect(r.error).toBeNull();
      expect(r.covered).toBeGreaterThan(r.pixels * 0.3);
      expect(r.differ).toBeLessThan(r.pixels * 0.001); // measured 13 and 6 of 800k
      expect(r.coverDiff).toBe(0);
      expect(r.over1cm).toBeLessThan(r.texels * 0.001); // nearer-surface disagreements; measured 0 and 1 of 747k, 674k
      expect(r.over1mm).toBeLessThan(r.texels * 0.01); // interpolation; measured 1946 and 2393, max 7 mm
    }
  });

  it('the floor covers exactly the visible plane (no stray floor over bodies, no gaps)', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Looking down at the grazing slab's floor (where macOS SwiftShader drew the old 1,200 m quad's triangle over the slab),
    // a low camera with the horizon in view, a camera close to the floor, and one below it looking up.
    const cases: [V3, V3, number][] = [[[0.3, 7, 0.4], [0, 2, 0], -5], [[0, 1.5, 8], [0, 1, 0], 0], [[2, 0.05, 3], [0, 0, 0], 0], [[0, -2, 0], [3, 4, 1], 0]];
    for (const [eye, target, groundY] of cases) {
      const r = await call('floorCoverage', eye, target, groundY);
      expect(r.error).toBeNull();
      expect(r.checked).toBeGreaterThan(10000);
      expect(r.wrong, `eye ${eye}`).toBe(0);
    }
  });

  it('renders at tiny output sizes without error (bloom keeps at least one level)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('tinyFrames', [[1, 1], [3, 5], [7, 7], [8, 8], [9, 4]]);
    for (const f of r) {
      expect(f.error, `size ${f.size}`).toBeNull();
      expect(f.meanLuma, `size ${f.size}`).toBeGreaterThan(5); // sky and floor still drawn and composited
    }
  });

  it('atmosphere LUT passes match their CPU twins, pass by pass', async (ctx) => {
    if (!gpu) return ctx.skip();
    const el = (deg: number): V3 => normalize([Math.cos((deg * Math.PI) / 180) * 0.6, Math.sin((deg * Math.PI) / 180), Math.cos((deg * Math.PI) / 180) * -0.8]);
    const sun35 = el(35);
    for (const [sun, eye] of [[sun35, 0.03], [el(4), 0.002], [el(-2), 0.1]] as [V3, number][]) {
      const r = await call('atmosphereTwins', sun, eye);
      expect(r.error).toBeNull();
      expect(r.finite).toBe(true);
      // Measured on SwiftShader, worst of the three: 4.8e-4 (half-float rounding), 4e-4, 2.3e-2 (2 m up, just below
      // the horizon, where transmittance changes fastest and the sampler's fixed-point weights show), 3.2e-3 absolute, 1.7e-4.
      expect(r.worst.transmittance).toBeLessThan(1e-3);
      expect(r.worst.multi).toBeLessThan(2e-3);
      expect(r.worst.sky).toBeLessThan(4e-2);
      expect(r.worst.skyAlpha).toBeLessThan(5e-3);
      expect(r.worst.ambient).toBeLessThan(2e-3);
      expect(r.worst.exposure).toBeLessThan(1e-4);
      if (sun === sun35) {
        // ADAPT_REF is this ratio (measured at 30 m), so the default sun keeps the exposure as set.
        expect(Math.abs(r.illuminance / r.sunIlluminanceLuma / ADAPT_REF - 1)).toBeLessThan(5e-3);
        expect(r.exposure).toBeCloseTo(1.3, 2);
      }
    }
  });

  it('stone bake matches its CPU twin, tiles, keeps unit normals, and box-filters its mips', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('materialBake');
    expect(r.error).toBeNull();
    // Measured on SwiftShader: twin within 0.5 of an 8-bit step (rounding), mips within 0.5 step,
    // the wrap jump within 1.1x the jump between neighbours inside.
    for (const l of r.layers) {
      expect(l.twin, l.stone).toBeLessThanOrEqual(1);
      expect(l.unit, l.stone).toBeLessThan(0.02);
      expect(l.mip, l.stone).toBeLessThanOrEqual(1);
      expect(l.tile.wrap, l.stone).toBeLessThan(1.5 * l.tile.inside + 1);
      for (const m of l.mean) { expect(m, l.stone).toBeGreaterThan(0.8); expect(m, l.stone).toBeLessThan(1.15); }
    }
  });

  it('real look stones: textured blocks carry fine detail, each stone differs, and texture 0 is flat', async (ctx) => {
    if (!gpu) return ctx.skip();
    // Close up on a tumbled block's face (the golden "low" view).
    const r = await call('realChecks', [{}, { stoneDetail: 0 }, { stone: 'granite' }, { stone: 'sandstone' }, { stone: 'concrete' }, { stoneScale: 3 }], [320, 180], [[2.2, 0.45, 2.4], [-1, 1.2, -3]]);
    expect(r.error).toBeNull();
    const [lime, flat, granite, , concrete, scaled] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader (mean |luma - neighbour mean|): limestone 1.11, flat 0.65, granite 2.38,
    // sandstone 1.01, concrete 0.74, limestone at 3x scale 0.95.
    expect(lime!.detail).toBeGreaterThan(1.4 * flat!.detail);
    expect(granite!.detail).toBeGreaterThan(1.5 * lime!.detail);
    expect(concrete!.detail).toBeGreaterThan(flat!.detail);
    expect(scaled!.detail).toBeLessThan(lime!.detail);
    // The texture's mean multiplier is about 1: the same block colours on average.
    expect(Math.abs(lime!.meanLuma / flat!.meanLuma - 1)).toBeLessThan(0.05);
    expect(new Set(r.frames.map((f) => f.hash)).size).toBe(6);
  });

  it('real look bench diagnostics: stone code compiled out draws what texture 0 draws; step-1 blocks differ', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('realChecks', [{ stoneDetail: 0 }, { stoneDetail: 0, realDiag: 'stone-off' }, { realDiag: 'stone-off' }, { stoneDetail: 0, realDiag: 'step1' }], [320, 180], [[2.2, 0.45, 2.4], [-1, 1.2, -3]]);
    expect(r.error).toBeNull();
    const [flat, off, offDetail, step1] = r.frames as NonNullable<typeof r.frames>;
    // Compiled out, the stone knob does nothing, and the frame is texture 0's to the bit.
    expect(off!.hash).toBe(flat!.hash);
    expect(offDetail!.hash).toBe(flat!.hash);
    // Step 1's blocks: the stylized body (no palette per block, wear or dirt).
    expect(step1!.hash).not.toBe(flat!.hash);
  });

  it('real look floor: shadowed street floor about as bright as open shadow; open shadow lit by the whole sky', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('floorChecks', [{}]);
    expect(r.error).toBeNull();
    const [f] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader (sRGB luma): lit 127, open shadow 53, street 54; before the floor kept
    // its contact darkening, open shadow 31. In linear light 53 against 127 is about 0.15, the share
    // of a clear sky's light at 35 degrees of sun; 31 was about 0.05.
    expect(f!.openShadow).toBeGreaterThan(0.36 * f!.lit);
    expect(f!.openShadow).toBeLessThan(0.6 * f!.lit);
    expect(Math.abs(f!.street / f!.openShadow - 1)).toBeLessThan(0.1);
  });

  it('real look: blue sky paling to the horizon, exposure adapting to a low sun, no stylized lights', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('realChecks', ['hazy', {}, { sunElevation: 4, sunAzimuth: 200 }, { sunElevation: 4, sunAzimuth: 200, autoExposure: 0 }]);
    expect(r.error).toBeNull();
    const [hazy, noon, low, lowFixed] = r.frames as NonNullable<typeof r.frames>;
    // Measured on SwiftShader: high sky b/r 1.99, just above the horizon 1.04; the low sun's horizon r/b 1.55.
    const br = (c: number[]) => c[2]! / c[0]!;
    expect(br(noon!.top)).toBeGreaterThan(1.6);
    expect(br(noon!.horizon)).toBeLessThan(0.65 * br(noon!.top));
    expect(br(low!.horizon)).toBeLessThan(0.8);
    // Mean luma 124 at noon; at 4 degrees 116 adapting (0.75), 46 fixed: partial adaptation keeps dusk a little darker.
    expect(low!.meanLuma).toBeGreaterThan(0.75 * noon!.meanLuma);
    expect(low!.meanLuma).toBeLessThan(noon!.meanLuma);
    expect(lowFixed!.meanLuma).toBeLessThan(0.5 * noon!.meanLuma);
    // The ball is a light in hazy; real has no stylized lights.
    expect(hazy!.lit).toBe(1);
    expect(noon!.lit).toBe(0);
    expect(low!.lit).toBe(0);
  });

  it('pixel readback is RGBA whatever the output format (Apple prefers BGRA)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const rgba = await call('sceneHash', {}, 'rgba8unorm'), bgra = await call('sceneHash', {}, 'bgra8unorm');
    expect(rgba.error).toBeNull();
    expect(bgra.error).toBeNull();
    expect(bgra.hash).toBe(rgba.hash);
    // The shadow check thresholds on luma, so a swapped readback moves its numbers (measured lit 142 vs 126 on the grazing slab).
    const a = await call('shadowCheck', 'grazing', { format: 'rgba8unorm' }), b = await call('shadowCheck', 'grazing', { format: 'bgra8unorm' });
    expect(b.lit).toBe(a.lit);
  });

  // Golden images: the looks that exist must not change by a single bit while
  // new looks are added to the same shaders (docs/realism.md). Hashes are
  // pinned per platform, since rasterizers differ (Linux and macOS SwiftShader
  // do); an unpinned platform logs its hashes and skips. UPDATE_GOLDEN=1
  // rewrites this platform's entry, for a change meant to alter these looks:
  // say why in the commit.
  it('candy and hazy are bit-identical to their pinned golden images', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('lookHashes', ['candy', 'hazy']);
    expect(r.error).toBeNull();
    expect((await call('lookHashes', ['candy', 'hazy'])).hashes).toEqual(r.hashes); // deterministic, or the gate means nothing
    const key = `${process.platform} ${gpu.adapter.vendor} ${gpu.adapter.architecture} ${gpu.adapter.description}`.replace(/\s+/g, ' ').trim();
    const file = fileURLToPath(new URL('./golden/looks.json', import.meta.url));
    const pinned = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, number>>;
    if (process.env.UPDATE_GOLDEN === '1') {
      pinned[key] = r.hashes;
      writeFileSync(file, JSON.stringify(pinned, null, 2) + '\n');
      return;
    }
    const want = pinned[key];
    if (!want) {
      console.warn(`no golden images pinned for "${key}"; UPDATE_GOLDEN=1 pins: ${JSON.stringify(r.hashes)}`);
      return ctx.skip();
    }
    expect(r.hashes).toEqual(want);
  });

  it('shadows fall where the analytic sun rays say, without acne or light leaks', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const kind of ['float', 'contact', 'grazing'] as const) {
      const r = await call('shadowCheck', kind);
      expect(r.error).toBeNull();
      expect(r.used).toBeGreaterThan(3000);
      expect(r.wrong).toBe(0); // away from shadow edges and silhouettes, every pixel is lit or shadowed as the rays say
      expect(r.maxStep).toBeLessThanOrEqual(3); // no acne: measured 1.9, 2, 1 (12 on the grazing face without bias)
      if (kind === 'grazing') { expect(r.NoL).toBeCloseTo(0.17, 6); continue; }
      expect(r.iou).toBeGreaterThan(0.95); // measured 0.994 (float), 0.990 (contact)
      expect(r.centroidErr).toBeLessThan(0.02); // metres; measured 5.6 mm, 3.1 mm
      expect(r.leak).toBe(0); // no light under a resting cube (a 30 cm bias leaks 6 cm)
    }
    // The close-up sees a small part of the arena, so its map is the finest.
    expect((await call('shadowCheck', 'contact')).window).toBe(4);
  });

  it('bench:render completes and reports every case (numbers discarded)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('runRenderBench', { width: 160, height: 90, counts: [800], warmup: 1, batches: 2, batchFrames: 1, profiledFrames: 1, sparkPool: 1024 });
    expect(r.cases.map((c) => `${c.world}:${c.variant}`)).toEqual(['near', 'far'].flatMap((w) => ['full', 'no-shadow', 'no-post', 'no-sparks', 'no-heat', 'no-ao', 'no-seam', 'fan', 'cube', 'flat-fan', 'flat-cube', 'real', 'real-no-stone', 'real-stone-off', 'real-step1'].map((v) => `${w}:${v}`)));
    for (const c of r.cases) {
      expect(c.bodies).toBe(800);
      expect(c.frameMs).toBeGreaterThan(0);
      expect(c.batches).toHaveLength(2);
      expect(c.drawn.boxes).toBeGreaterThan(0);
      expect(c.drawn.boxes).toBeLessThanOrEqual(800);
      if (r.timestamps) expect(Object.keys(c.passes)).toEqual(expect.arrayContaining(['cull', 'scene', ...(c.variant === 'no-shadow' ? [] : ['shadow']), ...(c.variant === 'no-post' ? [] : ['bloom', 'composite'])]));
    }
    expect(r.software).toBe(isSoftwareAdapter(gpu.adapter));
    expect(await call('renderBenchMarkdown', r, 'h')).toMatch(/Without heat glow/);
  }, 120_000); // 22 cases on a software adapter; 40 s timed out on CI beside the GPU physics and game tests (main, 8b5dd54)

  it('culling never changes an ID pixel', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('cullInvariance', 21, 4000);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.distinctOnScreen).toBeGreaterThan(100);
    expect(r.drawnBoxes + r.drawnSpheres).toBeLessThan(3000); // most of the cloud is behind or beside the camera
  });

  it('interpolates between the last two steps', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('interpolation', 31);
    expect(r.error).toBeNull();
    // alpha 0 / 1 reproduce prev / current, allowing a few edge pixels for quaternion renormalization.
    expect(r.diff0).toBeLessThan(r.pixels * 0.001);
    expect(r.diff1).toBe(0);
    expect(Math.abs(r.c1 - r.c0)).toBeGreaterThan(5);
    expect(Math.abs(r.c5 - (r.c0 + r.c1) / 2)).toBeLessThan(1);
  });

  it('SnapshotSource uploads only new, active and re-tiered slots, and still draws dormant cells', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('tierUploads', 5);
    expect(r.error).toBeNull();
    expect(r.steps.map((s) => s.equal)).toEqual([true, true, true, true]);
    // All 200; the woken 5, 77, 150; 5 and 150 (active) and 77 (frozen); 5 and 150 and the new slot 200, not 77 (still rubble).
    expect(r.steps.map((s) => s.uploaded / Body.size)).toEqual([200, 3, 3, 3]);
    expect(r.dormantDrawn).toEqual([true, true, true]);
  });

  it("draws a GPU engine's buffers in place: same image, uniforms-only uploads", async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('gpuSource', 41);
    expect(r.error).toBeNull();
    expect(r.diff).toBe(0);
    expect(r.prevEqual).toBe(true); // beforeStep() copied the state into prev
    // Uniforms only (frame, cull, spark and light params, spark control reset): measured 1044 B. Any per-body upload is 41 x Body.size more.
    expect(r.bytesPerFrame).toBeLessThanOrEqual(1536);
    expect(1536).toBeLessThan(41 * Body.size);
  });
});

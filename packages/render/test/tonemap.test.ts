// Tone maps and film grain (realism step 7, tonemap.ts, docs/render/polish.md):
// the CPU twins' properties here, and the WGSL and the composite against them
// in headless Chromium (SwiftShader without a GPU). Correctness only.
import { describe, expect, it } from 'vitest';
import { agx, GRAIN_FLOOR, GRAIN_MID, grained, grainNoise, grainPixels, MID_GREY, parseRealOptions, realLook, REAL_DEFAULTS, REAL_POLISH_OFF, srgbToLinear, TONE_GAIN, TONE_MAPS, toneMapped, writeRealOptions, type V3 } from '../src/index.ts';
import { gpu, call } from './harness.ts';

const luma = (c: V3) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const grey = (v: number): V3 => [v, v, v];

describe('tone maps (CPU twins)', () => {
  it('every operator puts mid grey where AgX does, and AgX is untouched', () => {
    const want = luma(agx(grey(MID_GREY)));
    expect(TONE_GAIN.agx).toBe(1);
    for (const op of TONE_MAPS) expect(Math.abs(luma(toneMapped(op, grey(MID_GREY))) - want), op).toBeLessThan(1e-6);
    // Within a stop and a half of AgX's exposure (measured gains in docs/render/polish.md).
    for (const op of TONE_MAPS) { expect(TONE_GAIN[op], op).toBeGreaterThan(0.35); expect(TONE_GAIN[op], op).toBeLessThan(2.8); }
    expect(toneMapped('agx', [0.3, 0.2, 0.1])).toEqual(agx([0.3, 0.2, 0.1]));
  });

  it('greys stay grey, rise monotonically from black and approach white', () => {
    for (const op of TONE_MAPS) {
      let prev = -1;
      // From 8 stops under mid grey: below that AgX's polynomial toe wobbles by up to 1e-3 (under a quarter
      // of an 8-bit step), as it always has; the others are monotone all the way down.
      for (let ev = op === 'agx' || op === 'agx-base' ? -8 : -14; ev <= 10; ev += 0.25) {
        const c = toneMapped(op, grey(MID_GREY * 2 ** ev));
        expect(Math.max(...c) - Math.min(...c), `${op} ${ev}`).toBeLessThan(2e-3);
        expect(c[1], `${op} ${ev}`).toBeGreaterThanOrEqual(prev - 1e-6);
        prev = c[1];
      }
      expect(toneMapped(op, grey(0))[1], op).toBeLessThan(0.02);
      expect(toneMapped(op, grey(MID_GREY * 2 ** 10))[1], op).toBeGreaterThan(0.95);
    }
  });

  it('PBR Neutral keeps a colour exactly (bar the black offset) below its shoulder, and desaturates above it', () => {
    // Linear in, sRGB out: below the shoulder, out = srgb(gain c - 0.04) for every channel over 0.08.
    const k = TONE_GAIN.neutral;
    const c: V3 = [0.3, 0.2, 0.12];
    const out = toneMapped('neutral', c).map(srgbToLinear);
    c.forEach((v, i) => expect(out[i]).toBeCloseTo(k * v - 0.04, 6));
    // Far above the shoulder a saturated red goes toward white: its blue rises.
    const hot = toneMapped('neutral', [40, 2, 1]);
    expect(hot[2]).toBeGreaterThan(toneMapped('neutral', [0.4, 0.02, 0.01])[2]);
  });

  it('options: real.toneMap parses and writes; the real look carries the polish options; off = none', () => {
    expect(parseRealOptions(new URLSearchParams('real.toneMap=neutral&real.grain=0.3&real.ballMetal=1'))).toEqual({ toneMap: 'neutral', grain: 0.3, ballMetal: 1 });
    expect(() => parseRealOptions(new URLSearchParams('real.toneMap=reinhard'))).toThrow(/toneMap/);
    const q = new URLSearchParams();
    writeRealOptions({ toneMap: 'aces', grainSize: 2 }, q);
    expect(parseRealOptions(q)).toEqual({ toneMap: 'aces', grainSize: 2 });
    const l = realLook({ toneMap: 'aces', grain: 0.4, grainSize: 2, ballMetal: 0.8, ballRough: 0.1 });
    expect(l).toMatchObject({ toneMap: 'aces', grain: { amount: 0.4, size: 2 }, ballMetal: { metal: 0.8, rough: 0.1 } });
    const off = realLook(REAL_POLISH_OFF);
    expect(off.toneMap).toBe('agx');
    expect(off.grain).toBeUndefined();
    expect(off.ballMetal).toBeUndefined();
    expect(REAL_DEFAULTS.grainSize).toBeGreaterThanOrEqual(1);
  });
});

describe('film grain (CPU twin)', () => {
  const field = (seed: number, size: number, w = 192, h = 128) => {
    const v: number[] = [];
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) v.push(grainNoise(x, y, seed, size));
    return { v, w, h };
  };
  const stats = (v: number[]) => { const m = v.reduce((a, b) => a + b, 0) / v.length; return { m, sd: Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length) }; };
  const corr = (f: { v: number[]; w: number }, dx: number) => {
    let s = 0, n = 0;
    for (let i = 0; i < f.v.length; i++) if ((i % f.w) + dx < f.w) { s += f.v[i]! * f.v[i + dx]!; n++; }
    return s / n;
  };

  it('has zero mean and unit variance at every size, grows coarser with size, and changes every frame', () => {
    for (const size of [1, 1.5, 2, 3]) {
      const { m, sd } = stats(field(5, size).v);
      expect(Math.abs(m), `size ${size}`).toBeLessThan(0.05);
      expect(Math.abs(sd - 1), `size ${size}`).toBeLessThan(0.05);
    }
    // Neighbour correlation rises with size (1 px: the 2x2 box at pixel centres; 3 px: smooth).
    expect(corr(field(5, 3), 1)).toBeGreaterThan(corr(field(5, 1.5), 1) + 0.1);
    // Two frames' grain is uncorrelated.
    const a = field(1, 1.5).v, b = field(2, 1.5).v;
    expect(Math.abs(a.reduce((s, x, i) => s + x * b[i]!, 0) / a.length)).toBeLessThan(0.05);
  });

  it('is shot noise: relative strength amount x GRAIN_MID at mid grey, x 1/sqrt(luminance) below, capped at the floor, hue kept', () => {
    const n = 1;
    const at = (y: number) => grained(grey(y), 1, n)[1] / y - 1;
    expect(at(MID_GREY)).toBeCloseTo(GRAIN_MID, 9);
    expect(at(MID_GREY * 4)).toBeCloseTo(GRAIN_MID / 2, 9);
    expect(at(GRAIN_FLOOR)).toBeCloseTo(GRAIN_MID * 4, 9);
    expect(at(GRAIN_FLOOR / 10)).toBeCloseTo(GRAIN_MID * 4, 9);
    const c = grained([0.4, 0.2, 0.1], 0.5, -0.7);
    expect(c[0] / c[1]).toBeCloseTo(2, 12);
    expect(c[1] / c[2]).toBeCloseTo(2, 12);
    expect(grained([0.2, 0.2, 0.2], 1, -100).every((x) => x === 0)).toBe(true); // never negative
    expect(grained([0.2, 0.3, 0.4], 0, 3)).toEqual([0.2, 0.3, 0.4]);
  });

  it('its size is pixels of a 1080-line frame, scaled with the frame (so a 1440p or high-DPI screen sees the same grain), never under 1 px', () => {
    expect(grainPixels(1.5, 1080)).toBe(1.5);
    expect(grainPixels(1.5, 2160)).toBe(3);
    expect(grainPixels(1.5, 400)).toBe(1);
  });
});

describe('tone maps and grain on the GPU', () => {
  it('WGSL matches the twins (tone maps within 1e-4; grain noise within 2e-3, the f32 lattice position at 4000 px)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('toneTwins', 17);
    expect(r.error).toBeNull();
    for (const [name, e] of Object.entries(r.toneErr as Record<string, number>)) expect(e, name).toBeLessThan(1e-4);
    expect(r.grainErr).toBeLessThan(2e-3);
  });

  it('the composite draws each tone map, and grain, as the twins say (within 1 of 255)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const cases = [
      ...TONE_MAPS.map((toneMap) => ({ toneMap })),
      { toneMap: 'agx' as const, grain: { amount: 1, size: 30 }, flat: MID_GREY, seed: 3 },
      { toneMap: 'neutral' as const, grain: { amount: 0.5, size: 40 }, flat: MID_GREY / 8, seed: 4 },
      { toneMap: 'agx' as const, flat: MID_GREY, seed: 3 },
    ];
    const r = await call('postChecks', cases);
    expect(r.error).toBeNull();
    r.cases.forEach((c: { worst: number }, i: number) => expect(c.worst, JSON.stringify(cases[i])).toBeLessThanOrEqual(1.01));
    // (Sizes 30 and 40 at 1080 lines are 1.8 and 2.4 px in this 64-line strip.)
    // Grain shows: at mid grey, amount 1 gives a green spread of several 8-bit steps; none without it (the dither's 1 step).
    const [grainy, , flat] = r.cases.slice(TONE_MAPS.length) as Array<{ mean: number; sd: number }>;
    expect(grainy!.sd).toBeGreaterThan(4);
    expect(flat!.sd).toBeLessThan(1);
    // The grain is centred: the mean moves by under 1 step.
    expect(Math.abs(grainy!.mean - flat!.mean)).toBeLessThan(1);
  }, 120_000);
});

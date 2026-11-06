// Engraved marks (marks.ts): the glyphs on the CPU, the WGSL against its
// TypeScript twin, and what a marked cube draws in headless Chromium
// (SwiftShader without a GPU). Correctness only.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { engrave, MARK_COVER, MARK_HIT, MARK_MASK, MARK_NONE, MARK_SAVE, MARK_SHADE, MARK_SHIFT, markPoint, markSd, packFx, shieldSd, unpackFx, FX_ANCHOR, FX_BAND, FX_MATTE, FX_PAINT, FX_WORDS, type V3 } from '../src/index.ts';
import type * as Drivers from './marks-page.ts';

describe('glyphs (CPU)', () => {
  it('the shield is solid at its middle, pointed at the bottom, flat-topped and symmetric', () => {
    expect(shieldSd(0, 0, 0.46, 0.52, 0.62)).toBeLessThan(-0.4);
    // The point: on the axis just above it is inside, just below outside; beside it outside.
    expect(shieldSd(0, -0.6, 0.46, 0.52, 0.62)).toBeLessThan(0);
    expect(shieldSd(0, -0.64, 0.46, 0.52, 0.62)).toBeGreaterThan(0);
    expect(shieldSd(0.2, -0.6, 0.46, 0.52, 0.62)).toBeGreaterThan(0);
    // The flat top runs the full width; the sides are straight above y = 0.
    expect(shieldSd(0.44, 0.5, 0.46, 0.52, 0.62)).toBeLessThan(0);
    expect(shieldSd(0, 0.54, 0.46, 0.52, 0.62)).toBeGreaterThan(0);
    for (const [x, y] of [[0.3, 0.1], [0.1, -0.4], [0.5, 0.2]] as const) expect(shieldSd(-x, y, 0.46, 0.52, 0.62)).toBe(shieldSd(x, y, 0.46, 0.52, 0.62));
  });

  it('hit is a crosshair: centre dot, ring, ticks on the axes, open on the diagonals inside the ring', () => {
    expect(markSd(MARK_HIT, 0, 0)).toBeLessThan(0);
    for (let a = 0; a < 2 * Math.PI; a += Math.PI / 8) expect(markSd(MARK_HIT, 0.5 * Math.cos(a), 0.5 * Math.sin(a))).toBeLessThan(0);
    for (const [x, y] of [[0, 0.68], [0, -0.68], [0.68, 0], [-0.68, 0], [0, 0.32]] as const) expect(markSd(MARK_HIT, x, y)).toBeLessThan(0);
    for (const [x, y] of [[0.22, 0.22], [-0.22, -0.22], [0.5, 0.5], [0.9, 0.9], [0, 0.85]] as const) expect(markSd(MARK_HIT, x, y)).toBeGreaterThan(0);
  });

  it('save is a shield: solid inner shield, an outline round it, open between the two and outside', () => {
    expect(markSd(MARK_SAVE, 0, 0)).toBeLessThan(0);
    expect(markSd(MARK_SAVE, 0, 0.57)).toBeLessThan(0); // the outline's top
    expect(markSd(MARK_SAVE, 0.46, 0.3)).toBeLessThan(0); // its side
    expect(markSd(MARK_SAVE, 0, -0.55)).toBeLessThan(0); // its point
    expect(markSd(MARK_SAVE, 0.33, 0.3)).toBeGreaterThan(0); // between outline and inner shield
    expect(markSd(MARK_SAVE, 0.35, -0.5)).toBeGreaterThan(0); // beside the point
    expect(markSd(MARK_SAVE, 0, 0.8)).toBeGreaterThan(0);
  });

  it('both glyphs keep clear of the cell edge (the bevel and seam) and cover a similar share of it', () => {
    for (const mark of [MARK_HIT, MARK_SAVE]) {
      for (let t = -1; t <= 1; t += 0.05) for (const [x, y] of [[t, 0.85], [t, -0.85], [0.85, t], [-0.85, t]]) expect(markSd(mark, x!, y!)).toBeGreaterThan(0);
      expect(MARK_COVER[mark]).toBeGreaterThan(0.08);
      expect(MARK_COVER[mark]).toBeLessThan(0.3);
    }
    expect(Math.abs(MARK_COVER[MARK_HIT]! - MARK_COVER[MARK_SAVE]!)).toBeLessThan(0.08);
  });

  it('a long face carries a row of square cells; the glyph is centred in each', () => {
    const half: V3 = [1.5, 0.5, 0.5];
    // Three cells along x on the front face (+z): their centres map to glyph (0, 0).
    for (const cx of [-1, 0, 1]) expect(markPoint([cx, 0, 0.5], [0, 0, 1], half).p.map((v) => +v.toFixed(12))).toEqual([0, 0]);
    expect(markPoint([1.5, 0.5, 0.5], [0, 0, 1], half).p.map((v) => +v.toFixed(12))).toEqual([1, 1]);
    // The end face (+x) is square: one cell, glyph y along body y.
    expect(markPoint([1.5, 0.25, 0], [1, 0, 0], half)).toEqual({ p: [0, 0.5], c: 0.5 });
    // A very long rod caps the cells: wider than square, never thinner than MARK_MAX_CELLS allows.
    expect(markPoint([20, 0, 0.5], [0, 0, 1], [20, 0.5, 0.5]).p[0]).toBeGreaterThan(1);
  });

  it('engrave: nothing without a mark; carved and tilted into the groove up close; only a mean shade once under a pixel', () => {
    const half: V3 = [0.25, 0.25, 0.25], fN: V3 = [0, 0, 1];
    expect(engrave(MARK_NONE, [0, 0, 0.25], fN, half, 0.001)).toEqual({ shade: 1, dn: [0, 0, 0] });
    // The centre dot's middle, 1 mm pixels: full depth, flat floor.
    const mid = engrave(MARK_HIT, [0, 0, 0.25], fN, half, 0.001);
    expect(mid.shade).toBeCloseTo(1 - MARK_SHADE, 9);
    expect(Math.hypot(...mid.dn)).toBeLessThan(1e-6);
    // Just inside the dot's right edge (r 0.15 = 37.5 mm): its wall faces into the groove, toward -x.
    const wall = engrave(MARK_HIT, [0.145 * 0.25, 0, 0.25], fN, half, 0.001);
    expect(wall.dn[0]).toBeLessThan(-0.5);
    expect(Math.abs(wall.dn[1])).toBeLessThan(0.05);
    expect(wall.dn[2]).toBe(0);
    // Open stone between dot and ring: untouched.
    expect(engrave(MARK_HIT, [0.06, 0.06, 0.25], fN, half, 0.001)).toEqual({ shade: 1, dn: [0, 0, 0] });
    // 20 cm pixels: the stroke is a tenth of a pixel. No walls; the mean cover's shade everywhere on the face.
    for (const lp of [[0, 0, 0.25], [0.06, 0.06, 0.25]] as V3[]) {
      const far = engrave(MARK_SAVE, lp, fN, half, 0.2);
      expect(far.dn).toEqual([0, 0, 0]);
      expect(far.shade).toBeCloseTo(1 - MARK_SHADE * MARK_COVER[MARK_SAVE]!, 9);
    }
  });

  it('fx word 1 carries the mark in bits 20-21 beside the other flags; unpack reads it back', () => {
    expect(MARK_MASK).toBe(3 << MARK_SHIFT);
    for (const flag of [FX_ANCHOR, FX_PAINT, FX_MATTE, FX_BAND]) expect(flag & MARK_MASK).toBe(0);
    const w = new Uint32Array(FX_WORDS);
    packFx({ tint: [1, 0.5, 0.2], band: true, scale: 0.5, mark: MARK_SAVE }, w);
    expect(unpackFx(w)).toMatchObject({ mark: MARK_SAVE, band: true, anchor: false });
    expect(unpackFx(w).scale).toBeCloseTo(0.5, 3);
    packFx({ tint: [1, 1, 1] }, w);
    expect(unpackFx(w).mark).toBe(MARK_NONE);
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./marks-page.ts', import.meta.url)), '__marks');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type Face = Array<{ p: [number, number]; l: number }>;
type Sd = (x: number, y: number) => number;
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
/**
 * How well a face's pixels show glyph `sd`: open minus carved mean luma over the samples the glyph
 * calls clearly carved or clearly open (a margin from its edges, where a pixel may be either).
 */
function contrast(face: Face, sd: Sd): number {
  const carved: number[] = [], open: number[] = [];
  for (const { p, l } of face) { const d = sd(p[0], p[1]); if (d < -0.03) carved.push(l); else if (d > 0.06) open.push(l); }
  return mean(open) - mean(carved);
}
/**
 * Whether a face shows glyph a rather than b, where the two disagree: the mean luma of what only b
 * carves minus that of what only a carves (positive: a is the one drawn). Their shared parts (both
 * glyphs have a solid middle) say nothing either way.
 */
function prefers(face: Face, a: Sd, b: Sd): number {
  const onlyA: number[] = [], onlyB: number[] = [];
  for (const { p, l } of face) {
    const da = a(p[0], p[1]), db = b(p[0], p[1]);
    if (da < -0.03 && db > 0.06) onlyA.push(l);
    else if (db < -0.03 && da > 0.06) onlyB.push(l);
  }
  return onlyA.length > 5 && onlyB.length > 5 ? mean(onlyB) - mean(onlyA) : Number.NaN;
}

describe('marked cubes on the GPU', () => {
  const frames = (c: Parameters<typeof Drivers.marksFrames>[0]) =>
    gpu!.page.evaluate((cc) => (window as unknown as { __marks: typeof Drivers }).__marks.marksFrames(cc), c);

  it('the WGSL carving matches its TypeScript twin', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpu.page.evaluate(() => (window as unknown as { __marks: typeof Drivers }).__marks.engraveMatches());
    expect(r.error).toBeNull();
    // Enough of the random points land in a groove and on a wall to mean something.
    expect(r.carved).toBeGreaterThan(r.n / 20);
    expect(r.tilted).toBeGreaterThan(r.n / 100);
    expect(r.shadeErr).toBeLessThan(2e-3);
    expect(r.dnErr).toBeLessThan(2e-3);
  });

  it.for(['hazy', 'real', 'candy'] as const)('%s: each marked face shows its own glyph, not the other one or itself upside down; unmarked faces show none', async (look, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look });
    expect(r.error).toBeNull();
    const [plainGold, hit, save, plainCeladon] = r.faces as [Face, Face, Face, Face];
    const hitSd: Sd = (x, y) => markSd(MARK_HIT, x, y), saveSd: Sd = (x, y) => markSd(MARK_SAVE, x, y), flipped: Sd = (x, y) => markSd(MARK_SAVE, x, -y);
    const msg = JSON.stringify({ hit: [contrast(hit, hitSd), prefers(hit, hitSd, saveSd)], save: [contrast(save, saveSd), prefers(save, saveSd, hitSd), prefers(save, saveSd, flipped)], plain: [contrast(plainGold, hitSd), contrast(plainCeladon, saveSd)] });
    // Carved reads clearly darker (display values, 0-255) where the glyph is, on both colours.
    expect(contrast(hit, hitSd), msg).toBeGreaterThan(20);
    expect(contrast(save, saveSd), msg).toBeGreaterThan(15);
    // Where the glyphs differ, the face shows its own: not the other glyph, not the shield upside down.
    expect(prefers(hit, hitSd, saveSd), msg).toBeGreaterThan(10);
    expect(prefers(save, saveSd, hitSd), msg).toBeGreaterThan(10);
    expect(prefers(save, saveSd, flipped), msg).toBeGreaterThan(10);
    // Unmarked faces carry no pattern.
    expect(Math.abs(contrast(plainGold, hitSd)), msg).toBeLessThan(4);
    expect(Math.abs(contrast(plainCeladon, saveSd)), msg).toBeLessThan(4);
  });

  it('a mark stays through a setFx without one and a bulk scale write, and clearFx removes it', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look: 'hazy', restyle: true });
    expect(r.error).toBeNull();
    expect(r.kept).toEqual([MARK_NONE, MARK_HIT, MARK_SAVE, MARK_NONE]);
    expect(r.cleared).toEqual([0, 0, 0, 0]);
    expect(contrast(r.faces[1] as Face, (x, y) => markSd(MARK_HIT, x, y))).toBeGreaterThan(20);
  });

  it('screenshots (MARKS_SHOTS=dir): before and after, close and far, in each look', async (ctx) => {
    if (!gpu || !process.env.MARKS_SHOTS) return ctx.skip();
    const { writeFileSync } = await import('node:fs');
    const { encodePng } = await import('@tb/testkit');
    for (const look of ['hazy', 'real', 'candy'] as const) for (const marks of [false, true]) for (const dist of [3, 9]) {
      const r = await frames({ look, marks, dist, extras: true, keep: true, size: [640, 400] });
      writeFileSync(`${process.env.MARKS_SHOTS}/marks-${look}-${marks ? 'on' : 'off'}-${dist}m.png`, encodePng(r.size[0]!, r.size[1]!, r.pixels!));
    }
  });
});

describe('x-ray of the objectives on the GPU (Renderer.xray, fsXray)', () => {
  const frames = (look: 'hazy' | 'real' | 'candy') => gpu!.page.evaluate((l) => (window as unknown as { __marks: typeof Drivers }).__marks.xrayFrames({ look: l }), look);
  for (const look of ['hazy', 'real', 'candy'] as const) {
    it(`${look}: a hidden crown shows gold and a hidden heritage block teal, brighter at the edge; nothing else changes; the kinds survive setFx`, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await frames(look);
      expect(r.error).toBeNull();
      expect(r.kinds).toEqual([1, 0, 2, 1, 0]);
      const [crown, plain, heritage, inSight] = r.cubes as { centre: number[]; edge: number[]; restyled: number[] }[];
      // Gold: red up more than blue; teal: green and blue up more than red.
      expect(crown!.centre[0]! - crown!.centre[2]!, JSON.stringify(crown)).toBeGreaterThan(8);
      expect(heritage!.centre[1]! - heritage!.centre[0]!, JSON.stringify(heritage)).toBeGreaterThan(8);
      // The outline: the face's edge changes more than its middle.
      const mag = (d: number[]) => Math.hypot(...d);
      expect(mag(crown!.edge)).toBeGreaterThan(mag(crown!.centre));
      expect(mag(heritage!.edge)).toBeGreaterThan(mag(heritage!.centre));
      // A hidden plain cube, and a crown in plain sight (its own front faces are nearest: depth greater fails), stay as they were.
      expect(Math.max(...plain!.centre.map(Math.abs))).toBeLessThanOrEqual(1);
      expect(Math.max(...inSight!.centre.map(Math.abs), ...inSight!.edge.map(Math.abs))).toBeLessThanOrEqual(1);
      expect(r.outsideChanged).toBe(0);
      // A flash and a scale write keep the kinds: the crown still shows.
      expect(crown!.restyled[0]! - crown!.restyled[2]!).toBeGreaterThan(8);
    });
  }
});


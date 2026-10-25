import { describe, expect, it } from 'vitest';
import { compileLevel, L1, L2 } from '@tb/keystone';
import { tintWord, unpackFx } from '@tb/render';
import { BEAD_COLOUR, BEAD_OUT_COLOUR, BEAD_RADIUS, beadOverlay, rgbe, CROWN_GLOW, easeOut, regrowDuration, regrowScale, regrowScales, structureTints, TARGET_SCALE, TINT, tintOf, tintWordOf } from '../src/scene.ts';

/** What the renderer will see for a bulk tint word. */
const decoded = (w: number) => unpackFx(Uint32Array.of(tintWord(w), 0, 0, 0));

describe('tints', () => {
  it('round-trips through the renderer encoding', () => {
    const fx = decoded(tintWordOf([1, 0.5, 0], 0.25));
    expect(fx.tint.map((x) => Math.round(x * 255))).toEqual([255, 128, 0]);
    expect(fx.emissive).toBeCloseTo(64 / 255, 9);
    expect(fx.scale).toBe(1);
  });
  it('crowns are gold and glow, heritage celadon, then by material', () => {
    const c = compileLevel(L2);
    const t = structureTints(c);
    expect(t).toHaveLength(c.meta.n);
    for (const i of c.meta.crowns) {
      const fx = decoded(t[i]!);
      expect(fx.tint[0]).toBeCloseTo(TINT.crown[0], 2);
      expect(fx.emissive).toBeCloseTo(CROWN_GLOW, 2);
    }
    for (const i of c.meta.heritage) expect(decoded(t[i]!).tint[1]).toBeCloseTo(TINT.heritage[1], 2);
    const slab = c.scene.bodies.findIndex((b) => b.shape.kind === 'box' && b.shape.half[0] > 1);
    expect(decoded(tintOf(c, slab)).tint[0]).toBeLessThan(0.7); // stone is darker
    expect(decoded(tintOf(c, 0)).tint).toEqual([1, 1, 1]); // plaster: no tint
  });
});

describe('Regrow', () => {
  it('eases from 0 to 1 without overshoot', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    for (let k = 1; k <= 100; k++) expect(easeOut(k / 100)).toBeGreaterThanOrEqual(easeOut((k - 1) / 100));
  });
  it('grows course by course and finishes on time', () => {
    const t = 0.1;
    expect(regrowScale(t, 0)).toBeGreaterThan(regrowScale(t, 1));
    expect(regrowScale(t, 1)).toBeGreaterThan(regrowScale(t, 5));
    const c = compileLevel(L1);
    expect(regrowScales(c, 0).every((s) => s === 0)).toBe(true);
    expect(regrowScales(c, regrowDuration(12)).every((s) => s === 1)).toBe(true);
    const mid = regrowScales(c, 0.2);
    expect(mid[0]).toBeGreaterThan(mid[c.meta.n - 1]!); // bottom ahead of top
  });
});

describe('arc preview overlay', () => {
  it('packs overlay colours with red in the low byte', () => {
    expect(rgbe(255, 122, 90, 1)).toBe(0xff5a7aff);
    expect(BEAD_COLOUR & 0xff).toBe(255); // coral is red-dominant
    expect((BEAD_COLOUR >>> 16) & 0xff).toBe(90);
  });
  it('shrinks along the arc and marks the aim point', () => {
    const o = beadOverlay(Float64Array.from([0, 1, 0, 0, 2, 0, 0, 3, 0]), true);
    expect(o.xyzr.length).toBe(12);
    expect([o.xyzr[0], o.xyzr[1], o.xyzr[2]]).toEqual([0, 1, 0]);
    expect(o.xyzr[3]).toBeCloseTo(BEAD_RADIUS, 6);
    expect(o.xyzr[7]!).toBeLessThan(o.xyzr[3]!);
    expect(o.xyzr[11]).toBeCloseTo(BEAD_RADIUS * TARGET_SCALE, 6);
    expect([...o.colours]).toEqual([BEAD_COLOUR, BEAD_COLOUR, BEAD_COLOUR]);
    expect([...beadOverlay(Float64Array.from([0, 1, 0]), false).colours]).toEqual([BEAD_OUT_COLOUR]);
  });
});

import { describe, expect, it } from 'vitest';
import { compileLevel, L1, L2 } from '@tb/keystone';
import { tintWord, unpackFx } from '@tb/render';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { BALL_PAINT, ballFx, BOMB_FX } from '../src/scene.ts';
import { BEAD_COLOUR, BEAD_OUT_COLOUR, BEAD_RADIUS, beadOverlay, rgbe, CROWN_GLOW, easeOut, regrowDuration, regrowScale, regrowScales, structureTints, TARGET_SCALE, TINT, tintOf, tintWordOf } from '../src/scene.ts';

/** What the renderer will see for a bulk tint word. */
const decoded = (w: number) => unpackFx(Uint32Array.of(tintWord(w), 0, 0, 0));

describe('fired balls (ballFx)', () => {
  const lum = (t: readonly number[]) => 0.2126 * t[0]! + 0.7152 * t[1]! + 0.0722 * t[2]!;
  it('painted (the default): each ball in its own colour with a band, far from a bomb\'s near-black and from the crowns\' gold', () => {
    for (const item of ['cannonball', 'marble', 'p-beachball', 'p-bowlingball', 'p-wreckingball', 'p-boulder'] as const) {
      const fx = ballFx(item)!;
      expect(fx, item).toMatchObject({ paint: true, band: true });
      expect(fx.matte, item).toBeUndefined();
      // Linear luminance: a bomb's shell is about 0.012; every painted ball is at least 3x brighter than that before its white band.
      expect(lum(fx.tint!), item).toBeGreaterThan(3 * lum(BOMB_FX.tint));
    }
    // Keystone's own: red and blue, so neither reads as a crown (gold, TINT.crown) and they differ from each other.
    const red = ballFx('cannonball')!.tint!, blue = ballFx('marble')!.tint!;
    expect(red[0]).toBeGreaterThan(4 * red[2]!);
    expect(blue[2]).toBeGreaterThan(4 * blue[0]!);
    expect(lum(red)).toBeGreaterThan(0.1);
    // A preset takes its catalogue colour (sRGB to linear).
    const c = PROJECTILE_PRESETS.beachball.colour, t = ballFx('p-beachball')!.tint!;
    expect(Math.round(255 * Math.pow(t[0]!, 1 / 2.2))).toBeCloseTo((c >> 16) & 255, -1);
    expect(BALL_PAINT.cannonball).toBe(0xc8102e);
  });
  it('a weapon\'s shell, the anvil, the cue and a pull are not painted balls; plain leaves every ball to the look', () => {
    for (const item of ['w-grenade', 'w-cluster', 'drop', 'cue', 'pull'] as const) expect(ballFx(item), item).toBeNull();
    for (const item of ['cannonball', 'marble', 'p-beachball'] as const) expect(ballFx(item, 'plain'), item).toBeNull();
  });
});

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

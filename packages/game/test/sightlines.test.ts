// The CPU ID raster (sightlines.ts) that the opening view's search reads: a lone box covers its outline (so the
// face culling keeps the faces toward the eye), a box behind another is hidden, rotations are honoured, the
// HUD's rectangles are left out, and the outline-only measure agrees with the drawn one.
import { describe, expect, it } from 'vitest';
import { compileLevel, LEVELS } from '@tb/keystone';
import { viewProj } from '@tb/render/camera';
import { idRaster, outlineAreas, pixelCounts, seen, SEEN_MIN_PX, SEEN_SHARE } from '../src/sightlines.ts';
import { fitBox, structureBox } from '../src/view.ts';

describe('CPU ID raster', () => {
  const c = compileLevel(LEVELS[2]!), { min, max } = structureBox(c);
  const o = fitBox(min, max, { yaw: 30, pitch: 20 }, 1.6), m = viewProj(o, 1.6);

  it('a lone box covers its outline: its faces toward the eye are drawn, the rest culled', () => {
    for (const i of [0, 7, c.meta.n - 1]) {
      const r = idRaster(c, m, 320, 200, [i]), px = pixelCounts(r, c.meta.n)[i]!;
      expect(r.solo[i]!).toBeGreaterThan(20);
      // Pixel centres inside the outline: within a pixel's rim of the area (perimeter ~ 4 sqrt(area)).
      expect(Math.abs(px - r.solo[i]!)).toBeLessThanOrEqual(4 * Math.sqrt(r.solo[i]!) + 2);
    }
  });

  it('the whole structure: every pixel has one nearest body; a body never shows more than its outline', () => {
    const r = idRaster(c, m, 320, 200), px = pixelCounts(r, c.meta.n);
    const solo = outlineAreas(c, m, 320, 200);
    for (let i = 0; i < c.meta.n; i++) {
      expect(solo[i]).toBeCloseTo(r.solo[i]!, 9);
      expect(px[i]!).toBeLessThanOrEqual(r.solo[i]! + 4 * Math.sqrt(r.solo[i]!) + 2);
    }
    expect(px.reduce((a, b) => a + b, 0)).toBe(r.ids.reduce((a, v) => a + (v ? 1 : 0), 0));
  });

  it('pixels under a covered rectangle are not counted', () => {
    const r = idRaster(c, m, 320, 200), all = pixelCounts(r, c.meta.n), left = pixelCounts(r, c.meta.n, [{ left: 0, top: 0, right: 0.5, bottom: 1 }]);
    const sum = (a: Uint32Array) => a.reduce((x, y) => x + y, 0);
    let rightHalf = 0;
    for (let y = 0; y < 200; y++) for (let x = 160; x < 320; x++) if (r.ids[y * 320 + x]) rightHalf++;
    expect(sum(left)).toBe(rightHalf);
    expect(sum(left)).toBeLessThan(sum(all));
  });
});

describe('occlusion and rotation', () => {
  it('a block straight behind another is hidden; side by side both show; a turned block is wider', async () => {
    const { L3 } = await import('@tb/keystone');
    // Use a real level's compiled frame for the scene plumbing, with its own blocks moved: two unit cubes on the z axis.
    const c = compileLevel(L3), n = c.meta.n;
    const home = c.meta.home;
    // Body 0 at the origin, body 1 two units behind it along the view, the rest far off screen.
    for (let i = 0; i < n; i++) home.set([1000 + 3 * i, 0.5, 1000], 3 * i);
    for (let i = 0; i < n; i++) c.scene.bodies[i]!.rot = [0, 0, 0, 1];
    for (const i of [0, 1]) c.meta.half.set([0.5, 0.5, 0.5], 3 * i);
    home.set([0, 0.5, 0], 0);
    home.set([0, 0.5, -2], 3);
    const o = { target: [0, 0.5, 0] as [number, number, number], yaw: 0, pitch: 0, distance: 8, fovY: Math.PI / 4 };
    let px = pixelCounts(idRaster(c, viewProj(o, 1), 100, 100), n);
    expect(px[0]).toBeGreaterThan(50);
    expect(px[1]).toBe(0);
    home.set([1.5, 0.5, -2], 3);
    px = pixelCounts(idRaster(c, viewProj(o, 1), 100, 100), n);
    expect(px[0]).toBeGreaterThan(50);
    expect(px[1]).toBeGreaterThan(20);
    // Turned 45 degrees about y, the front cube shows an edge-on corner: about sqrt(2) times as wide.
    const square = idRaster(c, viewProj(o, 1), 100, 100, [0]).solo[0]!;
    c.scene.bodies[0]!.rot = [0, Math.sin(Math.PI / 8), 0, Math.cos(Math.PI / 8)];
    const turned = idRaster(c, viewProj(o, 1), 100, 100, [0]).solo[0]!;
    expect(turned / square).toBeGreaterThan(1.3);
    expect(turned / square).toBeLessThan(1.5);
  });
});

describe('seen', () => {
  it('needs SEEN_SHARE of the outline and SEEN_MIN_PX pixels, or a stricter share when asked', () => {
    expect(seen(25, 100)).toBe(SEEN_SHARE <= 0.25);
    expect(seen(24, 100)).toBe(false);
    expect(seen(SEEN_MIN_PX - 1, 1)).toBe(false);
    expect(seen(30, 100, 0.35)).toBe(false);
    expect(seen(35, 100, 0.35)).toBe(true);
  });
});

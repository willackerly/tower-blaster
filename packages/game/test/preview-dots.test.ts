// The aim preview's dots on screen (PT36, preview-dots.ts): near the eye dropped and grown in, none wider than
// DOT_MAX_PX, none but the last over an objective's box it stands in front of; the colours stay with their dots.
import { describe, expect, it } from 'vitest';
import { emptySnapshot } from '@tb/engine-api';
import { compileLevel, L1 } from '@tb/keystone';
import type { Orbit } from '@tb/render/camera';
import { previewBeads, shotFor, SUBSTEPS, azFromYaw, launchHeight } from '../src/aim.ts';
import { DOT_FADE_M, DOT_MAX_PX, DOT_NEAR_M, type Dots, fitDots, onScreen, screenBoxes } from '../src/preview-dots.ts';
import { beadOverlay } from '../src/scene.ts';
import { viewOf } from '../src/view.ts';
import { viewProj } from '@tb/render/camera';

/** An eye at the origin's +z, 10 m back, looking at the origin; a 400 px tall screen. */
const VIEW: Orbit = { target: [0, 0, 0], yaw: 0, pitch: 0, distance: 10, fovY: (45 * Math.PI) / 180 };
const SCREEN = { view: VIEW, width: 400, height: 400 };
const dots = (pts: [number, number, number, number][]): Dots => ({ xyzr: Float32Array.from(pts.flat()), colours: Uint32Array.from(pts.map((_, i) => i + 1)) });
const px = (d: Dots, k: number) => { const vp = viewProj(VIEW, 1), at = onScreen([d.xyzr[4 * k]!, d.xyzr[4 * k + 1]!, d.xyzr[4 * k + 2]!], vp, SCREEN)!; return (2 * d.xyzr[4 * k + 3]! * (SCREEN.height / 2 / Math.tan(VIEW.fovY / 2))) / at.depth; };

describe('fitDots', () => {
  it('drops dots within DOT_NEAR_M of the eye and grows the next DOT_FADE_M in', () => {
    // The eye is at z = 10: dots at 1, 4 and 8 m from it.
    const out = fitDots(dots([[0, 0, 9, 0.001], [0, 0, 6, 0.001], [0, 0, 2, 0.001]]), SCREEN);
    expect([...out.colours]).toEqual([2, 3]);
    expect(out.xyzr[3]).toBeCloseTo(0.001 * Math.min(1, (4 - DOT_NEAR_M) / DOT_FADE_M), 6);
    expect(out.xyzr[7]).toBeCloseTo(0.001, 6);
  });

  it('caps every dot at DOT_MAX_PX across, and leaves small ones as they are', () => {
    const out = fitDots(dots([[0, 0, 4, 0.5], [0.5, 0, 0, 0.5], [0, 0, -20, 0.01]]), SCREEN);
    expect(out.colours.length).toBe(3);
    for (let k = 0; k < 3; k++) expect(px(out, k)).toBeLessThanOrEqual(DOT_MAX_PX + 1e-6);
    expect(px(out, 0)).toBeCloseTo(DOT_MAX_PX, 4);
    expect(out.xyzr[11]).toBeCloseTo(0.01, 6);
  });

  it('leaves a gap over an objective it passes in front of, but keeps the last dot and dots behind it', () => {
    // A 1 m box at the origin; dots in front of it (z 2), behind it (z -3), beside it (x 3), and the last on its face.
    const snap = { pos: Float64Array.of(0, 0, 0), rot: Float64Array.of(0, 0, 0, 1) };
    const boxes = screenBoxes([0], snap, [0.5, 0.5, 0.5], SCREEN);
    expect(boxes.length).toBe(1);
    const out = fitDots(dots([[0, 0, 2, 0.02], [0, 0, -3, 0.02], [3, 0, 0, 0.02], [0, 0, 0.5, 0.02]]), SCREEN, boxes);
    expect([...out.colours]).toEqual([2, 3, 4]);
  });

  it("L1's opening view: the opening flight's dots are all within DOT_MAX_PX on a desktop and a phone", () => {
    const c = compileLevel(L1), s = emptySnapshot(c.meta.n);
    s.pos.set(c.meta.home);
    for (const [w, h] of [[1280, 800], [390, 844]] as const) {
      const view = viewOf(c, w / h), target: [number, number, number] = [c.meta.home[3 * c.meta.crowns[0]!]!, c.meta.home[3 * c.meta.crowns[0]! + 1]!, c.meta.home[3 * c.meta.crowns[0]! + 2]!];
      const a = shotFor(c, 'cannonball', azFromYaw(view.yaw), 100, target, SUBSTEPS, launchHeight(c, 'high'))!;
      const out = fitDots(beadOverlay(previewBeads(c, a.shot, target), true), { view, width: w, height: h });
      expect(out.colours.length).toBeGreaterThan(3);
      const vp = viewProj(view, w / h), pxAt1 = h / 2 / Math.tan(view.fovY / 2);
      for (let k = 0; k < out.colours.length; k++) {
        const at = onScreen([out.xyzr[4 * k]!, out.xyzr[4 * k + 1]!, out.xyzr[4 * k + 2]!], vp, { width: w, height: h })!;
        expect((2 * out.xyzr[4 * k + 3]! * pxAt1) / at.depth).toBeLessThanOrEqual(DOT_MAX_PX + 1e-6);
      }
    }
  });
});

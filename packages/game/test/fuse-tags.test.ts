// Fuse & Fold's tags in the scene (fuse-panel.ts, agent playtest round 2 PT24): where a world point shows on the
// screen, which tags show when they would overlap (F4's twelve piled up on a phone), and the order they claim places.
import { describe, expect, it } from 'vitest';
import { compileLevel, FUSE_LEVELS } from '@tb/keystone';
import { viewProj } from '@tb/render/camera';
import { FUSE_HINT, placeTags, screenPoint, tagOrder } from '../src/fuse-panel.ts';
import { viewOf } from '../src/view.ts';

describe('fuse tags', () => {
  it('screenPoint: the view\'s target at the box\'s middle, a point behind the eye or off screen none', () => {
    const c = compileLevel(FUSE_LEVELS[0]!), o = viewOf(c, 1.6), m = viewProj(o, 1.6), box = { left: 10, top: 20, width: 1280, height: 800 };
    const p = screenPoint(m, o.target as [number, number, number], box)!;
    expect(p[0]).toBeCloseTo(10 + 640, 3); // float32 matrix
    expect(p[1]).toBeCloseTo(20 + 400, 3);
    const eye = [o.target[0] + 2 * o.distance * Math.cos(o.pitch) * Math.sin(o.yaw), o.target[1] + 2 * o.distance * Math.sin(o.pitch), o.target[2] + 2 * o.distance * Math.cos(o.pitch) * Math.cos(o.yaw)] as [number, number, number];
    expect(screenPoint(m, eye, box)).toBeNull();
    expect(screenPoint(m, [o.target[0] + 1e4 * Math.cos(o.yaw), o.target[1], o.target[2] - 1e4 * Math.sin(o.yaw)], box)).toBeNull();
  });

  it('placeTags: in order, a tag whose box would overlap a shown one hides; one off screen hides', () => {
    const size = { w: 40, h: 14 };
    // 0 and 1 share a spot; 2 is clear of both; 3 is off screen.
    const shown = placeTags([[100, 100], [110, 102], [300, 100], null], [size, size, size, size], [1, 0, 2, 3]);
    expect(shown).toEqual([false, true, true, false]);
    // Side by side with room for the padding: both show.
    expect(placeTags([[100, 100], [145, 100]], [size, size], [0, 1])).toEqual([true, true]);
    expect(placeTags([[100, 100], [141, 100]], [size, size], [0, 1])).toEqual([true, false]);
  });

  it('tagOrder: N and Yard, the selected charge, one charge of each delay (earliest first), then the rest', () => {
    // A west sweep of F4's twelve at 0.6 s: rows A to D at 0, 6, 12 and 18 snaps; charge 7 selected; two anchors.
    const snaps = [0, 0, 0, 6, 6, 6, 12, 12, 12, 18, 18, 18];
    expect(tagOrder(snaps, 7, 2)).toEqual([12, 13, 7, 0, 3, 6, 9, 1, 2, 4, 5, 8, 10, 11]);
    expect(tagOrder([0, 0, 0], -1, 0)).toEqual([0, 1, 2]);
  });

  it('the hint names the Sweep\'s purpose and the next step', () => {
    expect(FUSE_HINT).toBe('Sweep toward the yard, then Plunger');
  });
});

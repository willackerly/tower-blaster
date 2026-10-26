// The stone's level of detail (stoneLodDepth): past the depth it returns,
// every pixel of any surface covers at least the fade-out footprint.
import { describe, expect, it } from 'vitest';
import { frustumPlanes, invert, lookAt, multiply, perspective, stoneLodDepth, type V3 } from '../src/index.ts';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const len = (a: V3) => Math.hypot(...a);

describe('stone level of detail', () => {
  it('past stoneLodDepth, a pixel covers at least the fade-out on any surface it sees', () => {
    const r = rng(42);
    let tested = 0, minRatio = Infinity;
    for (let cam = 0; cam < 40; cam++) {
      const fov = 0.5 + r() * 1.1, aspect = 1 + r() * 1.5, height = Math.round(90 + r() * 2070), width = Math.round(height * aspect);
      const target: V3 = [r() - 0.5, r() - 0.5, -1];
      // Camera-relative (the eye at the origin), as the renderer passes it.
      const vp = multiply(perspective(fov, aspect, 0.1, 1e4), lookAt([0, 0, 0], target));
      const inv = invert(vp);
      const near = frustumPlanes(vp).slice(16, 20);
      const fade = 0.01 + r() * 0.2;
      const depth = stoneLodDepth(vp, height, fade);
      // The world point under clip (x, y) on the near plane: rays from the eye through it.
      const ray = (px: number, py: number): V3 => {
        const x = (2 * px) / width - 1, y = 1 - (2 * py) / height;
        const c = [x, y, 0, 1].map((_, i) => [x, y, 0, 1].reduce((acc, v, j) => acc + inv[j * 4 + i]! * v, 0));
        const p: V3 = [c[0]! / c[3]!, c[1]! / c[3]!, c[2]! / c[3]!];
        return scale(p, 1 / len(p));
      };
      for (let k = 0; k < 200; k++) {
        const px = r() * (width - 1), py = r() * (height - 1);
        const d = ray(px, py);
        // A point on that ray at least depth past the near plane, and a surface through it facing the eye.
        const dist = (depth * (1 + 3 * r()) - near[3]!) / dot(d, [near[0]!, near[1]!, near[2]!] as V3);
        const P = scale(d, dist);
        let n: V3 = [r() - 0.5, r() - 0.5, r() - 0.5];
        n = scale(n, 1 / len(n));
        if (dot(n, d) > 0) n = scale(n, -1);
        if (dot(n, d) > -0.02) continue; // edge-on: nothing to shade
        expect(dot([near[0]!, near[1]!, near[2]!] as V3, P) + near[3]!).toBeGreaterThanOrEqual(depth * 0.999);
        const hit = (q: V3) => scale(q, dot(n, P) / dot(n, q));
        const dx = len(sub(hit(ray(px + 1, py)), P)), dy = len(sub(hit(ray(px, py + 1)), P));
        // fsBox's pxM, the length of fwidth of the position, is at least sqrt(dx^2 + dy^2).
        minRatio = Math.min(minRatio, Math.hypot(dx, dy) / fade);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(7000);
    expect(minRatio).toBeGreaterThanOrEqual(1);
    // And not wastefully far: the bound is within a factor of 2 of the tightest case.
    expect(minRatio).toBeLessThan(2);
  });

  it('scales with the fade-out and the viewport', () => {
    const vp = multiply(perspective(0.9, 16 / 9, 0.1, 400), lookAt([0, 0, 0], [0, 0, -1]));
    expect(stoneLodDepth(vp, 1440, 0.08)).toBeCloseTo(2 * stoneLodDepth(vp, 1440, 0.04), 9);
    expect(stoneLodDepth(vp, 1440, 0.08)).toBeCloseTo(2 * stoneLodDepth(vp, 720, 0.08), 9);
  });
});

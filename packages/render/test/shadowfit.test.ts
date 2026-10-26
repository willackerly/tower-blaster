// The shadow window fit (design step 12), on the CPU: what the map covers,
// how it snaps and how its size ladder behaves as the camera moves.
import { describe, expect, it } from 'vitest';
import { rng } from '@tb/scenarios';
import { clipToBox, fitShadow, frustumCorners, invert, lookAt, multiply, perspective, SHADOW_LADDER_MIN, SUN, transform, type Arena, type ShadowFitState, type V3 } from '../src/index.ts';

const SIZE = 2048;
const ARENA: Arena = { center: [0, 4, 0], half: [30, 12, 30], radius: 36 };

function cameraAt(eye: V3, target: V3) {
  const viewProj = multiply(perspective(1, 16 / 9, 0.1, 500), lookAt(eye, target));
  const c = ARENA.center;
  const reach = Math.hypot(eye[0] - c[0], eye[1] - c[1], eye[2] - c[2]) + ARENA.radius!;
  return { viewProj, eye, corners: frustumCorners(invert(viewProj), eye, reach), reach };
}

const fit = (cam: ReturnType<typeof cameraAt>, state: ShadowFitState = { level: -1 }) => fitShadow(ARENA, SUN, cam.corners, SIZE, state);

const inArena = (p: V3) => {
  const { center: c, half: h, radius: r } = ARENA;
  return [0, 1, 2].every((k) => Math.abs(p[k]! - c[k]!) <= h[k]!) && Math.hypot(p[0] - c[0], p[1] - c[1], p[2] - c[2]) <= r!;
};

/** Points the camera sees that lie in the arena: along random rays through the image, up to reach. */
function visiblePoints(cam: ReturnType<typeof cameraAt>, r: () => number, n: number): V3[] {
  const inv = invert(cam.viewProj), out: V3[] = [];
  for (let tries = 0; out.length < n && tries < 50 * n; tries++) {
    const q = transform(inv, [r() * 2 - 1, r() * 2 - 1, 1]);
    const far: V3 = [q[0] / q[3], q[1] / q[3], q[2] / q[3]];
    const d = Math.hypot(far[0] - cam.eye[0], far[1] - cam.eye[1], far[2] - cam.eye[2]);
    const t = (0.2 + r() * (cam.reach - 0.2)) / d;
    const p = [0, 1, 2].map((k) => cam.eye[k]! + (far[k]! - cam.eye[k]!) * t) as V3;
    if (inArena(p)) out.push(p);
  }
  return out;
}

const inClip = (m: Float32Array, p: V3) => {
  const c = transform(m, p);
  return Math.abs(c[0]) <= 1 && Math.abs(c[1]) <= 1 && c[2] >= 0 && c[2] <= 1;
};

function orbit(angle: number, dist: number, height: number): ReturnType<typeof cameraAt> {
  return cameraAt([Math.cos(angle) * dist, height, Math.sin(angle) * dist], ARENA.center);
}

describe('clipToBox', () => {
  it('returns points of frustum ∩ box whose bounds hold every point of the intersection', () => {
    const r = rng(80);
    let nonEmpty = 0;
    for (let c = 0; c < 100; c++) {
      const cam = cameraAt([(r() - 0.5) * 80, (r() - 0.5) * 40, (r() - 0.5) * 80], [(r() - 0.5) * 40, (r() - 0.5) * 20, (r() - 0.5) * 40]);
      const center: V3 = [(r() - 0.5) * 20, (r() - 0.5) * 10, (r() - 0.5) * 20], half: V3 = [2 + r() * 20, 2 + r() * 10, 2 + r() * 20];
      const pts = clipToBox(cam.corners, center, half);
      const inBox = (p: V3) => [0, 1, 2].every((k) => Math.abs(p[k]! - center[k]!) <= half[k]! * (1 + 1e-9) + 1e-6);
      for (const p of pts) expect(inBox(p)).toBe(true);
      // Sample the intersection: random box points the camera sees within reach.
      const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
      for (const p of pts) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k]!, p[k]!); hi[k] = Math.max(hi[k]!, p[k]!); }
      let hits = 0;
      for (let i = 0; i < 3000; i++) {
        const p = center.map((v, k) => v + (r() * 2 - 1) * half[k]!) as V3;
        const q = transform(cam.viewProj, p);
        const seen = q[3] > 0 && Math.abs(q[0] / q[3]) <= 1 && Math.abs(q[1] / q[3]) <= 1 && q[2] / q[3] >= 0 && q[2] / q[3] <= 1;
        const d = Math.hypot(p[0] - cam.eye[0], p[1] - cam.eye[1], p[2] - cam.eye[2]);
        if (!seen || d > cam.reach) continue;
        hits++;
        for (let k = 0; k < 3; k++) {
          expect(p[k]!).toBeGreaterThanOrEqual(lo[k]! - 1e-6);
          expect(p[k]!).toBeLessThanOrEqual(hi[k]! + 1e-6);
        }
      }
      if (hits) nonEmpty++;
    }
    expect(nonEmpty).toBeGreaterThan(30);
  });
});

describe('fitShadow', () => {
  it('covers every point the camera sees in the arena, and every caster along the light', () => {
    const r = rng(81);
    let checked = 0;
    for (let c = 0; c < 200; c++) {
      const eye: V3 = [(r() - 0.5) * 120, 1 + r() * 60, (r() - 0.5) * 120];
      const target: V3 = [(r() - 0.5) * 60, r() * 10, (r() - 0.5) * 60];
      const cam = cameraAt(eye, target);
      const f = fit(cam);
      for (const p of visiblePoints(cam, r, 40)) {
        expect(inClip(f.matrix, p)).toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(4000);
    // Depth spans the whole arena, so no caster is clipped by near or far.
    const r2 = rng(82), f = fit(orbit(0.3, 50, 20));
    for (let i = 0; i < 2000; i++) {
      const p = ARENA.center.map((v, k) => v + (r2() * 2 - 1) * ARENA.half[k]!) as V3;
      if (!inArena(p)) continue;
      const z = transform(f.matrix, p)[2];
      expect(z).toBeGreaterThanOrEqual(0);
      expect(z).toBeLessThanOrEqual(1);
    }
  });

  it('a low sun: the floor past the arena where its shadows land is covered too', () => {
    // An 8 degree sun from +z: the arena's top (y = 16) casts 12/tan(8) = 85 m past its -z side, along the floor (y = -8).
    const e = (8 * Math.PI) / 180, sun: V3 = [0, Math.sin(e), Math.cos(e)];
    const top: V3 = [10, 16, -25], hit: V3 = [10, -8, -25 - 24 / Math.tan(e)];
    // The camera looks at that floor point, well outside the arena box.
    const cam = cameraAt([10, 4, -60], hit);
    const f = fitShadow(ARENA, sun, cam.corners, SIZE, { level: -1 }, -8);
    expect(inClip(f.matrix, hit)).toBe(true);
    // The caster and its shadow share the light-space x, y.
    const a = transform(f.matrix, top), b = transform(f.matrix, hit);
    expect(a[0]).toBeCloseTo(b[0], 6);
    expect(a[1]).toBeCloseTo(b[1], 6);
    // Still no larger than the arena's light-space box needs.
    expect(f.half).toBeLessThanOrEqual(ARENA.radius! * Math.SQRT2 + 1e-9);
  });

  it('is much tighter than the arena close up, and never larger than the arena needs', () => {
    // Looking down at the arena floor (y = -8) from 6 m.
    const close = fit(cameraAt([0, -2, 0.5], [0, -8, 0]));
    const wide = fit(cameraAt([0, 120, 1], [0, 0, 0]));
    expect(close.half).toBeLessThan(wide.half / 2);
    // The arena's light-space extent is at most its radius each way; the ladder rounds up by at most sqrt(2).
    expect(wide.half).toBeLessThanOrEqual(ARENA.radius! * Math.SQRT2 + 1e-9);
    expect(close.half).toBeGreaterThanOrEqual(SHADOW_LADDER_MIN);
    expect(close.texel).toBeCloseTo((2 * close.half) / SIZE, 12);
  });

  it('snaps the window centre to whole texels, so the map shifts by whole texels', () => {
    const state: ShadowFitState = { level: -1 };
    let prev = fit(orbit(0, 40, 15), state);
    for (let i = 1; i <= 60; i++) {
      const f = fit(orbit(i * 0.002, 40, 15), state);
      for (const k of [0, 1]) {
        expect(Math.abs(f.center[k]! / f.texel - Math.round(f.center[k]! / f.texel))).toBeLessThan(1e-6);
        if (f.level === prev.level) {
          const shift = (f.center[k]! - prev.center[k]!) / f.texel;
          expect(Math.abs(shift - Math.round(shift))).toBeLessThan(1e-6);
        }
      }
      // The clip matrix places a fixed world point at a whole-texel offset from where it was.
      if (f.level === prev.level) {
        const p: V3 = [3, 1, -2];
        const a = transform(prev.matrix, p), b = transform(f.matrix, p);
        for (const k of [0, 1]) {
          const texels = ((b[k]! - a[k]!) * SIZE) / 2;
          expect(Math.abs(texels - Math.round(texels))).toBeLessThan(2e-3); // f32 matrices
        }
      }
      prev = f;
    }
  });

  it('grows at once, shrinks only with 15% to spare, and does not flicker on a wobbling camera', () => {
    // Walk the camera in until the level drops, then wobble around that spot.
    const state: ShadowFitState = { level: -1 };
    const at = (d: number) => fit(cameraAt([d, d * 0.6, d * 0.8], ARENA.center), state);
    let d = 80, level = at(d).level, dropAt = -1;
    while (d > 3) {
      d *= 0.99;
      const f = at(d);
      expect(f.level).toBeLessThanOrEqual(level); // moving in never grows the window
      if (f.level < level) { dropAt = d; level = f.level; break; }
    }
    expect(dropAt).toBeGreaterThan(0);
    const changes = new Set<number>();
    for (let i = 0; i < 200; i++) changes.add(at(dropAt * (1 + 0.04 * Math.sin(i))).level);
    expect(changes.size).toBe(1);
    // Moving out far enough grows it in the same frame, to a window that fits.
    const fresh = fit(cameraAt([80, 48, 64], ARENA.center));
    expect(at(80).level).toBe(fresh.level);
  });

  it('falls back to the whole arena when the camera sees none of it', () => {
    const away = fit(cameraAt([0, 4, 200], [0, 4, 400]));
    const all = fit(cameraAt([0, 300, 1], ARENA.center));
    expect(away.level).toBe(all.level);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const p: V3 = [sx * 20, 4, sz * 20];
      expect(inClip(away.matrix, p)).toBe(true);
    }
  });
});

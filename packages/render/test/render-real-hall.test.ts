// The exhibition hall around the scene (hall.ts, Kapla step K3.2a), drawn in
// headless Chromium (SwiftShader without a GPU): what it hides and what hides
// it, checked pixel by pixel against the CPU trace. Correctness only: timings
// from here are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

describe('the hall', () => {
  it('drawn where the trace hits it, hiding bodies behind its columns and hidden by bodies in front; nothing at the floor or with the eye outside', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('hallFrames', [
      // Down the nave from near one end: towers, the vault, galleries and the far end screen.
      { eye: [0, 3, 14], target: [0, 7, -10] },
      // From an aisle, past the middle bay line's column at x = 26.5, toward the towers.
      { eye: [30, 1.7, 0.4], target: [0, 1.7, -0.6] },
      // Above the crown (31 m): outside, so no hall.
      { eye: [0, 40, 14], target: [0, 2, -3] },
    ]);
    expect(r.error).toBeNull();
    const [nave, aisle, outside] = r.views as NonNullable<typeof r.views>;
    for (const v of [nave!, aisle!]) {
      // Where rays meet the floor first, the frame is the outdoor one, exactly.
      expect(v.none.n).toBeGreaterThan(1000);
      expect(v.none.max).toBe(0);
    }
    // The hall's surfaces drew over the sky.
    expect(nave!.opaque.n).toBeGreaterThan(2000);
    expect(nave!.opaque.changed).toBe(nave!.opaque.n);
    expect(nave!.glass.n).toBeGreaterThan(1000);
    expect(nave!.glass.changed).toBeGreaterThan(0.99 * nave!.glass.n);
    // Bodies in front of the hall: drawn as outdoors.
    expect(nave!.front.n).toBeGreaterThan(500);
    expect(nave!.front.max).toBe(0);
    // A column in front of bodies hides them: its pixels are the same with no bodies at all.
    expect(aisle!.hidden.n).toBeGreaterThan(50);
    expect(aisle!.hidden.outdoorMax).toBeGreaterThan(20);
    expect(aisle!.hidden.max).toBe(0);
    expect(outside!.allMax).toBe(0);
  }, 120_000);

  it('the same frame at any world scale (eye and planes in world units of 1 / metres)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('hallScale', [1, 0.5, 0.0234], [0, 3, 14], [0, 7, -10]);
    expect(r.error).toBeNull();
    // Measured on SwiftShader: 6 and 52 pixels differ by more than 2 levels, all on edges or in the
    // ribs' and balustrade's hard-edged lattices, where f32 rounding of the ray moves a bar by a pixel.
    for (const c of r.cmp) {
      expect(c.over).toBeLessThan(0.002 * 320 * 180);
      expect(c.inside).toBe(0);
    }
  }, 120_000);
});

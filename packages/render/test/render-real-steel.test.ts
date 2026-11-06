// The real look's steel ball (realism step 7, docs/render/polish.md), drawn in
// headless Chromium (SwiftShader without a GPU). Correctness only: timings
// from here are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

type Case = { hash: number; glint: [number, number]; want: [number, number]; peak: number; hot: number; top: number[]; bottom: number[] };

describe('steel ball (realism step 7)', () => {
  it('a steel ball mirrors sky and ground, glints where the sun reflects, and leaves painted and matte balls alone', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('steelBallChecks', [
      { real: { ballMetal: 0 } },
      { real: { ballMetal: 1, ballRough: 0.08 } },
      { real: { ballMetal: 1, ballRough: 0.35 } },
      { real: { ballMetal: 0 }, paint: true },
      { real: { ballMetal: 1 }, paint: true },
      { real: { ballMetal: 0 }, matte: true },
      { real: { ballMetal: 1 }, matte: true },
    ]);
    expect(r.error).toBeNull();
    const [coat, polished, rough, paint0, paint1, matte0, matte1] = r.cases as Case[];
    const ratio = (c: number[]) => c[2]! / c[0]!;
    // The glint sits where the specular geometry puts it (measured within 1 px), steel or coated.
    for (const c of [coat, polished, rough]) expect(Math.hypot(c!.glint[0] - c!.want[0], c!.glint[1] - c!.want[1])).toBeLessThan(1.5);
    // A mirror: the steel's upper half takes the sky's blue and its lower half the ground's brown (measured blue / red
    // 1.20 and 0.79); the clear-coated ball, lit mostly by the sun, barely shifts (0.96 and 0.91).
    expect(ratio(polished!.top)).toBeGreaterThan(1.1);
    expect(ratio(polished!.bottom)).toBeLessThan(0.85);
    expect(ratio(polished!.top) - ratio(polished!.bottom)).toBeGreaterThan(0.3);
    expect(ratio(coat!.top) - ratio(coat!.bottom)).toBeLessThan(0.1);
    // Rougher steel blurs the sky toward its mean: a smaller top-to-bottom split than polished (measured 0.32 against 0.41).
    expect(ratio(rough!.top) - ratio(rough!.bottom)).toBeLessThan(ratio(polished!.top) - ratio(polished!.bottom));
    // The sun's glint on polished steel saturates (13 pixels at 250+ against none on the coat).
    expect(polished!.hot).toBeGreaterThan(coat!.hot + 5);
    // Steel is the look's own ball only: painted and matte (a bomb's iron) balls draw the same either way.
    expect(polished!.hash).not.toBe(coat!.hash);
    expect(paint1!.hash).toBe(paint0!.hash);
    expect(matte1!.hash).toBe(matte0!.hash);
  }, 120_000);
});

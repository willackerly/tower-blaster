// The real look's dust shape knobs (dustErode, dustThin, dustSkirt), drawn in
// headless Chromium (SwiftShader without a GPU). Split from render.test.ts so
// CI shards can run the slow drawing tests side by side (erosion and the
// skirt are render-real-dust.test.ts, so neither file passes CI's 300 s). Correctness only:
// timings from here are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

const zero = { dustErode: 0, dustThin: 0, dustSkirt: 0 };
type Region = { area: number; outline: number; sum: number; aspect: number };
type Shape = { looks: Array<{ air: Region; ground: Region }>; error: string | null };

describe('dust shape (2026-11-02)', () => {
  it('thinning keeps a young puff dense and makes a grown one faint', async (ctx) => {
    if (!gpu) return ctx.skip();
    const looks = [zero, { ...zero, dustThin: 1 }];
    const young: Shape = await call('dustShape', looks, 12), old: Shape = await call('dustShape', looks, 100);
    for (const r of [young, old]) expect(r.error).toBeNull();
    // Normalised at half grown: denser while small (0.2 s), fainter grown (1.7 s).
    expect(young.looks[1]!.air.sum).toBeGreaterThan(1.5 * young.looks[0]!.air.sum);
    expect(old.looks[1]!.air.sum).toBeLessThan(0.8 * old.looks[0]!.air.sum);
  }, 480_000); // two runs of three renderers; 480 s as its sibling's (render-real-dust.test.ts)
});

// The real look's dust shape knobs (dustErode, dustThin, dustSkirt), drawn in
// headless Chromium (SwiftShader without a GPU). Split from render.test.ts so
// CI shards can run the slow drawing tests side by side. Correctness only:
// timings from here are never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';

const zero = { dustErode: 0, dustThin: 0, dustSkirt: 0 };
type Region = { area: number; outline: number; sum: number; aspect: number };
type Shape = { looks: Array<{ air: Region; ground: Region }>; error: string | null };

describe('dust shape (2026-11-02)', () => {
  it('erosion roughens and eats a puff\'s edge; the skirt flattens soil from a flat landing and leaves air bursts alone', async (ctx) => {
    if (!gpu) return ctx.skip();
    const looks = [zero, { ...zero, dustErode: 1 }, { ...zero, dustSkirt: 1 }];
    const young: Shape = await call('dustShape', looks, 12), mid: Shape = await call('dustShape', looks, 45);
    for (const r of [young, mid]) expect(r.error).toBeNull();
    // Roughness: outline pixels over the root of the area (a disc's is about 2 sqrt(pi), 3.5).
    const rough = (g: Region) => g.outline / Math.sqrt(g.area);
    // Measured on SwiftShader (air burst, 0.2 / 0.75 s): plain 3.39 / 4.71, eroded 4.43 / 5.87; areas 2365 / 10992 and 2206 / 9774.
    for (const r of [young, mid]) {
      const [plain, eroded] = r.looks;
      expect(rough(eroded!.air)).toBeGreaterThan(1.15 * rough(plain!.air));
      expect(eroded!.air.area).toBeLessThan(plain!.air.area);
    }
    // The skirt: soil from the flat landing spreads low (bounding box height over width 0.28 against 0.58 at 0.75 s);
    // the burst in the air (not from the ground) keeps its shape exactly.
    expect(mid.looks[2]!.ground.aspect).toBeLessThan(0.7 * mid.looks[0]!.ground.aspect);
    expect(young.looks[2]!.air.sum).toBe(young.looks[0]!.air.sum);
  }, 240_000); // two runs of four renderers

  it('thinning keeps a young puff dense and makes a grown one faint', async (ctx) => {
    if (!gpu) return ctx.skip();
    const looks = [zero, { ...zero, dustThin: 1 }];
    const young: Shape = await call('dustShape', looks, 12), old: Shape = await call('dustShape', looks, 100);
    for (const r of [young, old]) expect(r.error).toBeNull();
    // Normalised at half grown: denser while small (0.2 s), fainter grown (1.7 s).
    expect(young.looks[1]!.air.sum).toBeGreaterThan(1.5 * young.looks[0]!.air.sum);
    expect(old.looks[1]!.air.sum).toBeLessThan(0.8 * old.looks[0]!.air.sum);
  }, 240_000); // two runs of three renderers
});

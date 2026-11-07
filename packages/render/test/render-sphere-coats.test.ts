// Coats on spheres (PT26: Rube Lab's bell is a sphere, and spheres ignored coats, so the bell drew the ball's grey):
// a gilt sphere reads gold and a glaze one teal in every look, a painted one its tint, an uncoated one neither; and
// a flash (a rung bell, game rube-view.ts BELL_FLASH) lights the gilt sphere at its start and is gone at its end,
// keeping the coat. Drawn at fixed renderer times in headless Chromium (SwiftShader without a GPU). Correctness only.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { COAT_GILT, COAT_GLAZE, COAT_NONE, COAT_PAINT } from '../src/index.ts';
import type * as Drivers from './sphere-coats-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./sphere-coats-page.ts', import.meta.url)), '__spheres');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

const frames = (c: Parameters<typeof Drivers.sphereFrames>[0]) =>
  gpu!.page.evaluate((cc) => (window as unknown as { __spheres: typeof Drivers }).__spheres.sphereFrames(cc), c);

describe('coated spheres on the GPU', () => {
  it.for(['hazy', 'real', 'candy'] as const)('%s: gilt reads gold, glaze teal, painted its blue; uncoated is none of them', async (look, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look });
    expect(r.error).toBeNull();
    expect(r.coats).toEqual([COAT_GILT, COAT_GLAZE, COAT_PAINT, COAT_NONE]);
    const [gilt, glaze, paint, none] = r.frames[0]!, msg = JSON.stringify(r.frames[0]);
    expect(gilt!.n, msg).toBeGreaterThan(50);
    expect(gilt!.hue, msg).toBeGreaterThan(60); expect(gilt!.hue, msg).toBeLessThan(100); expect(gilt!.chroma, msg).toBeGreaterThan(0.05);
    expect(glaze!.hue, msg).toBeGreaterThan(150); expect(glaze!.hue, msg).toBeLessThan(200); expect(glaze!.chroma, msg).toBeGreaterThan(0.04);
    expect(paint!.hue, msg).toBeGreaterThan(235); expect(paint!.hue, msg).toBeLessThan(290); expect(paint!.chroma, msg).toBeGreaterThan(0.05);
    // The uncoated sphere is the look's own (candy's palette, hazy's and real's stone): not as gold as the gilt one.
    expect(none!.chroma < 0.05 || Math.abs(none!.hue - gilt!.hue) > 20, msg).toBe(true);
  });

  it.for(['hazy', 'real'] as const)('%s: a rung bell\'s flash lights the gilt sphere at its start, is gone at its end, and keeps the gold', async (look, ctx) => {
    if (!gpu) return ctx.skip();
    // flashAt 3 s, fading over 1.6 s: a frame just after, half way, and after it is over.
    const r = await frames({ look, flash: { emissive: 1, flash: 1.6 }, times: [3.05, 3.8, 5] });
    expect(r.error).toBeNull();
    expect(r.coats[0]).toBe(COAT_GILT);
    const gilt = (k: number) => r.frames[k]![0]!, early = gilt(0), mid = gilt(1), late = gilt(2), msg = JSON.stringify({ early, mid, late });
    expect(early.L, msg).toBeGreaterThan(late.L + 0.1);
    expect(mid.L, msg).toBeGreaterThan(late.L);
    expect(early.L, msg).toBeGreaterThan(mid.L);
    for (const s of [early, late]) { expect(s.hue, msg).toBeGreaterThan(55); expect(s.hue, msg).toBeLessThan(105); }
    // The other spheres do not flash.
    expect(Math.abs(r.frames[0]![1]!.L - r.frames[2]![1]!.L), msg).toBeLessThan(0.01);
  });
});

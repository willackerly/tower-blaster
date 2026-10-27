// The hall tracer's WGSL against its CPU twin (hall.ts).
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './hall-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./hall-page.ts', import.meta.url)), '__hall');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

describe('hallTrace on the GPU', () => {
  it('agrees with hallTraceCpu on 20,000 random rays: surface, distance and normal', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpu.page.evaluate(() => (window as unknown as { __hall: typeof Drivers }).__hall.hallTwins(5, 20000));
    expect(r.error).toBeNull();
    expect(r.matMismatch, JSON.stringify(r.examples)).toBe(0);
    expect(r.edges).toBeLessThan(0.01 * r.n);
    expect(r.tErr).toBeLessThan(2e-5); // relative to 1 + t
    expect(r.nErr).toBeLessThan(2e-4);
    // Every kind of surface was hit.
    for (const m of [1, 2, 3, 4, 5, 6, 7]) expect(r.mats[m] ?? 0).toBeGreaterThan(0);
  });
});

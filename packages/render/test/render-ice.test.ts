// Ice (ice.ts, ice-pass.ts) in headless Chromium (SwiftShader without a GPU):
// the path WGSL against its CPU twin, and a block in front of a striped
// backdrop drawn opaque, as ice and hidden. Correctness only: timings from
// here are never performance results. ICE_SHOTS=<dir> writes the frames.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encodePng, loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import type * as Drivers from './ice-page.ts';

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./ice-page.ts', import.meta.url)), '__ice');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

type D = typeof Drivers;
function call<K extends keyof D>(name: K, ...args: Parameters<D[K]>): Promise<Awaited<ReturnType<D[K]>>> {
  return gpu!.page.evaluate(
    ([n, a]) => (window as unknown as { __ice: Record<string, (...x: unknown[]) => unknown> }).__ice[n as string]!(...(a as unknown[])),
    [name, args] as const,
  ) as Promise<Awaited<ReturnType<D[K]>>>;
}

function shots(name: string, r: Awaited<ReturnType<D['iceFrames']>>): void {
  const dir = process.env.ICE_SHOTS;
  if (!dir || !r.frames) return;
  const all = { A: r.frames.A, B: r.frames.B, C: r.frames.C, ...Object.fromEntries(r.frames.cracks.map((p, i) => [`crack${i}`, p])) };
  for (const [k, p] of Object.entries(all)) writeFileSync(`${dir}/${name}-${k}.png`, encodePng(r.W, r.H, p));
}

describe('ice path on the GPU', () => {
  it('icePath (ICE_PATH_WGSL) agrees with its CPU twin: same branch, length, direction and transmitted share', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('iceTwins', 5);
    expect(r.error).toBeNull();
    // Rays within f32 of an edge or the critical angle may branch the other way: measured 0 of 4096 on SwiftShader.
    expect(r.branch).toBeLessThan(0.005 * r.n);
    expect(r.escaped).toBeGreaterThan(0.5 * r.n);
    expect(r.bounced).toBeGreaterThan(0.1 * r.n);
    // f32 over up to four legs; measured on SwiftShader: 2.7e-4 (length, relative), see the result.
    expect(r.lenErr, JSON.stringify(r)).toBeLessThan(2e-3);
    expect(r.dirErr, JSON.stringify(r)).toBeLessThan(2e-3);
    expect(r.tErr, JSON.stringify(r)).toBeLessThan(2e-3);
  });
});

describe('an ice block', () => {
  const keep = !!process.env.ICE_SHOTS;
  for (const look of ['candy', 'real'] as const) {
    it(`${look}: shows the stripes behind it, bent and tinted blue, and no surface set is bit-identical to the default surface`, async (ctx) => {
      if (!gpu) return ctx.skip();
      const r = await call('iceFrames', { look, keep, ...(keep ? { size: [480, 288] as [number, number] } : {}) });
      shots(`ice-${look}`, r);
      expect(r.error).toBeNull();
      expect(r.pixels).toBeGreaterThan(500);
      // No ice: one pass, exactly the frame before any surface was set.
      expect(r.defaultSet).toBe(r.noSurface);
      expect(r.iceCount).toBe(1);
      // IDs include the ice block (drawn in its own list).
      expect(r.iceIds).toBe(r.pixels);
      const { frames: _, ...summary } = r;
      const msg = JSON.stringify(summary);
      // See-through: swap the backdrop's stripes and the ice's pixels change with them (the opaque block's do not).
      // Measured on SwiftShader (green): candy 0.39, real 0.33 of the backdrop's own change; opaque 0.
      expect(r.throughIce[1], msg).toBeGreaterThan(0.2);
      expect(r.throughOpaque[1], msg).toBeLessThan(0.02);
      // Bent, not a hole: the ice's pixels are not the backdrop's pixels (refraction moves the stripes).
      expect(r.diffBC, msg).toBeGreaterThan(3);
      // Absorption tints it blue: bluer than the same ice with none (red is absorbed most).
      expect(r.rgbB[2]! / r.rgbB[0]!, msg).toBeGreaterThan(1.03 * (r.rgbClear[2]! / r.rgbClear[0]!));
      expect(r.rgbB[0]!, msg).toBeLessThan(r.rgbClear[0]!);
    }, 180_000);
  }

  it('turned to show three faces, a crack grows with its level, only on the block', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('iceFrames', { look: 'real', turned: true, cracks: [1, 4, 7], keep, ...(keep ? { size: [480, 288] as [number, number] } : {}) });
    shots('ice-cracks', r);
    expect(r.error).toBeNull();
    const [c1, c4, c7] = r.crackDiff as [number, number, number];
    expect(c1).toBeGreaterThan(0.2);
    expect(c4).toBeGreaterThan(1.5 * c1);
    expect(c7).toBeGreaterThan(1.2 * c4);
    // Off the block nothing changes but what the block shows behind it... nothing at all, the block's surroundings are the same frame.
    for (const o of r.crackOutside) expect(o).toBeLessThan(0.05);
  }, 180_000);

  it('the effects after the ice pass still draw (a blast behind the block)', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('iceFrames', { look: 'candy', blast: true });
    expect(r.error).toBeNull();
    expect(r.blastDiff).toBeGreaterThan(0.5);
  }, 180_000);
});

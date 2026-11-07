// The sleep debug tint (Renderer.toggles.sleepTint, looks.ts LOOK_ASLEEP): with it on, bodies asleep draw
// with a cold blue cast and the others exactly as before; with it off, sleeping draws as awake. Headless
// Chromium (SwiftShader without a GPU). Correctness only.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { LOOK_ASLEEP, lookOf, MATERIAL, unpackLook } from '../src/index.ts';
import type * as Drivers from './sleep-page.ts';

describe('the asleep bit (CPU)', () => {
  it('sits above every material in the material nibble, and lookOf never sets it', () => {
    expect(LOOK_ASLEEP).toBe(1 << 15);
    for (const m of Object.values(MATERIAL)) expect(m).toBeLessThan(8);
    for (const tag of [0, 3, -1, -2]) for (const slot of [0, 1, 77, 65535]) {
      const look = lookOf({ shape: { kind: 'box', half: [1, 1, 1] }, pos: [0, slot % 7, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 1, friction: 0.5, restitution: 0, tag }, slot, { minY: 0, maxY: 6 });
      expect(look & LOOK_ASLEEP).toBe(0);
      expect(unpackLook(look | LOOK_ASLEEP).material & 7).toBe(unpackLook(look).material);
    }
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./sleep-page.ts', import.meta.url)), '__sleep');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

const ASLEEP = [false, true, false, true, true, false];
const blueShare = (c: number[]) => c[2]! / Math.max(1, c[0]! + c[1]! + c[2]!);
const near = (a: number[], b: number[], tol: number) => a.every((v, k) => Math.abs(v - b[k]!) <= tol);

describe('sleepers on the GPU', () => {
  it.for(['candy', 'hazy', 'real'] as const)('%s: sleepers (cubes and a ball) turn blue with the tint on; awake bodies, and everything with it off, draw as before', async (look, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpu.page.evaluate((l) => (window as unknown as { __sleep: typeof Drivers }).__sleep.sleepFrames(l), look);
    expect(r.error).toBeNull();
    const msg = JSON.stringify(r);
    ASLEEP.forEach((asleep, i) => {
      // Lit: the patch is on the body, not the sky behind it.
      expect(r.off[i]!.reduce((s, v) => s + v, 0), msg).toBeGreaterThan(30);
      // Every body awake with the tint on draws as the mixed frame with it off: sleeping alone changes nothing.
      expect(near(r.allAwake[i]!, r.off[i]!, 1), `${i} ${msg}`).toBe(true);
      if (asleep) {
        // Clearly bluer, and darker in red.
        expect(blueShare(r.on[i]!) - blueShare(r.off[i]!), `${i} ${msg}`).toBeGreaterThan(0.12);
        expect(r.on[i]![0], `${i} ${msg}`).toBeLessThan(0.8 * r.off[i]![0]!);
      } else {
        expect(near(r.on[i]!, r.off[i]!, 1), `${i} ${msg}`).toBe(true);
      }
    });
  });
});

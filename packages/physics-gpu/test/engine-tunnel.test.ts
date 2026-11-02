// Tunnelling (tunnel-case.ts): the GPU engine and the f64 reference never let a
// small fast ball or a blast-kicked block through a thin slab under the sweep
// limit (60 m/s at 60 Hz), and the case does see tunnels past it. This is the
// engine guarantee Keystone's validator checks GPU levels against (level.ts
// tunnelling rule), in place of the size-based rule Rapier's boxes need.
import { describe, expect, it } from 'vitest';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { TUNNEL_SPEEDS, tunnelCase, tunnelCounts } from './tunnel-case.ts';
import { gpu, runGpu } from './harness.ts';

const SWEEP_LIMIT = 60;
const ITERATIONS = 40; // Keystone's (AVBD_ITERATIONS)

const check = (counts: Map<string, number>) => {
  for (const [key, n] of counts) {
    const speed = Number(key.split(' ')[2]);
    if (speed < SWEEP_LIMIT) expect(n, key).toBe(0);
  }
  // Past the limit the case sees tunnels: the detector works, and the limit is real.
  const past = [...counts].filter(([k]) => Number(k.split(' ')[2]) > SWEEP_LIMIT).reduce((a, [, n]) => a + n, 0);
  expect(past).toBeGreaterThan(0);
  expect(TUNNEL_SPEEDS.some((v) => v > SWEEP_LIMIT)).toBe(true);
};

describe('tunnelling: thin slabs against the sweep limit', () => {
  it('reference: nothing under 60 m/s gets through a 2 cm or 12.5 cm slab; past it some do', async () => {
    const c = tunnelCase(), e = new AvbdReferenceEngine({ iterations: ITERATIONS });
    await e.init(c.scene);
    const snaps = [];
    for (let i = 0; i < c.steps; i++) { e.step(); snaps.push(e.snapshot()); }
    const counts = tunnelCounts(c, snaps);
    console.log('tunnel ref', JSON.stringify([...counts]));
    check(counts);
  });

  it('GPU: the same', async (ctx) => {
    if (!gpu) return ctx.skip();
    const c = tunnelCase();
    const g = await runGpu(c.scene, c.steps, { iterations: ITERATIONS }, 1);
    const counts = tunnelCounts(c, g.all);
    console.log('tunnel gpu', JSON.stringify([...counts]));
    check(counts);
  }, 120_000);
});

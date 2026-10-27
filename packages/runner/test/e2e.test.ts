// The whole browser path: Vite with isolation headers, the runner page,
// Playwright, and the result record coming back.
import { describe, expect, it } from 'vitest';
import { openWebGPU } from '@tb/testkit';
import { parseConfig, runInBrowser } from '../src/orchestrate-entry.ts';

const tiny = '?scenario=S1&param.F=2&param.H=3&sleep=false&warmup=5&blockSteps=10&blocks=4';

describe('runner page end to end', () => {
  it('runs a timed benchmark in an isolated page with a fine timer', async () => {
    const r = await runInBrowser(parseConfig(tiny));
    const env = (r.env as { browser: { crossOriginIsolated: boolean; timerResolutionMs: number } }).browser;
    expect(r.kind).toBe('run');
    expect(env.crossOriginIsolated).toBe(true);
    expect(env.timerResolutionMs).toBeLessThanOrEqual(0.02);
    expect(r.timingValid).toBe(true);
    const t = (r.timing as Array<{ blocks: number; stepsPerBlock: number }>)[0]!;
    expect([t.blocks, t.stepsPerBlock]).toEqual([4, 10]);
    // The window the blocks timed (steps 6-45), which bench:probe-compare judges by.
    expect(r.warmup).toBe(5);
  });

  it('compares two engines and runs a quality pass', async () => {
    const r = await runInBrowser(parseConfig(`${tiny}&engines=rapier,rapier:iterations=8&qualitySteps=30`));
    expect(r.kind).toBe('compare');
    expect(r.comparison).toHaveProperty('verdict');
    expect((r.quality as { gates: Record<string, string | null> }).gates.finite).toBeNull();
  });

  it('times the GPU engine in latency and throughput modes', async (ctx) => {
    const probe = await openWebGPU();
    if (!probe) return ctx.skip();
    await probe.close();
    for (const mode of ['latency', 'throughput'] as const) {
      const r = await runInBrowser(parseConfig(`${tiny}&engines=avbd-gpu:iterations=4&timingMode=${mode}`));
      const t = (r.timing as Array<{ mode: string; blocks: number; stepsPerBlock: number; blockMedians: number[] }>)[0]!;
      expect([t.mode, t.blocks, t.stepsPerBlock]).toEqual([mode, 4, 10]);
      expect(t.blockMedians.every((m) => Number.isFinite(m) && m > 0)).toBe(true);
      expect((r.engines as Array<{ name: string; backend: string }>)[0]).toMatchObject({ name: 'avbd-gpu', backend: expect.stringMatching(/^webgpu/) });
      // SwiftShader runs it, but its timings are never results.
      const gpu = (r.env as { browser: { gpu: { software: boolean } } }).browser.gpu;
      expect(r.timingValid).toBe(!gpu.software);
    }
  });
});

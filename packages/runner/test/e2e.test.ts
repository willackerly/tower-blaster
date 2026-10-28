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
    // Rapier reports no limits (no health()).
    expect([r.health, r.limitProblems, (r.quality as { health: unknown }).health]).toEqual([[null, null], [], null]);
  });

  it('carries --bounce from the URL into the run, and the record says so', async () => {
    const r = await runInBrowser(parseConfig(`${tiny}&engines=avbd-ref:restitution=true&bounce=0.5`));
    expect(r.scene).toMatchObject({ id: 'S1', bounce: 0.5 });
    expect((r.engines as Array<{ variant: Record<string, unknown> }>)[0]!.variant).toMatchObject({ restitution: true });
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

  it('records the GPU engine\'s limits over every step, and names a pair buffer too small for the scene', async (ctx) => {
    const probe = await openWebGPU();
    if (!probe) return ctx.skip();
    await probe.close();
    // 12 touching cubes have more pairs than 1 per body: every step drops some, in the timing and the quality run.
    const small = 'avbd-gpu:iterations=4,pairsPerBody=1';
    const r = await runInBrowser(parseConfig(`${tiny}&engines=${small},avbd-gpu:iterations=4&qualitySteps=20`));
    expect(r.engines).toHaveLength(2);
    type Health = { steps: number; limits: Array<{ id: string; steps: number; peak: number; room: number; fix?: { option: string; value: number } }> };
    const [h0, h1] = r.health as [Health, Health];
    expect([h0.steps, h1.steps]).toEqual([45, 45]); // warmup 5 + 4 blocks of 10
    expect(h0.limits[0]).toMatchObject({ id: 'pairs', steps: 45, room: 12, fix: { option: 'pairsPerBody' } });
    expect(h0.limits[0]!.peak).toBeGreaterThan(12);
    expect(h1.limits[0]).toMatchObject({ id: 'pairs', steps: 0, room: 12 * 16 });
    expect(h1.limits[0]!.fix).toBeUndefined();
    expect((r.quality as { health: Health }).health).toMatchObject({ steps: 20, limits: [{ id: 'pairs', steps: 20 }] });
    const problems = r.limitProblems as string[];
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(new RegExp(`^engine 0 \\(${small}\\): contacts dropped on 45 of 45 steps: .*; pairsPerBody=\\d+ gives room`));
    expect(problems[1]).toMatch(new RegExp(`^quality run \\(${small}\\): contacts dropped on 20 of 20 steps`));
  });
});

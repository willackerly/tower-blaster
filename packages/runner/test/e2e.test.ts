// The whole browser path: Vite with isolation headers, the runner page,
// Playwright, and the result record coming back.
import { describe, expect, it } from 'vitest';
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
  });

  it('compares two engines and runs a quality pass', async () => {
    const r = await runInBrowser(parseConfig(`${tiny}&engines=rapier,rapier:iterations=8&qualitySteps=30`));
    expect(r.kind).toBe('compare');
    expect(r.comparison).toHaveProperty('verdict');
    expect((r.quality as { gates: Record<string, string | null> }).gates.finite).toBeNull();
  });
});

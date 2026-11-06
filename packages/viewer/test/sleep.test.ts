// GPU per-body sleep in the viewer (roadmap E2.5): sleep=1 turns the GPU engine's own sleep on for the
// sandbox's scenes, and the sleep tint (keystone.sleeptint, the Scene panel) works under both rules.
import { describe, expect, it } from 'vitest';
import { makeEngine, parseSpec } from '@tb/bench';
import { DEFAULT_CONFIG, engineSpec, parseViewerConfig, proposeScene, scenarioEngineSpec, sleepEngineSpec, toSearch, worldEngineSpec } from '../src/index.ts';

describe('the viewer\'s sleep switch reaches the GPU engine', () => {
  it('sleep=1 adds sleep=true to an avbd-gpu spec that leaves it unsaid; nothing else changes', () => {
    expect(sleepEngineSpec('avbd-gpu', true)).toBe('avbd-gpu:sleep=true');
    expect(parseSpec(sleepEngineSpec('avbd-gpu:iterations=20', true)).options).toEqual({ iterations: 20, sleep: true });
    // Absent or off: the spec as given (GPU sleep is opt-in, as the benches ran it).
    for (const s of [null, false]) expect(sleepEngineSpec('avbd-gpu', s)).toBe('avbd-gpu');
    // The spec's own sleep option wins, either way.
    expect(sleepEngineSpec('avbd-gpu:sleep=false', true)).toBe('avbd-gpu:sleep=false');
    // Not with Bounce (the engine refuses sleep with restitution), and not on other engines.
    expect(sleepEngineSpec('avbd-gpu:restitution=true', true)).toBe('avbd-gpu:restitution=true');
    for (const e of ['rapier', 'avbd-ref', 'tiered']) expect(sleepEngineSpec(e, true)).toBe(e);
  });
  it('the engine the viewer builds for ?sleep=1 has sleep in its variant (no device needed to build it)', () => {
    const build = (u: string) => {
      const c = parseViewerConfig(u);
      return makeEngine(worldEngineSpec(engineSpec(sleepEngineSpec(scenarioEngineSpec(c.engine, c.scenario), c.sleep), c.projectile, c.scale), c.scale));
    };
    expect((build('?scenario=S4&engine=avbd-gpu&sleep=1').info.variant as Record<string, unknown>).sleep).toBe(true);
    expect((build('?scenario=S4&engine=avbd-gpu').info.variant as Record<string, unknown>).sleep).toBeUndefined();
  });
});

describe('the sleep tint in the viewer', () => {
  it('keystone.sleeptint=1 reads and round-trips in the sandbox as under the rules, and is off by default', () => {
    expect(DEFAULT_CONFIG.feel.sleepTint).toBe(false);
    const sandbox = parseViewerConfig('?scenario=S4&keystone.sleeptint=1');
    expect(sandbox.rules).toBe('sandbox');
    expect(sandbox.feel.sleepTint).toBe(true);
    expect(toSearch(sandbox)).toMatch(/keystone\.sleeptint=1/);
    expect(parseViewerConfig(toSearch(sandbox))).toEqual(sandbox);
    expect(parseViewerConfig('?level=L1&rules=keystone&keystone.sleeptint=1').feel.sleepTint).toBe(true);
  });
  it('the Scene panel keeps the tint when it applies a sandbox scene (whose pace juice it resets)', () => {
    const c = parseViewerConfig('?scenario=S4');
    const p = proposeScene(c, 'S3', {}, 1, c.scale, c.substeps, undefined, undefined, { rules: 'sandbox', feel: { ...c.feel, sleepTint: true, hitStop: true } });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.config.feel).toEqual({ ...DEFAULT_CONFIG.feel, sleepTint: true });
  });
});

// GPU per-body sleep in the viewer (roadmap E2.5): sleep=1 turns the GPU engine's own sleep on for the
// sandbox's scenes, and the sleep tint (keystone.sleeptint, the Scene panel) works under Keystone's rules.
import { describe, expect, it } from 'vitest';
import { makeEngine, parseSpec } from '@tb/bench';
import { DEFAULT_CONFIG, engineSpec, levelChoice, parseSceneFile, parseViewerConfig, proposeScene, sceneFile, scenarioEngineSpec, sleepEngineSpec, toSearch, worldEngineSpec } from '../src/index.ts';

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
  it('keystone.sleeptint=1 reads and round-trips under the rules (a scene file too), is off by default, and is the rules\' only', () => {
    expect(DEFAULT_CONFIG.feel.sleepTint).toBe(false);
    const c = parseViewerConfig('?level=L1&rules=keystone&keystone.sleeptint=1');
    expect(c.feel.sleepTint).toBe(true);
    expect(toSearch(c)).toMatch(/keystone\.sleeptint=1/);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(sceneFile(c, '', null).rules).toMatchObject({ sleeptint: true });
    expect(parseSceneFile(JSON.stringify(sceneFile(c, '', null))).config).toEqual(c);
    expect(() => parseViewerConfig('?scenario=S4&keystone.sleeptint=1')).toThrow(/keystone.sleeptint applies to rules=keystone/);
  });
  it('the Scene panel reads it like the other feel switches', () => {
    const c = parseViewerConfig('?level=L1&rules=keystone');
    const p = proposeScene(c, levelChoice('L1'), {}, 1, c.scale, c.substeps, undefined, undefined, { rules: 'keystone', feel: { ...c.feel, sleepTint: true } });
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.config.feel.sleepTint).toBe(true);
  });
});

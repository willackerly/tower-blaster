// Keystone levels as a viewer scene (level=L2): parsed, written, saved and
// built exactly as the game builds them (docs/design/viewer-superset.md, step B).
import { describe, expect, it } from 'vitest';
import { compileLevel, LEVELS, PRESETTLE_STEPS } from '@tb/keystone';
import { SCENARIOS } from '@tb/scenarios';
import {
  DEFAULT_CONFIG, defaultPresettle, levelChoice, levelDef, parseSceneFile, parseViewerConfig, presetSearch, proposeScene, sceneFile, sceneFileName, sceneTitle, toSearch, viewerScene, worldScene,
} from '../src/index.ts';

describe('levels in the viewer', () => {
  it('parses level=, in any case, with the level\'s defaults: scale 1 and the game\'s presettle', () => {
    const c = parseViewerConfig('?level=l2');
    expect(c.level).toBe('L2');
    expect(c.scale).toBe(1);
    expect(c.substeps).toBe(1);
    expect(c.presettle).toBe(PRESETTLE_STEPS);
    // The scenario fields stay at the defaults, for when the panel goes back to a scenario.
    expect([c.scenario, c.params, c.seed]).toEqual([DEFAULT_CONFIG.scenario, DEFAULT_CONFIG.params, DEFAULT_CONFIG.seed]);
    expect(parseViewerConfig('').level).toBeNull();
    expect(parseViewerConfig('').presettle).toBe(0);
  });

  it('round-trips through the URL, which names the level and no scenario, params or seed', () => {
    for (const u of ['?level=L1', '?level=L3&engine=rapier', '?level=L5&presettle=0&scale=0.5', '?level=L4&engine=avbd-gpu:restitution=true&bounce.e=0.3', '?level=L2&autofire=30&loop=frame&maxSteps=2']) {
      const c = parseViewerConfig(u);
      const s = toSearch(c);
      expect(parseViewerConfig(s), u).toEqual(c);
      expect(s).not.toMatch(/scenario=|param\.|seed=/);
    }
    // The default presettle stays out of the URL, a chosen one goes in.
    expect(toSearch(parseViewerConfig('?level=L1'))).not.toMatch(/presettle/);
    expect(toSearch(parseViewerConfig('?level=L1&presettle=60'))).toMatch(/presettle=60/);
    expect(toSearch(parseViewerConfig('?scenario=S1&presettle=60'))).toMatch(/presettle=60/);
  });

  it('refuses an unknown level, a level beside a scenario, params or a seed, and a bad presettle', () => {
    expect(() => parseViewerConfig('?level=L9')).toThrow(/unknown level L9; known: L1/);
    expect(() => parseViewerConfig('?level=L1&scenario=S4')).toThrow(/level takes no scenario/);
    expect(() => parseViewerConfig('?level=L1&param.N=4')).toThrow(/level takes no scenario/);
    expect(() => parseViewerConfig('?level=L1&seed=2')).toThrow(/level takes no scenario/);
    for (const p of ['-1', '1.5', 'x', '100000']) expect(() => parseViewerConfig(`?level=L1&presettle=${p}`)).toThrow(/presettle must be a whole number/);
  });

  it('builds the scene the game compiles, body for body, and puts it in the world as a scenario is', () => {
    for (const def of LEVELS) {
      const c = parseViewerConfig(`?level=${def.id}`);
      expect(viewerScene(c)).toEqual(compileLevel(def).scene);
      // Keystone's own rules come with it: min friction, sleep on.
      expect(viewerScene(c).frictionCombine).toBe('min');
    }
    const c = parseViewerConfig('?level=L2&scale=0.25');
    expect(viewerScene(c)).toEqual(worldScene(compileLevel(levelDef('L2')!).scene, 0.25, 2));
    expect(viewerScene(parseViewerConfig('?level=L2&sleep=0')).sleep).toBe(false);
  });

  it('a preset from a level goes to the preset\'s scenario, with its own presettle', () => {
    const c = parseViewerConfig('?level=L2&engine=rapier');
    const next = parseViewerConfig(presetSearch('?scenario=S3', c));
    expect(next.level).toBeNull();
    expect(next.scenario).toBe('S3');
    expect(next.engine).toBe('rapier');
    expect(next.presettle).toBe(0);
  });

  it('titles the HUD with the level', () => {
    expect(sceneTitle(parseViewerConfig('?level=L2'))).toBe(`L2 ${levelDef('L2')!.name}`);
    expect(sceneTitle(parseViewerConfig('?scenario=S3'))).toBe(SCENARIOS.S3!.title);
  });

  it('the panel proposes a level with its body count and the game\'s presettle, and back to a scenario', () => {
    const c = parseViewerConfig('?scenario=S1');
    const p = proposeScene(c, levelChoice('L2'), {}, 1);
    expect(p).toMatchObject({ ok: true, bodies: compileLevel(levelDef('L2')!).scene.bodies.length });
    if (!p.ok) return;
    expect(p.config.level).toBe('L2');
    expect(p.config.presettle).toBe(defaultPresettle('L2'));
    expect(p.config.scenario).toBe('S1');
    const back = proposeScene(p.config, 'S1', { ...SCENARIOS.S1!.defaults }, 1, 1, 1, undefined, 0);
    expect(back).toMatchObject({ ok: true, config: { level: null, scenario: 'S1', presettle: 0 } });
    expect(proposeScene(c, levelChoice('L2'), {}, 1, 1, 1, undefined, -3)).toMatchObject({ ok: false, error: /settle steps/ });
    expect(proposeScene(c, levelChoice('L7'), {}, 1)).toMatchObject({ ok: false, error: /unknown level L7/ });
  });

  it('saves a level as scene.level with no scenario, params or seed, and loads it back', () => {
    const at = new Date(2026, 9, 28, 3, 4);
    for (const u of ['?level=L1', '?level=L4&presettle=0&engine=avbd-gpu:iterations=40,gapSlop=0.00003', '?level=L2&scale=0.5&sleep=0']) {
      const c = parseViewerConfig(u);
      const f = sceneFile(c, '', null, at);
      expect(f.scene).toEqual({ level: c.level, sleep: c.sleep, scale: c.scale, bounce: c.bounce });
      expect(f.loop.presettle).toBe(c.presettle);
      expect(parseSceneFile(JSON.stringify(f)).config, u).toEqual(c);
    }
    // A file without presettle (written before it) gets the scene's default.
    const f = sceneFile(parseViewerConfig('?level=L3'), '', null, at) as unknown as { loop: Record<string, unknown> };
    delete f.loop.presettle;
    expect(parseSceneFile(JSON.stringify(f)).config.presettle).toBe(PRESETTLE_STEPS);
    expect(sceneFileName('', 'L3', at)).toBe('L3-20261028-0304.json');
  });

  it('refuses a level file with a scenario beside it or an unknown level', () => {
    const f = sceneFile(parseViewerConfig('?level=L1'), '', null, new Date()) as unknown as { scene: Record<string, unknown> };
    expect(() => parseSceneFile(JSON.stringify({ ...f, scene: { ...f.scene, scenario: 'S4' } }))).toThrow(/scene \(a level\): unknown key scenario/);
    expect(() => parseSceneFile(JSON.stringify({ ...f, scene: { ...f.scene, level: 'L8' } }))).toThrow(/unknown level L8/);
    expect(() => parseSceneFile(JSON.stringify({ ...f, scene: { ...f.scene, level: 3 } }))).toThrow(/scene.level must be a string/);
  });
});

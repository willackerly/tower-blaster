// Keystone's rules in the viewer (rules=keystone): parsed, written, saved and
// proposed by the panel, always as the game plays the level
// (docs/design/viewer-superset.md, step C).
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, L2, PRESETTLE_STEPS, scenarioLevel } from '@tb/keystone';
import {
  CUSTOM_LEVEL, DEFAULT_CONFIG, encodeLevelParam, keystoneEngine, levelChoice, levelOf, sceneTitle, parseSceneFile, parseViewerConfig, presetSearch, proposeScene, sceneFile, toSearch, underKeystone, withCustomLevel,
} from '../src/index.ts';

const feelOff = { hitStop: false, slowMo: false };

describe('Keystone rules in the viewer', () => {
  it('parses rules=keystone on a level, with the game\'s pace juice off unless asked for, and round-trips', () => {
    const c = parseViewerConfig('?level=L2&rules=keystone');
    expect(c).toMatchObject({ rules: 'keystone', feel: feelOff, level: 'L2', presettle: PRESETTLE_STEPS, scale: 1, substeps: 1, engine: 'avbd-gpu' });
    expect(parseViewerConfig('').rules).toBe('sandbox');
    expect(parseViewerConfig('?level=L2').rules).toBe('sandbox');
    for (const u of ['?level=L1&rules=keystone', '?level=L3&rules=keystone&engine=rapier', '?level=L4&rules=keystone&keystone.hitstop=1', '?level=L5&rules=keystone&keystone.slowmo=1&keystone.hitstop=1&look=real&proj=cube', `?level.def=${encodeLevelParam({ ...L2, id: 'mine' })}&rules=keystone`]) {
      const p = parseViewerConfig(u);
      expect(parseViewerConfig(toSearch(p)), u).toEqual(p);
    }
    expect(parseViewerConfig('?level=L4&rules=keystone&keystone.hitstop=1&keystone.slowmo=0').feel).toEqual({ hitStop: true, slowMo: false });
    expect(toSearch(parseViewerConfig('?level=L1&rules=keystone&keystone.slowmo=0'))).toBe('?level=L1&engine=avbd-gpu&rules=keystone');
  });

  it('plays only on the game\'s engines, with no options', () => {
    expect(keystoneEngine('avbd-gpu')).toBe('gpu');
    expect(keystoneEngine('rapier')).toBe('rapier');
    for (const e of ['avbd-ref', 'tiered', 'avbd-gpu:iterations=20', 'rapier:iterations=8']) {
      expect(() => parseViewerConfig(`?level=L1&rules=keystone&engine=${e}`), e).toThrow(/rules=keystone plays on the game's engines.*not /);
    }
  });

  it('refuses keys that change the level\'s physics or stepping, and juice keys without the rules', () => {
    expect(() => parseViewerConfig('?level=L1&rules=golf')).toThrow(/rules must be sandbox or keystone: golf/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&scale=0.5&presettle=0&loop=frame')).toThrow(/so scale, substeps, presettle, loop must be left at the level's default/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&autofire=10&sleep=0')).toThrow(/so sleep, autofire must be/);
    // A key at the level's default is no change.
    expect(parseViewerConfig('?level=L1&rules=keystone&scale=1&presettle=300&substeps=1').rules).toBe('keystone');
    expect(() => parseViewerConfig('?level=L1&keystone.hitstop=1')).toThrow(/keystone.hitstop applies to rules=keystone/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&keystone.slowmo=yes')).toThrow(/keystone.slowmo must be 0 or 1: yes/);
  });

  it('a saved scene carries the rules and the juice, and a sandbox scene has no rules key', () => {
    const c = parseViewerConfig('?level=L3&rules=keystone&engine=rapier&keystone.slowmo=1');
    const f = sceneFile(c, '', null, new Date(2026, 9, 28));
    expect(f.rules).toEqual({ mode: 'keystone', hitstop: false, slowmo: true });
    expect(parseSceneFile(JSON.stringify(f)).config).toEqual(c);
    expect(sceneFile(parseViewerConfig('?level=L3'), '', null).rules).toBeUndefined();
    expect(() => parseSceneFile(JSON.stringify({ ...f, rules: { ...f.rules, juice: true } }))).toThrow(/rules: unknown key juice/);
    expect(() => parseSceneFile(JSON.stringify({ ...f, rules: { mode: 'keystone' }, loop: { ...f.loop, substeps: 2 } }))).toThrow(/so substeps must be left/);
  });

  it('the panel puts a level under the rules as the game plays it, and anything else back in the sandbox', () => {
    // From a sandbox level at another scale and settle, on a tuned GPU spec: the game's world and engine.
    const c = parseViewerConfig('?level=L2&scale=0.5&presettle=10&engine=avbd-gpu:iterations=20&autofire=30');
    const p = proposeScene(c, levelChoice('L2'), {}, 1, 0.5, 2, undefined, 10, { rules: 'keystone', feel: { hitStop: true, slowMo: false } });
    expect(p).toMatchObject({ ok: true, config: { rules: 'keystone', feel: { hitStop: true, slowMo: false }, engine: 'avbd-gpu', scale: 1, substeps: 1, presettle: PRESETTLE_STEPS, autofire: 0 } });
    if (!p.ok) return;
    expect(parseViewerConfig(toSearch(p.config))).toEqual(p.config);
    // Another level keeps the rules; so does a scenario, as a level (scenarioLevel); the sandbox's rules drop them.
    expect(proposeScene(p.config, levelChoice('L4'), {}, 1)).toMatchObject({ ok: true, config: { level: 'L4', rules: 'keystone', feel: { hitStop: true } } });
    expect(proposeScene(p.config, 'S3', { W: 10, H: 5 }, 2)).toMatchObject({ ok: true, bodies: 50, config: { level: null, scenario: 'S3', params: { W: 10, H: 5 }, seed: 2, rules: 'keystone', feel: { hitStop: true } } });
    expect(proposeScene(p.config, 'S3', { W: 10, H: 5 }, 1.5)).toMatchObject({ ok: false, error: /seed must be an integer/ });
    expect(proposeScene(p.config, 'S1', {}, 1, 1, 1, undefined, 0, { rules: 'sandbox', feel: feelOff })).toMatchObject({ ok: true, config: { level: null, rules: 'sandbox', feel: feelOff } });
    // A level of your own plays by them too; an engine the game has no counterpart of cannot.
    const mine = withCustomLevel(p.config, { ...L2, id: 'mine' });
    expect(proposeScene(mine, CUSTOM_LEVEL, {}, 1)).toMatchObject({ ok: true, config: { level: 'mine', rules: 'keystone' } });
    expect(proposeScene({ ...c, engine: 'avbd-ref' }, levelChoice('L2'), {}, 1, 1, 1, undefined, undefined, { rules: 'keystone', feel: feelOff })).toMatchObject({ ok: false, error: /game's engines/ });
    expect(underKeystone({ ...DEFAULT_CONFIG }, feelOff)).toMatchObject({ level: null, scenario: 'S4', rules: 'keystone' });
    // A preset button goes to its scenario in the sandbox.
    expect(parseViewerConfig(presetSearch('?scenario=S3', p.config)).rules).toBe('sandbox');
  });

  it('a scenario under the rules is an outcome level (scenarioLevel), at the game\'s world, and round-trips', () => {
    const u = '?scenario=S4&param.N=10000&param.F=6&param.H=20&rules=keystone&offscreen=1';
    const c = parseViewerConfig(u);
    expect(c).toMatchObject({ rules: 'keystone', level: null, scenario: 'S4', scale: 1, substeps: 1, presettle: PRESETTLE_STEPS, engine: 'avbd-gpu' });
    expect(levelOf(c)).toEqual(scenarioLevel('S4', { N: 10000, F: 6, H: 20 }, 1));
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(toSearch(c)).not.toMatch(/scale|presettle/);
    expect(sceneTitle(c)).toBe('S4 City of towers');
    // A scenario in the sandbox is no level, and keeps its own scale and settle.
    expect(levelOf(parseViewerConfig('?scenario=S4'))).toBeNull();
    // Under the rules the scale and settle are the level's: another value is refused, as for a level.
    expect(() => parseViewerConfig('?scenario=S15&rules=keystone&scale=0.117')).toThrow(/scale.*must be left at the level's default/);
  });

  it('the game\'s rule overrides (keystone.*) make a custom run, round-trip, and need the rules', () => {
    const u = '?level=L1&rules=keystone&keystone.scoring=outcome&keystone.autobank=0&keystone.iterations=20&keystone.bounce=0.4&keystone.gapSlop=0';
    const c = parseViewerConfig(u);
    expect(c.keystone).toEqual({ scoring: 'outcome', autobank: false, physics: { iterations: 20, bounce: 0.4, gapSlop: 0 } });
    expect(levelOf(c)).toEqual({ ...L1, custom: true, scoring: 'outcome', autobank: false, physics: { iterations: 20, bounce: 0.4, gapSlop: 0 } });
    expect(sceneTitle(c)).toMatch(/\(custom\)$/);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(parseViewerConfig(toSearch(parseViewerConfig('?level=L1&rules=keystone&keystone.bounce=off'))).keystone).toEqual({ physics: { bounce: null } });
    expect(parseViewerConfig('?level=L1&rules=keystone').keystone).toEqual({});
    expect(levelOf(parseViewerConfig('?level=L1&rules=keystone'))).toBe(L1);
    expect(levelOf(parseViewerConfig('?scenario=S3&rules=keystone&keystone.iterations=20'))).toMatchObject({ id: 'S3', custom: true, physics: { iterations: 20 } });
    expect(() => parseViewerConfig('?level=L1&keystone.iterations=20')).toThrow(/keystone.iterations applies to rules=keystone/);
    // A saved scene carries them, and a scenario under the rules, as the URL does.
    expect(parseSceneFile(JSON.stringify(sceneFile(c, '', null))).config).toEqual(c);
    // (A scene file writes every param out, the defaults too: the same level, by its hash.)
    const sc = parseViewerConfig('?scenario=S3&param.W=12&param.H=6&seed=4&rules=keystone&keystone.bounce=off');
    const back = parseSceneFile(JSON.stringify(sceneFile(sc, '', null))).config;
    expect({ ...back, params: sc.params }).toEqual(sc);
    expect(compileLevel(levelOf(back)!).hash).toBe(compileLevel(levelOf(sc)!).hash);
    expect(sceneFile(c, '', null).rules).toMatchObject({ scoring: 'outcome', autobank: false, physics: { iterations: 20, bounce: 0.4, gapSlop: 0 } });
    expect(sceneFile(parseViewerConfig('?level=L1&rules=keystone'), '', null).rules).toEqual({ mode: 'keystone', hitstop: false, slowmo: false });
    const f = sceneFile(c, '', null);
    expect(() => parseSceneFile(JSON.stringify({ ...f, rules: { ...f.rules, physics: { substeps: 2 } } }))).toThrow(/rules.physics: unknown key substeps/);
    expect(() => parseSceneFile(JSON.stringify({ ...f, rules: { ...f.rules, physics: { iterations: 0 } } }))).toThrow(/keystone.iterations: must be a whole number/);
    expect(() => parseViewerConfig('?level=L1&rules=keystone&keystone.iterations=0')).toThrow(/keystone.iterations: must be a whole number from 1 to 200: 0/);
  });
});

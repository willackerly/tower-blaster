// Levels of your own: a LevelDef from JSON, the URL (level.def) or a saved
// scene (scene.levelDef), checked strictly, and run as the game compiles it.
import { describe, expect, it } from 'vitest';
import { compileLevel, L2, L4, LEVELS, type LevelDef, PRESETTLE_STEPS } from '@tb/keystone';
import {
  CUSTOM_LEVEL, decodeLevelParam, encodeLevelParam, LEVEL_FILE_FORMAT, levelChoice, levelIssues, levelJson, parseLevelDef, parseSceneFile, parseViewerConfig, proposeScene,
  sceneFile, sceneTitle, toSearch, viewerScene, withCustomLevel,
} from '../src/index.ts';

/** L2 made our own: another id, and a name with text beyond ASCII. */
const mine: LevelDef = { ...structuredClone(L2), id: 'my-lintel', name: 'Lintel, taller — ½ more' };

describe('level files', () => {
  it('reads back every built-in level from its JSON, field for field', () => {
    for (const def of LEVELS) {
      const text = levelJson(def);
      expect(JSON.parse(text).format).toBe(LEVEL_FILE_FORMAT);
      expect(parseLevelDef(JSON.parse(text))).toEqual(def);
      // The format line is optional in a hand-written file.
      expect(parseLevelDef(JSON.parse(JSON.stringify(def)))).toEqual(def);
    }
  });

  it('refuses what is not a level, saying where', () => {
    const bad = (edit: (d: Record<string, any>) => void) => {
      const d = structuredClone(L2) as Record<string, any>;
      edit(d);
      return () => parseLevelDef(d);
    };
    expect(bad((d) => { d.parst = d.parts; })).toThrow(/level: unknown key parst/);
    expect(bad((d) => { d.parts[0].material = 'cheese'; })).toThrow(/level.parts\[0\].material must be one of plaster/);
    expect(bad((d) => { d.parts[0].size = [2, 1.5, 2]; })).toThrow(/level.parts\[0\].size must be three whole numbers/);
    expect(bad((d) => { d.parts[2].half = [4, 0, 1]; })).toThrow(/level.parts\[2\].half must be three numbers above 0/);
    expect(bad((d) => { d.parts[2].size = [1, 1, 1]; })).toThrow(/level.parts\[2\]: unknown key size/);
    expect(bad((d) => { d.parts[3].role = 'king'; })).toThrow(/role must be one of plain, crown, heritage/);
    expect(bad((d) => { d.rack.push('nuke'); })).toThrow(/level.rack\[3\] must be one of marble/);
    expect(bad((d) => { d.solutions.par[0].power = 101; })).toThrow(/level.solutions.par\[0\]: shot.power = 101/);
    expect(bad((d) => { d.solutions.par[0].x = 1; })).toThrow(/solutions.par\[0\]: unknown key x/);
    expect(bad((d) => { d.objective = { kind: 'crowns', maxH: 3 }; })).toThrow(/objective: unknown key maxH/);
    expect(bad((d) => { d.lot.min = [1]; })).toThrow(/level.lot.min must be two numbers/);
    expect(bad((d) => { d.id = 'a b'; })).toThrow(/level.id must be 1 to 32/);
    expect(bad((d) => { d.launcher.radius = -1; })).toThrow(/launcher.radius must be above 0/);
    expect(bad((d) => { d.format = 'tower-blaster/viewer-scene'; })).toThrow(/format should be/);
    expect(() => parseLevelDef([])).toThrow(/level must be an object/);
  });

  it('a level with static issues still parses; levelIssues lists them, and none for the built-ins', () => {
    for (const def of LEVELS) expect(levelIssues(def)).toEqual([]);
    const overlapping: LevelDef = { ...structuredClone(L4), parts: [...L4.parts, { kind: 'block', at: [5.5, 0, -1.5], size: [1, 1, 1], material: 'plaster' }] };
    const issues = levelIssues(parseLevelDef(JSON.parse(levelJson(overlapping))));
    expect(Array.isArray(issues) && issues.map((i) => i.code)).toContain('overlap');
  });

  it('level.def carries a level in the URL, any text included, and the config round-trips', () => {
    expect(decodeLevelParam(encodeLevelParam(mine))).toEqual(mine);
    expect(encodeLevelParam(mine)).toMatch(/^[\w-]+$/);
    const c = parseViewerConfig(`?level.def=${encodeLevelParam(mine)}&engine=rapier`);
    expect(c.level).toBe('my-lintel');
    expect(c.customLevel).toEqual(mine);
    expect(c.presettle).toBe(PRESETTLE_STEPS);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    expect(toSearch(c)).not.toMatch(/[?&]level=/);
    expect(viewerScene(c)).toEqual(compileLevel(mine).scene);
    expect(sceneTitle(c)).toBe(`my-lintel ${mine.name} (custom)`);
    // A level of your own may reuse a built-in id: it is loaded in place of the built-in one.
    const l2 = parseViewerConfig(`?level.def=${encodeLevelParam({ ...mine, id: 'L2', parts: mine.parts.slice(0, 2) })}`);
    expect(viewerScene(l2).bodies.length).toBe(compileLevel({ ...L2, parts: L2.parts.slice(0, 2) }).scene.bodies.length);
  });

  it('refuses a broken level.def, and level beside level.def', () => {
    expect(() => parseViewerConfig('?level.def=%%%')).toThrow(/not base64url/);
    expect(() => parseViewerConfig(`?level.def=${btoa('{nope')}`)).toThrow(/level.def is not JSON/);
    expect(() => parseViewerConfig(`?level.def=${encodeLevelParam({ ...mine, par: 1.5 })}`)).toThrow(/level.def.par must be a whole number/);
    expect(() => parseViewerConfig(`?level=L1&level.def=${encodeLevelParam(mine)}`)).toThrow(/give one/);
    expect(() => parseViewerConfig(`?level.def=${encodeLevelParam(mine)}&scenario=S1`)).toThrow(/level takes no scenario/);
  });

  it('a saved scene holds the whole level as scene.levelDef and loads it back', () => {
    const c = parseViewerConfig(`?level.def=${encodeLevelParam(mine)}&presettle=20`);
    const f = sceneFile(c, '', null, new Date(2026, 9, 28));
    expect(f.scene).toEqual({ levelDef: mine, sleep: null, scale: 1, bounce: c.bounce });
    expect(parseSceneFile(JSON.stringify(f)).config).toEqual(c);
    const broken = { ...f, scene: { ...f.scene, levelDef: { ...mine, rack: ['nuke'] } } };
    expect(() => parseSceneFile(JSON.stringify(broken))).toThrow(/scene.levelDef.rack\[0\] must be one of/);
    expect(() => parseSceneFile(JSON.stringify({ ...f, scene: { ...f.scene, level: 'L2' } }))).toThrow(/scene \(a level of your own\): unknown key level/);
  });

  it('the panel loads a level of your own, keeps it in the picker, and a built-in pick or a scenario drops it', () => {
    const c = withCustomLevel(parseViewerConfig('?scenario=S1'), mine);
    expect(c).toMatchObject({ level: 'my-lintel', customLevel: mine, presettle: PRESETTLE_STEPS, camera: null });
    const again = proposeScene(c, CUSTOM_LEVEL, {}, 1);
    expect(again).toMatchObject({ ok: true, config: { level: 'my-lintel', customLevel: mine }, bodies: compileLevel(mine).scene.bodies.length });
    expect(proposeScene(c, levelChoice('L2'), {}, 1)).toMatchObject({ ok: true, config: { level: 'L2', customLevel: null } });
    expect(proposeScene(c, 'S1', {}, 1, 1, 1, undefined, 0)).toMatchObject({ ok: true, config: { level: null, customLevel: null } });
    expect(proposeScene(parseViewerConfig(''), CUSTOM_LEVEL, {}, 1)).toMatchObject({ ok: false, error: /no level of your own/ });
  });
});

// Levels of your own: a LevelDef from JSON, the URL (level.def) or a saved
// scene (scene.levelDef), checked strictly, and run as the game compiles it.
import { describe, expect, it } from 'vitest';
import { A1, AFTERSHOCK_LEVELS, BuildSession, compileLevel, L2, L4, LEVELS, type LevelDef, PRESETTLE_STEPS, retrofitCandidate, RL1, RUBE_LEVELS, U2, U3, UNDERCUT_LEVELS } from '@tb/keystone';
import {
  CUSTOM_LEVEL, decodeLevelParam, encodeLevelParam, LEVEL_FILE_FORMAT, levelChoice, levelIssues, levelJson, parseLevelDef, parseSceneFile, parseViewerConfig, proposeScene,
  sceneFile, sceneTitle, toSearch, viewerScene, withCustomLevel,
} from '../src/index.ts';

/** L2 made our own: another id, and a name with text beyond ASCII. */
const mine: LevelDef = { ...structuredClone(L2), id: 'my-lintel', name: 'Lintel, taller — ½ more' };

describe('level files', () => {
  it('reads back every built-in level from its JSON, field for field', () => {
    for (const def of [...LEVELS, ...UNDERCUT_LEVELS]) {
      const text = levelJson(def);
      expect(JSON.parse(text).format).toBe(LEVEL_FILE_FORMAT);
      expect(parseLevelDef(JSON.parse(text))).toEqual(def);
      // The format line is optional in a hand-written file.
      expect(parseLevelDef(JSON.parse(JSON.stringify(def)))).toEqual(def);
    }
  });

  it('reads back placed pieces, domino runs and a build block (C9), and refuses malformed ones', () => {
    const d: LevelDef = {
      ...structuredClone(L2), build: { budget: 12, pieces: ['cube', 'domino'], brush: true, material: 'stone' },
      parts: [
        ...structuredClone(L2.parts),
        { kind: 'piece', at: [6.12, 0.5, -1.5], half: [0.5, 0.5, 0.5], material: 'plaster', placed: true },
        { kind: 'piece', at: [7, 1, 2], half: [0.5, 1, 0.15], yaw: 33.5, material: 'stone', role: 'crown' },
        { kind: 'run', path: [[-6, -4], [-6, 4], [-4.5, 6]], pitch: 1.2, half: [0.5, 1, 0.15], material: 'plaster', omit: [1, 3], y: 0, placed: true },
      ],
    };
    expect(parseLevelDef(JSON.parse(levelJson(d)))).toEqual(d);
    expect(decodeLevelParam(encodeLevelParam(d))).toEqual(d);
    expect(compileLevel(parseLevelDef(JSON.parse(levelJson(d)))).hash).toBe(compileLevel(d).hash);
    const bad = (edit: (x: Record<string, any>) => void) => { const x = structuredClone(d) as Record<string, any>; edit(x); return () => parseLevelDef(x); };
    const n = L2.parts.length;
    expect(bad((x) => { x.parts[n].half = [0.5, 0, 0.5]; })).toThrow(`level.parts[${n}].half must be three numbers above 0`);
    expect(bad((x) => { x.parts[n].placed = false; })).toThrow(`level.parts[${n}].placed must be true when given`);
    expect(bad((x) => { x.parts[n].size = [1, 1, 1]; })).toThrow(/unknown key size/);
    expect(bad((x) => { x.parts[n + 2].path = []; })).toThrow(`level.parts[${n + 2}].path must have at least one point`);
    expect(bad((x) => { x.parts[n + 2].path[1] = [1, 2, 3]; })).toThrow(`level.parts[${n + 2}].path[1] must be two numbers (x, z)`);
    expect(bad((x) => { x.parts[n + 2].pitch = 0; })).toThrow(/pitch must be above 0/);
    expect(bad((x) => { x.parts[n + 2].omit = [0.5]; })).toThrow(/omit\[0\] must be a whole number/);
    expect(bad((x) => { x.build.budget = -1; })).toThrow('level.build.budget must be 0 or more');
    expect(bad((x) => { x.build.pieces = ['tank']; })).toThrow(/level.build.pieces\[0\] must be one of cube, domino/);
    expect(bad((x) => { x.build.colour = 'red'; })).toThrow(/level.build: unknown key colour/);
  });

  it('Rube Lab (M10): a level and its built parts list round-trip through JSON (pins, tilts, balls, the bell, charges)', () => {
    for (const def of RUBE_LEVELS) expect(parseLevelDef(JSON.parse(levelJson(def)))).toEqual(def);
    // Built as a player builds: a pier in the gap and a slab on shelf A, then saved and loaded.
    const s = new BuildSession(RL1), h = s.h;
    expect(s.place(s.ghost({ body: -1, point: [0.5 * h, 0, 0], normal: [0, 1, 0], t: 1 }, { item: 'pier3', yaw: 0, tip: 0 }))).toBe(true);
    expect(s.place(s.ghost({ body: 2, point: [-1 * h, 3 * h, 0], normal: [0, 1, 0], t: 1 }, { item: 'slab', yaw: 0, tip: 0 }))).toBe(true);
    const built = s.def(), back = parseLevelDef(JSON.parse(levelJson(built)));
    expect(back).toEqual(built);
    expect(back.parts.slice(RL1.parts.length).map((p) => p.kind)).toEqual(['piece', 'piece', 'piece', 'piece']);
    expect(compileLevel(back).hash).toBe(compileLevel(built).hash);
    const issues = levelIssues(back);
    if (issues instanceof Error) throw issues;
    expect(issues.filter((i) => !i.warning)).toEqual([]);
    // A malformed pin or bell, refused saying where.
    const bad = (p: unknown) => () => parseLevelDef({ ...JSON.parse(levelJson(RL1)), ...(p as object) });
    expect(bad({ parts: [{ kind: 'piece', at: [0, 0, 0], half: [1, 1, 1], pinned: 1, material: 'stone' }] })).toThrow(/parts\[0\]\.pinned/);
    expect(bad({ parts: [{ kind: 'ball', at: [0, 0, 0], radius: -1, material: 'stone' }] })).toThrow(/parts\[0\]\.radius/);
    expect(bad({ objective: { kind: 'bell', region: { min: [0, 0], max: [1, 1, 1] } } })).toThrow(/objective\.region\.min/);
    expect(bad({ charges: [{ host: 0, weapon: 'release', arm: 'later' }] })).toThrow(/charges\[0\]\.arm/);
    // The parts par lives on the build block (any build level may score on parts); rube is a plain marker.
    expect(RL1.build?.par).toBe(2);
    expect(bad({ build: { ...RL1.build, par: 0 } })).toThrow('level.build.par must be 1 or more');
    expect(bad({ build: { ...RL1.build, par: 1.5 } })).toThrow(/level.build.par must be a whole number/);
    expect(bad({ rube: { partsPar: 2 } })).toThrow('level.rube must be true');
  });

  it('Aftershock (M7, M7b): its levels and a braced retrofit round-trip through JSON (quake rules, a fixed quake, standing heritage, pins, the quake objective)', () => {
    for (const def of [...AFTERSHOCK_LEVELS, retrofitCandidate('RC-1')]) {
      const back = parseLevelDef(JSON.parse(levelJson(def)));
      expect(back).toEqual(def);
      expect(compileLevel(back).hash).toBe(compileLevel(def).hash);
    }
    // A pinned block and box part (an anchored tower's bottom storey) read back pinned.
    const anchored = { ...A1, parts: [...A1.parts, { kind: 'block' as const, at: [9, 0, 9] as [number, number, number], size: [1, 1, 1] as [number, number, number], material: 'stone' as const, pinned: true as const }, { kind: 'slab' as const, at: [12, 0, 12] as [number, number, number], half: [1, 0.5, 1] as [number, number, number], material: 'stone' as const, pinned: true as const }] };
    expect(parseLevelDef(JSON.parse(levelJson(anchored)))).toEqual(anchored);
    // Braced as a player braces (a pier of three beside the first column), saved and loaded: same hash, same base hash.
    const rc = retrofitCandidate('RC-1'), s = new BuildSession(rc), h = s.h, p = s.pitch;
    expect(s.place(s.ghost({ body: -1, point: [-0.5 * p * h, 0, 0.5 * p * h], normal: [0, 1, 0], t: 1 }, { item: 'pier3', yaw: 0, tip: 0 }))).toBe(true);
    const built = s.def(), back = parseLevelDef(JSON.parse(levelJson(built))), cb = compileLevel(back);
    expect(back).toEqual(built);
    expect([cb.hash, cb.baseHash]).toEqual([compileLevel(built).hash, compileLevel(rc).hash]);
    const bad = (p: unknown) => () => parseLevelDef({ ...JSON.parse(levelJson(rc)), ...(p as object) });
    expect(bad({ quake: { fixed: { peak: 30, hz: 10, sec: 10 } } })).toThrow(/quake\.fixed\.axis/);
    expect(bad({ quake: { fixed: { peak: 30, hz: 10, sec: 10, axis: 0 }, peakMax: 40 } })).toThrow(/a fixed quake takes no peakMax/);
    expect(bad({ quake: { hz: [10] } })).toThrow(/quake\.hz must be \[lowest, highest\]/);
    expect(bad({ heritage: 'upright' })).toThrow(/heritage/);
  });

  it('reads racks and solutions holding presets and weapons (p-, w-)', () => {
    const d: LevelDef = { ...structuredClone(L2), rack: ['p-wreckingball', 'w-grenade', 'cannonball'], solutions: { par: [{ ammo: 'w-grenade', az: 540, y: 8, yaw: 0, pitch: 300, power: 80 }] } };
    expect(parseLevelDef(JSON.parse(levelJson(d)))).toEqual(d);
    expect(() => parseLevelDef({ ...d, rack: ['p-nuke'] })).toThrow(/level.rack\[0\] must be one of marble, cannonball, cue, drop, pull, plunger, quake, p-<preset> \(beachball/);
  });

  it('reads back the outcome fields: scoring, cast stars, the collapse objective and a footprint limit on any objective', () => {
    const outcome: LevelDef = { ...structuredClone(L2), id: 'big', scoring: 'outcome', objective: { kind: 'collapse', min: 0.4, footprintMax: 0.2 }, stars: { metric: 'collapse', t2: 0.45, t3: 0.6, best: 0.81, castOn: 'apple metal-3', engine: 'gpu', hash: 'abc', n: 64, seed: 1 } };
    expect(parseLevelDef(JSON.parse(levelJson(outcome)))).toEqual(outcome);
    const crowns: LevelDef = { ...structuredClone(L2), objective: { kind: 'crowns', footprintMax: 0.1 }, stars: { metric: 'skyline', t2: 0.5, t3: 0.3 } };
    expect(parseLevelDef(JSON.parse(levelJson(crowns)))).toEqual(crowns);
    expect(decodeLevelParam(encodeLevelParam(outcome))).toEqual(outcome);
    const bad = (edit: (d: Record<string, any>) => void) => { const d = structuredClone(outcome) as Record<string, any>; edit(d); return () => parseLevelDef(d); };
    expect(bad((d) => { d.scoring = 'golf'; })).toThrow(/level.scoring must be one of par, outcome/);
    expect(bad((d) => { d.objective.min = 1.5; })).toThrow(/level.objective.min must be from 0 to 1/);
    expect(bad((d) => { d.stars.metric = 'joy'; })).toThrow(/level.stars.metric must be one of collapse, crowns, skyline, score/);
    expect(bad((d) => { d.stars.t4 = 1; })).toThrow(/level.stars: unknown key t4/);
    expect(bad((d) => { d.stars.n = 1.5; })).toThrow(/level.stars.n must be a whole number/);
  });

  it('reads back the physics block, autobank and custom, and refuses values out of range', () => {
    const def: LevelDef = { ...structuredClone(L2), scoring: 'outcome', autobank: true, settle: 'v1', custom: true, physics: { iterations: 20, gapSlop: 0, bounce: null, pairsPerBody: 24, presettle: 120 } };
    expect(parseLevelDef(JSON.parse(levelJson(def)))).toEqual(def);
    expect(parseLevelDef(JSON.parse(levelJson({ ...def, physics: { bounce: 0.4 } }))).physics).toEqual({ bounce: 0.4 });
    // GPU sleep (E2.5) reads back; not a boolean, or with bounce, is refused.
    expect(parseLevelDef(JSON.parse(levelJson({ ...def, physics: { sleep: true, iterations: 30 } }))).physics).toEqual({ sleep: true, iterations: 30 });
    const bad = (physics: unknown) => () => parseLevelDef({ ...structuredClone(L2), physics });
    expect(bad({ iterations: 0 })).toThrow(/level.physics.iterations must be a whole number from 1 to 200/);
    expect(bad({ bounce: 'yes' })).toThrow(/level.physics.bounce must be a number/);
    expect(bad({ substeps: 2 })).toThrow(/level.physics: unknown key substeps/);
    expect(bad({ sleep: 1 })).toThrow(/level.physics.sleep must be/);
    expect(bad({ sleep: true, bounce: 0.4 })).toThrow(/level.physics.sleep does not go with bounce/);
    // C22: bodies that start asleep (with sleep), and a wave level's run window.
    expect(parseLevelDef(JSON.parse(levelJson({ ...def, physics: { sleep: true, asleep: true } }))).physics).toEqual({ sleep: true, asleep: true });
    expect(bad({ asleep: true })).toThrow(/level.physics.asleep needs level.physics.sleep: true/);
    expect(bad({ sleep: true, asleep: 'yes' })).toThrow(/level.physics.asleep must be/);
    expect(parseLevelDef(JSON.parse(levelJson({ ...def, runWindow: 75 }))).runWindow).toBe(75);
    expect(() => parseLevelDef({ ...structuredClone(L2), runWindow: 12 })).toThrow(/level.runWindow must be seconds over 30/);
    expect(() => parseLevelDef({ ...structuredClone(L2), settle: 'v9' })).toThrow(/level.settle must be v1 or v2 or v3 or v4: v9/);
  });

  it('reads back a freeze budget and a hold objective (Undercut, Bullet Time), and refuses a budget out of range', () => {
    const def: LevelDef = { ...structuredClone(U3), freeze: 3 };
    expect(def.objective).toEqual({ kind: 'hold' });
    expect(parseLevelDef(JSON.parse(levelJson(def)))).toEqual(def);
    expect(() => parseLevelDef({ ...structuredClone(L2), freeze: 10 })).toThrow(/level.freeze must be a whole number from 0 to 9: 10/);
    expect(() => parseLevelDef({ ...structuredClone(L2), freeze: 1.5 })).toThrow(/level.freeze must be a whole number/);
    expect(() => parseLevelDef({ ...structuredClone(L2), objective: { kind: 'hold', min: 1 } })).toThrow(/level.objective: unknown key min/);
  });

  it('reads back a fixed slab or rod (Undercut\'s beams), and refuses fixed on anything but true', () => {
    expect(U2.parts.some((p) => p.kind === 'slab' && p.fixed)).toBe(true);
    expect(parseLevelDef(JSON.parse(levelJson(U2)))).toEqual(U2);
    expect(compileLevel(parseLevelDef(JSON.parse(levelJson(U2)))).hash).toBe(compileLevel(U2).hash);
    const bad = structuredClone(U2) as unknown as Record<string, any>;
    bad.parts[1].fixed = false;
    expect(() => parseLevelDef(bad)).toThrow(/level.parts\[1\].fixed must be true or left out/);
    // Fixing a part is a different level: its hash changes.
    const loose = { ...U2, parts: U2.parts.map((p) => (p.kind === 'slab' ? { ...p, fixed: undefined } : p)) };
    expect(compileLevel(loose).hash).not.toBe(compileLevel(U2).hash);
  });

  it('reads back a chosen opener (PT13: solutions.opener, one shot) and keeps it out of the level hash', () => {
    const withOpener: LevelDef = { ...structuredClone(L2), solutions: { ...L2.solutions, opener: L2.solutions!.par![0]! } };
    expect(parseLevelDef(JSON.parse(levelJson(withOpener)))).toEqual(withOpener);
    expect(compileLevel(withOpener).hash).toBe(compileLevel(L2).hash);
    expect(() => parseLevelDef({ ...JSON.parse(levelJson(withOpener)), solutions: { opener: [] } })).toThrow(/solutions.opener/);
  });

  it('reads back a scenario part with its role rules, and refuses a bad one, saying where', () => {
    const city: LevelDef = {
      ...structuredClone(L2), id: 'city', scoring: 'outcome', objective: { kind: 'collapse', min: 0.3 },
      parts: [{ kind: 'scenario', id: 'S4', params: { N: 500, F: 4, H: 8, street: 3 }, seed: 3, at: [0, 0, 2], material: 'stone', role: 'plain', gap: 0.05,
        roles: [{ role: 'crown', top: true, tag: [0, 1] }, { role: 'heritage', course: [0, 1], box: { min: [-10, 0, -10], max: [0, 2, 0] } }, { role: 'crown', course: 7 }] }],
    };
    expect(parseLevelDef(JSON.parse(levelJson(city)))).toEqual(city);
    expect(levelIssues(city)).not.toBeInstanceOf(Error);
    const bad = (edit: (p: Record<string, any>) => void) => { const d = structuredClone(city) as Record<string, any>; edit(d.parts[0]); return () => parseLevelDef(d); };
    expect(bad((p) => { p.id = 'S99'; })).toThrow(/level.parts\[0\].id must be one of S1/);
    expect(bad((p) => { p.params.N = 'many'; })).toThrow(/level.parts\[0\].params.N must be a number/);
    expect(bad((p) => { p.roles[0].top = 1; })).toThrow(/level.parts\[0\].roles\[0\].top must be true or false/);
    expect(bad((p) => { p.roles[1].course = [0, 1, 2]; })).toThrow(/roles\[1\].course must be a whole number or two of them/);
    expect(bad((p) => { p.roles[2].colour = 'red'; })).toThrow(/roles\[2\]: unknown key colour/);
    expect(bad((p) => { p.size = [1, 1, 1]; })).toThrow(/level.parts\[0\]: unknown key size/);
    // A param the scenario does not have is the compile's error, which the panel shows.
    expect(levelIssues({ ...city, parts: [{ ...city.parts[0]!, params: { width: 3 } } as never] })).toEqual(new Error('S4 has no param width'));
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

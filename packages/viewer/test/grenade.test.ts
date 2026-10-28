// The grenade as a viewer projectile: its URL keys, the scene file's weapons
// section, the world-scale conversion and the panel's summary line.
import { describe, expect, it } from 'vitest';
import { DEFAULT_GRENADE, type GrenadeSpec } from '@tb/weapons';
import { grenadeSummary, parseSceneFile, parseViewerConfig, SCENE_FILE_FORMAT, sceneFile, toSearch, type ViewerConfig, worldGrenade } from '../src/index.ts';

const at = new Date(2026, 9, 28, 5, 0);
const roundTrip = (c: ViewerConfig) => parseSceneFile(JSON.stringify(sceneFile(c, 'x', null, at))).config;
const custom: GrenadeSpec = { fuse: 'proxTimer', delay: 0.4, prox: 1.5, arm: 0.25, ground: false, blast: { radius: 7, impulse: 60, falloff: 2, core: 0.1, maxDv: 30, maxSpeed: 40 } };
const customSearch = '?proj.weapon=grenade&grenade.fuse=proxTimer&grenade.delay=0.4&grenade.prox=1.5&grenade.arm=0.25&grenade.ground=0&grenade.radius=7&grenade.impulse=60&grenade.falloff=2&grenade.core=0.1&grenade.maxDv=30&grenade.maxSpeed=40';

describe('grenade projectile', () => {
  it('proj.weapon=grenade fires a grenade at DEFAULT_GRENADE; without it the projectile is as before', () => {
    expect(parseViewerConfig('?proj.weapon=grenade').projectile).toEqual({ shape: 'ball', size: 1.4, mass: null, speed: 40, weapon: 'grenade', grenade: DEFAULT_GRENADE });
    expect(parseViewerConfig('').projectile).not.toHaveProperty('weapon');
    expect(toSearch(parseViewerConfig('?proj.weapon=grenade'))).toMatch(/proj\.weapon=grenade/);
    expect(toSearch(parseViewerConfig('?proj.weapon=grenade'))).not.toMatch(/grenade\./);
  });

  it('every grenade key reads and writes back', () => {
    const c = parseViewerConfig(customSearch);
    expect(c.projectile.grenade).toEqual(custom);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
  });

  it('refuses grenade keys it can not use, saying why', () => {
    const q = (s: string) => () => parseViewerConfig(`?${s}`);
    expect(q('grenade.prox=1')).toThrow(/grenade.prox applies to proj.weapon=grenade/);
    expect(q('proj.weapon=sticky')).toThrow(/proj.weapon must be grenade/);
    expect(q('proj.weapon=grenade&grenade.fuse=boom')).toThrow(/grenade.fuse must be one of timer, prox, proxTimer/);
    expect(q('proj.weapon=grenade&grenade.bogus=1')).toThrow(/unknown key grenade.bogus/);
    expect(q('proj.weapon=grenade&grenade.prox=-1')).toThrow(/grenade.prox must be a number from 0/);
    expect(q('proj.weapon=grenade&grenade.prox=')).toThrow(/grenade.prox must be a number/);
    expect(q('proj.weapon=grenade&grenade.ground=2')).toThrow(/grenade.ground must be 0 or 1/);
    expect(q('proj.weapon=grenade&grenade.falloff=1.5')).toThrow(/falloff/);
  });

  it('the scene file lists the grenade whether fired or not, and loads it back', () => {
    const c = parseViewerConfig(customSearch);
    const f = sceneFile(c, 'x', null, at);
    expect(f.projectile).toEqual({ shape: 'ball', size: 1.4, mass: null, speed: 40, weapon: 'grenade' });
    expect(f.weapons).toEqual({ grenade: custom });
    expect(roundTrip(c).projectile).toEqual(c.projectile);
    // Off, the file still lists the default grenade, and loads back with no weapon.
    const off = sceneFile(parseViewerConfig(''), 'x', null, at);
    expect(off.weapons).toEqual({ grenade: DEFAULT_GRENADE });
    expect(roundTrip(parseViewerConfig('')).projectile).toEqual(parseViewerConfig('').projectile);
    // A file from before weapons loads as before.
    const { weapons: _, ...old } = off;
    expect(parseSceneFile(JSON.stringify(old)).config.projectile).toEqual(parseViewerConfig('').projectile);
    // Turning the weapon on in a file arms its listed grenade.
    const on = structuredClone(off) as Record<string, any>;
    on.projectile.weapon = 'grenade';
    on.weapons.grenade.prox = 2;
    expect(parseSceneFile(JSON.stringify(on)).config.projectile.grenade).toEqual({ ...DEFAULT_GRENADE, prox: 2 });
  });

  it('refuses a weapons section it can not read, fired or not', () => {
    const bad = (edit: (f: Record<string, any>) => void) => {
      const f = structuredClone(sceneFile(parseViewerConfig(''), '', null, at)) as Record<string, any>;
      edit(f);
      return () => parseSceneFile(JSON.stringify(f));
    };
    expect(bad((f) => { f.weapons.rocket = {}; })).toThrow(/weapons: unknown key rocket/);
    expect(bad((f) => { f.weapons.grenade.boom = 1; })).toThrow(/weapons.grenade: unknown key boom/);
    expect(bad((f) => { f.weapons.grenade.blast.size = 1; })).toThrow(/weapons.grenade.blast: unknown key size/);
    expect(bad((f) => { f.weapons.grenade.prox = 'near'; })).toThrow(/weapons.grenade.prox must be a number/);
    expect(bad((f) => { f.weapons.grenade.blast.radius = 0; })).toThrow(/grenade.radius must be a number from 0.1/);
    expect(bad((f) => { f.weapons.grenade.ground = 1; })).toThrow(/weapons.grenade.ground must be true or false/);
    expect(bad((f) => { f.projectile.weapon = 'rocket'; })).toThrow(/proj.weapon must be grenade/);
    expect(() => parseSceneFile(JSON.stringify({ format: SCENE_FILE_FORMAT, version: 1, scene: { scenario: 'S1' }, engine: { name: 'rapier' }, weapons: [] }))).toThrow(/weapons must be an object/);
  });

  it('a scaled world speeds the blast up as it does the projectile, and lifts the speed cap with the substeps', () => {
    expect(worldGrenade(DEFAULT_GRENADE, 1, 1)).toBe(DEFAULT_GRENADE);
    const g = worldGrenade(DEFAULT_GRENADE, 2, 3);
    expect(g.blast).toEqual({ ...DEFAULT_GRENADE.blast, impulse: 80, maxDv: 50, maxSpeed: 144 });
    expect({ ...g, blast: null }).toEqual({ ...DEFAULT_GRENADE, blast: null });
  });

  it('the panel says what the blast does to a scene cube', () => {
    // Radius 5, flat core to 1 m, linear after: 37.5 at 2.5 m and 15 at 4 m, capped at maxDv 25.
    expect(grenadeSummary(DEFAULT_GRENADE)).toBe('a cube at 1 m gets 25, 2.5 m gets 25, 4 m gets 15 m/s');
  });
});

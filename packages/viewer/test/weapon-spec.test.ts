// WeaponSpecs as viewer projectiles: proj.weapon=<built-in>, weapon.def for
// a weapon of your own, the scene file's weapons section, the world-scale
// conversion and the panel's summary line.
import { describe, expect, it } from 'vitest';
import { DEFAULT_BLAST_MAX_DV, DEFAULT_BLAST_MAX_SPEED } from '@tb/engine-api';
import { BUILTIN_WEAPONS, CLUSTER, FIREWORK, type WeaponSpec } from '@tb/weapons';
import { decodeWeaponParam, encodeWeaponParam, parseSceneFile, parseViewerConfig, sceneFile, toSearch, type ViewerConfig, weaponSummary, worldWeapon } from '../src/index.ts';

const at = new Date(2026, 10, 1, 5, 0);
const roundTrip = (c: ViewerConfig) => parseSceneFile(JSON.stringify(sceneFile(c, 'x', null, at))).config;
const BOOM: WeaponSpec = {
  version: 1, name: 'boom', shell: { shape: { kind: 'sphere', radius: 0.3 }, density: 5, speed: [10, 30] },
  rules: [{ when: { then: [{ near: 0.5 }, { after: 0.2 }] }, do: [{ blast: { radius: 4, impulse: 30, offset: [0, -0.5, 0] } }, { remove: true }] }],
};

describe('WeaponSpec projectiles', () => {
  it('proj.weapon=firework (or cluster) fires the built-in spec; the link stays short', () => {
    for (const name of ['firework', 'cluster']) {
      const c = parseViewerConfig(`?proj.weapon=${name}`);
      expect(c.projectile.weapon).toBe(name);
      expect(c.projectile.spec).toBe(BUILTIN_WEAPONS[name]);
      expect(c.projectile).not.toHaveProperty('grenade');
      expect(toSearch(c)).toMatch(new RegExp(`proj\\.weapon=${name}`));
      expect(toSearch(c)).not.toMatch(/weapon\.def/);
      expect(parseViewerConfig(toSearch(c))).toEqual(c);
    }
  });

  it('weapon.def carries a weapon of your own: its name is proj.weapon, and it reads and writes back', () => {
    const def = encodeWeaponParam(BOOM);
    expect(decodeWeaponParam(def)).toEqual(BOOM);
    const c = parseViewerConfig(`?weapon.def=${def}`);
    expect(c.projectile.weapon).toBe('boom');
    expect(c.projectile.spec).toEqual(BOOM);
    expect(toSearch(c)).toMatch(/proj\.weapon=boom/);
    expect(parseViewerConfig(toSearch(c))).toEqual(c);
    // A built-in changed is your own too, under the built-in's name.
    const tuned: WeaponSpec = { ...FIREWORK, rules: [{ ...FIREWORK.rules[0]!, do: [{ split: { into: 6, child: 'star', pattern: 'cone', angle: 50, spread: 14, at: 1.5 } }] }] };
    const t = parseViewerConfig(`?proj.weapon=firework&weapon.def=${encodeWeaponParam(tuned)}`);
    expect(t.projectile.spec).toEqual(tuned);
    expect(toSearch(t)).toMatch(/weapon\.def=/);
    expect(parseViewerConfig(toSearch(t))).toEqual(t);
    // A spec without a name is "custom".
    const { name: _, ...anon } = BOOM;
    expect(parseViewerConfig(`?weapon.def=${encodeWeaponParam(anon as WeaponSpec)}`).projectile.weapon).toBe('custom');
  });

  it('refuses a weapon it can not fire, saying why (the validator\'s issue codes)', () => {
    const q = (s: string) => () => parseViewerConfig(`?${s}`);
    expect(q('weapon.def=%%%')).toThrow(/weapon.def is not base64url-encoded UTF-8/);
    expect(q(`weapon.def=${btoa('{ nope')}`)).toThrow(/weapon.def: .*\[json\]/);
    expect(q(`weapon.def=${btoa(JSON.stringify({ ...BOOM, version: 2 })).replace(/=+$/, '')}`)).toThrow(/\[version\]/);
    expect(q(`proj.weapon=cluster&weapon.def=${encodeWeaponParam(BOOM)}`)).toThrow(/weapon.def is the weapon "boom", but proj.weapon is cluster/);
    expect(q(`proj.weapon=grenade&weapon.def=${encodeWeaponParam({ ...BOOM, name: 'grenade' })}`)).toThrow(/grenade has its own keys/);
    expect(q('proj.weapon=firework&grenade.prox=1')).toThrow(/grenade.prox applies to proj.weapon=grenade/);
  });

  it('the scene file lists the fired spec under its name, and loads it back; a file can arm any spec it lists', () => {
    const c = parseViewerConfig(`?weapon.def=${encodeWeaponParam(BOOM)}`);
    const f = sceneFile(c, 'x', null, at);
    expect(f.projectile.weapon).toBe('boom');
    expect(f.projectile).not.toHaveProperty('spec');
    expect(f.weapons.boom).toEqual(BOOM);
    expect(roundTrip(c).projectile).toEqual(c.projectile);
    expect(roundTrip(parseViewerConfig('?proj.weapon=cluster')).projectile.spec).toEqual(CLUSTER);
    // A file listing a spec without firing it, then firing it.
    const off = structuredClone(sceneFile(parseViewerConfig(''), 'x', null, at)) as Record<string, any>;
    off.weapons.boom = { ...BOOM, name: undefined };
    expect(parseSceneFile(JSON.stringify(off)).config.projectile).not.toHaveProperty('weapon');
    off.projectile.weapon = 'boom';
    expect(parseSceneFile(JSON.stringify(off)).config.projectile.spec).toEqual(BOOM);
  });

  it('refuses a spec in a file it can not read, with where', () => {
    const bad = (edit: (f: Record<string, any>) => void) => {
      const f = structuredClone(sceneFile(parseViewerConfig(''), '', null, at)) as Record<string, any>;
      edit(f);
      return () => parseSceneFile(JSON.stringify(f));
    };
    expect(bad((f) => { f.weapons.Boom = BOOM; })).toThrow(/weapons.Boom: weapon names match/);
    expect(bad((f) => { f.weapons.boom = { ...BOOM, rules: [{ when: { soon: 1 }, do: [{ remove: true }] }] }; })).toThrow(/weapons.boom: .*rules.0.when.*\[trigger\]/);
  });

  it('a scaled world speeds spreads and blasts up as the grenade, and lifts the speed caps (the engine defaults where unset) with the substeps', () => {
    expect(worldWeapon(FIREWORK, 1, 1)).toBe(FIREWORK);
    const w = worldWeapon(FIREWORK, 2, 3);
    expect(w.rules[0]!.do[0]).toEqual({ split: { into: 12, child: 'star', pattern: 'cone', angle: 50, spread: 20, at: 1.5 } });
    expect(w.children!.star!.rules[0]!.do[0]).toEqual({ blast: { radius: 3, impulse: 37, core: 0.2, maxDv: 2 * DEFAULT_BLAST_MAX_DV, maxSpeed: 3 * DEFAULT_BLAST_MAX_SPEED } });
    expect(w.shell).toEqual({ ...FIREWORK.shell, speed: [50, 90] });
    expect(w.children!.star!.rules[0]!.when).toEqual(FIREWORK.children!.star!.rules[0]!.when);
  });

  it('the panel says what a shot can spawn and set off, and the validator\'s warnings', () => {
    expect(weaponSummary(FIREWORK)).toBe('firework: up to 13 bodies and 12 blasts a shot');
    expect(weaponSummary({ ...BOOM, rules: [{ when: { after: 1 }, do: [{ blast: { radius: 1, impulse: 1 } }] }] })).toBe('boom: up to 1 bodies and 1 blast a shot; never-spent at rules');
  });
});

// Sandbox weapons on a level's page (?level=B1 with proj.weapon=grenade|firework|cluster):
// the viewer's cube units stand for the level's commonest block (keystone cubeScale), as
// the rack's w- items do, so the viewer's grenade on B1's page is B1's bomb, and a
// block of 31 kg plaster gets the kick a 1 kg cube does (Froude-scaled), not 0.48 m/s.
import { describe, expect, it } from 'vitest';
import { blastArea, blastKick, checkBlast } from '@tb/engine-api';
import { B1, B3, type CompiledLevel, compileLevel, cubeScale, L1, levelArm, levelBlock } from '@tb/keystone';
import { BUILTIN_WEAPONS, DEFAULT_GRENADE, type GrenadeBlast, type WeaponSpec, weaponBudget } from '@tb/weapons';
import { inLevelGrenade, inLevelWeapon } from '../src/index.ts';

/** Speed the blast gives the level's commonest block at its centre's core, m/s. */
function coreKick(blast: GrenadeBlast, level: CompiledLevel): number {
  const b = levelBlock(level)!, mass = b.mass, area = blastArea({ kind: 'box', half: b.half });
  const v = blastKick(checkBlast({ centre: [0, 0, 0], ...blast }), [0, 0, 0], 0, [0.01, 0, 0], mass, area)!;
  return Math.hypot(v[0], v[1], v[2]);
}

describe('weapons on a level page', () => {
  it('the viewer grenade unscaled is a dud on plaster (0.48 m/s); in level units it kicks as the cube got, x sqrt(h)', () => {
    const c = compileLevel(L1), h = c.frame.unit;
    expect(coreKick(DEFAULT_GRENADE.blast, c)).toBeCloseTo(0.48, 2);
    const g = inLevelGrenade(DEFAULT_GRENADE, cubeScale(c));
    expect(coreKick(g.blast, c)).toBeCloseTo(DEFAULT_GRENADE.blast.maxDv * Math.sqrt(h), 9);
    expect(g.blast.radius).toBe(DEFAULT_GRENADE.blast.radius * h);
    expect(g.prox).toBe(DEFAULT_GRENADE.prox * h);
    expect([g.fuse, g.delay, g.arm, g.ground]).toEqual([DEFAULT_GRENADE.fuse, DEFAULT_GRENADE.delay, DEFAULT_GRENADE.arm, DEFAULT_GRENADE.ground]);
  });

  it('on B1 (plaster) and B3 (stone) the page\'s grenade is the level\'s own bomb, blast for blast', () => {
    for (const def of [B1, B3]) {
      const c = compileLevel(def), bomb = levelArm(c, 'bomb').blasts[0]!.blast;
      const g = inLevelGrenade(DEFAULT_GRENADE, cubeScale(c));
      for (const k of ['radius', 'impulse', 'falloff', 'core', 'maxDv', 'maxSpeed'] as const) expect(g.blast[k], `${def.id} ${k}`).toBeCloseTo(bomb[k], 9);
      expect(g.prox).toBeCloseTo(DEFAULT_GRENADE.prox * c.frame.unit, 12);
    }
  });

  it('a WeaponSpec on a level page is the rack\'s w- item: the built-ins scale as levelArm scales them', () => {
    const c = compileLevel({ ...L1, rack: ['w-firework', 'w-cluster'] });
    const full = (b: Parameters<typeof checkBlast>[0]) => { const k = checkBlast(b); return [k.radius, k.impulse, k.falloff, k.core, k.maxDv, k.maxSpeed]; };
    const view = (spec: WeaponSpec) => {
      const w = weaponBudget(spec);
      return { blasts: w.blasts.map((x) => [x.path, x.count, full({ centre: [0, 0, 0], ...x.blast })]), shells: w.munitions.map((m) => [m.path, m.count, m.shell.shape, m.shell.density, m.shell.speed ?? null]) };
    };
    for (const [key, spec] of Object.entries(BUILTIN_WEAPONS)) {
      const arm = levelArm(c, key).spec as WeaponSpec, ours = inLevelWeapon(spec, cubeScale(c));
      const a = view(ours), b = view(arm);
      expect(a.shells, key).toEqual(b.shells);
      a.blasts.forEach((x, i) => (x[2] as number[]).forEach((v, j) => expect(v, `${key} blast ${i} field ${j}`).toBeCloseTo((b.blasts[i]![2] as number[])[j]!, 12)));
      // The splits' spreads and distances scale alike too.
      expect(JSON.stringify(ours.rules.map((r) => r.do.filter((d) => 'split' in d)))).toBe(JSON.stringify(arm.rules.map((r) => r.do.filter((d) => 'split' in d))));
    }
  });
});

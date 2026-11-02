// WeaponSpec weapons in the rack (roadmap G3.4, spectacle-mode.md section 7): a w-<key>
// item whose weapon is a @tb/weapons WeaponSpec (a level's own, or the built-in firework
// and cluster) is scaled from the viewer's cube units to the level (arsenal.ts cubeScale),
// fired in its own shell, counted at its whole static budget (capacity, the GPU's room),
// charged every blast it can set off, checked child by child, and run by the Driver on
// @tb/weapons' WeaponRuntime: a firework's split, its stars' blasts and removals replay
// bit for bit, serial and pipelined alike, and from the recorded inputs on a plain engine.
// The GPU replay is game rack-weapons-gpu.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { blastArea, checkBlast, type InputEvent, TIER_FREE } from '@tb/engine-api';
import {
  AVBD_GAP_SLOP, AVBD_ITERATIONS, B1, B2, B3, compileLevel, cubeScale, itemSpec, itemYield, KEYSTONE_GRENADE, L1, type LevelDef, levelArm, levelBlock, levelFill, levelWeapon, rackBodies, runSession,
  type SessionResult, type Shot, shotToSpawn, snapshotHash, speedOf, validateLevel,
} from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { BUILTIN_WEAPONS, CLUSTER, FIREWORK, grenadeAsSpec, grenadeEnergies, isWeaponSpec, nominalYield, type WeaponSpec, weaponBudget } from '@tb/weapons';

const def: LevelDef = { ...L1, rack: ['w-firework', 'w-cluster', 'w-grenade'] };
const c = compileLevel(def);
/** A firework aimed at the tower's middle from L1's par launcher at 30% power: it splits on the bounce and brings the crowns down. */
const FIRE: Shot = { ammo: 'w-firework', az: 360, y: 8, yaw: 0, pitch: 176, power: 30 };
const CLUS: Shot = { ammo: 'w-cluster', az: 360, y: 8, yaw: 0, pitch: 176, power: 30 };
const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });

async function play(make: () => RapierEngine | AvbdReferenceEngine, level: typeof c, shots: Shot[], pipelined: boolean) {
  let pushed: InputEvent[] = [];
  const r = await runSession(make(), level, shots, { pipelined, perStep: (d) => { pushed = d.pushed; return []; } });
  return { r, pushed: [...pushed] };
}

const inputsOf = (level: typeof c, r: SessionResult, pushed: InputEvent[]): InputEvent[] => [...r.session.inputs.map(({ step, shot }) => shotToSpawn(level.frame, shot, step)), ...pushed];

const count = (events: readonly InputEvent[]) => events.reduce<Record<string, number>>((a, e) => ({ ...a, [e.kind]: (a[e.kind] ?? 0) + 1 }), {});

describe('WeaponSpec items: scaled to the level', () => {
  it('cube units become the level\'s: lengths x h, speeds x sqrt(h), density x the block\'s, and a blast gives the block the Froude-scaled kick the cube got', () => {
    const b = levelBlock(c)!, h = c.frame.unit, s = cubeScale(c);
    expect(b.half).toEqual([0.25, 0.25, 0.25]);
    expect(s).toEqual({ length: h, speed: Math.sqrt(h), density: b.mass / 0.125, impulse: s.impulse, maxDv: Math.sqrt(h), maxSpeed: Math.sqrt(h) });
    // The speed change I x A/m the commonest block gets, over the viewer cube's (1 kg, edge 1), is sqrt(h).
    const blockDv = s.impulse! * (blastArea({ kind: 'box', half: b.half }) / b.mass), cubeDv = blastArea({ kind: 'box', half: [0.5, 0.5, 0.5] });
    expect(blockDv / cubeDv).toBeCloseTo(Math.sqrt(h), 12);
    const fw = levelArm(c, 'firework'), raw = FIREWORK;
    expect(fw.shell).toEqual({ size: { radius: 0.5 * h }, density: raw.shell.density * s.density!, friction: 0.5, restitution: 0, vMin: 25 * Math.sqrt(h), vMax: 45 * Math.sqrt(h) });
    // A shell of density 4 in cube units is 4 x the block's density.
    expect(fw.shell.density / (b.mass / 0.125)).toBe(4);
    expect(itemSpec('w-firework', c.frame)).toEqual(fw.shell);
    expect(speedOf('w-firework', 100, c.frame)).toBe(45 * Math.sqrt(h));
  });

  it('counts its whole budget: bodies (capacity, the GPU\'s room), every blast with how often it goes off, and the yield of them all', () => {
    for (const [key, spec] of Object.entries({ firework: FIREWORK, cluster: CLUSTER }) as [string, WeaponSpec][]) {
      const arm = c.arms[`w-${key}`]!;
      expect(arm.bodies, key).toBe(weaponBudget(spec).bodies);
      expect(arm.blasts.map((x) => x.count), key).toEqual(weaponBudget(spec).blasts.map((x) => x.count));
      const fill = levelFill(c);
      expect(arm.yield, key).toBe(arm.blasts.reduce((a, x) => a + x.count * nominalYield(x.blast, fill), 0));
      expect(itemYield(c, `w-${key}`), key).toBe(arm.yield);
      // Every blast has the engine's defaults filled in and scaled, so its yield is of the blast the engine applies.
      for (const x of arm.blasts) expect(checkBlast({ centre: [0, 0, 0], ...x.blast })).toMatchObject(x.blast);
    }
    expect(c.arms['w-firework']!.bodies).toBe(13);
    expect(c.arms['w-cluster']!.bodies).toBe(7);
    expect(rackBodies(def.rack, c.arms)).toBe(13 + 7 + 1);
    // Each built-in is one grenade (grenadeEnergies): the viewer's grenade, B1-B3's bomb. Keystone's own w-grenade
    // (KEYSTONE_GRENADE, SI, not scaled with the block) is much smaller: about 1/77 of one on plaster.
    for (const k of ['w-firework', 'w-cluster'] as const) expect(itemYield(c, k) / itemYield(c, 'w-grenade'), k).toBeGreaterThan(70);
  });

  it('a cube-unit weapon\'s yield over the bomb\'s is its grenadeEnergies on every level: plaster or stone, 1k or 10k', () => {
    for (const base of [B1, B2, B3]) {
      const lc = compileLevel({ ...base, rack: ['w-bomb', 'w-firework', 'w-cluster'] });
      for (const [key, spec] of Object.entries(BUILTIN_WEAPONS)) expect(itemYield(lc, `w-${key}` as const) / itemYield(lc, 'w-bomb'), `${base.id} ${key}`).toBeCloseTo(grenadeEnergies(spec), 9);
      expect(grenadeEnergies(base.weapons!.bomb as WeaponSpec)).toBe(1);
    }
  });

  it('a GrenadeSpec stays what it was: levelWeapon in the grenade shell, its one blast', () => {
    const g = levelArm(c, 'grenade');
    expect(g.spec).toEqual(levelWeapon(def, 'grenade'));
    expect(g.shell).toEqual(itemSpec('w-grenade', 0.5));
    expect(g.bodies).toBe(1);
    expect(g.yield).toBe(nominalYield(levelWeapon(def, 'grenade')!.blast, levelFill(c)));
  });

  it('the validator checks each child and each blast, and reports a bad spec', () => {
    // The built-in firework's stars leave at up to 45 sqrt(h) + 10 sqrt(h) = 38.9 m/s (0.648 m a step): under the sweep
    // (SWEEP_REACH 0.8 m), and spheres, so not through a half-metre cube on any engine.
    expect(validateLevel(c).filter((i) => !i.warning)).toEqual([]);
    // Thrown harder (80 sqrt(h) + 10 sqrt(h) = 63.6 m/s) they would outrun the sweep.
    const fast: WeaponSpec = { ...FIREWORK, shell: { ...FIREWORK.shell, speed: [10, 80] } };
    expect(validateLevel(compileLevel({ ...L1, rack: ['w-fast'], weapons: { fast } })).filter((i) => !i.warning)).toEqual([
      { code: 'tunnelling', message: expect.stringMatching(/^w-fast moves 0\.943 m per step/) },
      { code: 'tunnelling', message: expect.stringMatching(/^w-fast's star moves 1\.061 m per step/) },
    ]);
    const bad = { ...CLUSTER, children: { bomblet: { ...CLUSTER.children!.bomblet!, rules: [{ when: { after: -1 }, do: [{ remove: true }] }] } } } as WeaponSpec;
    const issues = validateLevel(compileLevel({ ...L1, rack: ['w-bad'], weapons: { bad } }));
    expect(issues).toContainEqual({ code: 'weapon', message: expect.stringMatching(/^weapons\.bad: /) });
    expect(compileLevel({ ...L1, rack: ['w-bad'], weapons: { bad } }).arms['w-bad']).toBeUndefined();
    expect(validateLevel(compileLevel({ ...L1, rack: ['w-nothing'] }))).toContainEqual({ code: 'weapon', message: 'w-nothing: L1 has no weapons.nothing' });
    // A GrenadeSpec under another key is still a grenade.
    expect(levelArm(compileLevel({ ...L1, rack: ['w-g'], weapons: { g: KEYSTONE_GRENADE } }), 'g').bodies).toBe(1);
  });
});

describe('WeaponSpec items: fired', () => {
  it('a firework on Rapier: the split, 12 stars that each blast and go, serial = pipelined, bit-equal replays', async () => {
    const serial = await play(() => new RapierEngine(), c, [FIRE], false), piped = await play(() => new RapierEngine(), c, [FIRE], true);
    expect(count(serial.pushed)).toEqual({ spawn: 12, blast: 12, remove: 13 });
    expect(piped.pushed).toEqual(serial.pushed);
    // The same events at the same steps. A pipelined driver ends a shot one step later (driver.ts), and since the
    // one-grenade firework (2026-11-02) L1's rubble is still rolling at the settle cap, so the pipelined world is the
    // serial one stepped once more: replayed from the recorded inputs to its step count, bit for bit.
    expect(piped.r.steps).toBeGreaterThanOrEqual(serial.r.steps);
    const ahead = new RapierEngine();
    await ahead.init({ ...c.scene, inputs: inputsOf(c, serial.r, serial.pushed) });
    while (ahead.stepIndex < piped.r.steps) ahead.step();
    expect(snapshotHash(piped.r.snapshot)).toBe(snapshotHash(ahead.snapshot()));
    ahead.dispose();
    expect(serial.r.session.phase).toBe('cleared');
    const o = serial.r.session.outcomes[0]!;
    expect(o.yield).toBe(itemYield(c, 'w-firework'));
    // The shot ends after the last star's blast and removal shows.
    expect(o.settleStep).toBeGreaterThan(Math.max(...serial.pushed.map((e) => e.step)));
    // Every munition is gone: the shell and its 12 stars are tombstones.
    const n = c.meta.n;
    expect(serial.r.snapshot.count).toBe(n + 13);
    for (let i = n; i < n + 13; i++) expect(serial.r.snapshot.tier![i], `body ${i}`).toBe(TIER_FREE);
    expect(serial.r.feedback.filter((f) => f.t === 'blast')).toHaveLength(12);
    // Again, and from the recorded inputs on a plain engine.
    const again = await play(() => new RapierEngine(), c, [FIRE], false);
    expect(snapshotHash(again.r.snapshot)).toBe(snapshotHash(serial.r.snapshot));
    const e = new RapierEngine();
    await e.init({ ...c.scene, inputs: inputsOf(c, serial.r, serial.pushed) });
    while (e.stepIndex < serial.r.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(serial.r.snapshot));
    e.dispose();
  });

  it('a grenade as a WeaponSpec (grenadeAsSpec) replays the w-grenade line bit for bit on the f64 reference', async () => {
    // The spec's proof for G3.4: the same fuse and blast written in the language push the same events at the same steps.
    const g = compileLevel({ ...L1, rack: ['w-grenade'] }), arm = g.arms['w-grenade']!, grenade = levelWeapon(g.def, 'grenade')!;
    const shell = { shape: { kind: 'sphere' as const, radius: (arm.shell.size as { radius: number }).radius }, density: arm.shell.density, speed: [arm.shell.vMin, arm.shell.vMax] as [number, number] };
    const spec = grenadeAsSpec(grenade, shell);
    expect(isWeaponSpec(spec)).toBe(true);
    const asSpec = { ...g, arms: { ...g.arms, 'w-grenade': { ...arm, spec } } };
    const line: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 176, power: 100 }];
    const a = await play(ref, g, line, false), b = await play(ref, asSpec, line, false);
    expect(a.pushed.map((e) => [e.kind, e.step])).toEqual([['blast', 327], ['remove', 327]]);
    expect(b.pushed).toEqual(a.pushed);
    expect(snapshotHash(b.r.snapshot)).toBe(snapshotHash(a.r.snapshot));
    expect(b.r.steps).toBe(a.r.steps);
  }, 120_000);

  it('a cluster then a firework on the f64 reference: replays bit-equal on either driver option, from the recorded inputs too', async () => {
    const lvl = compileLevel({ ...def, rack: ['w-cluster', 'w-firework'] });
    const line: Shot[] = [{ ...CLUS, pitch: 450, power: 60 }, FIRE];
    for (const pipelined of [false, true]) {
      const a = await play(ref, lvl, line, pipelined), b = await play(ref, lvl, line, pipelined);
      expect(count(a.pushed), `${pipelined}`).toEqual({ spawn: 18, blast: 18, remove: 20 });
      expect(b.pushed).toEqual(a.pushed);
      expect(snapshotHash(b.r.snapshot)).toBe(snapshotHash(a.r.snapshot));
      const e = ref();
      await e.init({ ...lvl.scene, inputs: inputsOf(lvl, a.r, a.pushed) });
      while (e.stepIndex < a.r.steps) e.step();
      expect(snapshotHash(e.snapshot())).toBe(snapshotHash(a.r.snapshot));
      // The firework's shell is numbered after the cluster's bomblets.
      expect(a.r.session.inputs.length).toBe(2);
      expect(a.r.feedback.find((f) => f.t === 'fired' && f.ammo === 'w-firework')).toMatchObject({ body: lvl.meta.n + 7 });
    }
  }, 240_000);
});

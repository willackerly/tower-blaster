// The grenade in the rack (roadmap G3.3, spectacle-mode.md sections 4, 7 and 11):
// a w-grenade shot's fuse runs inside the Driver (arsenal.ts), so every caller
// (the game page, its replay, runSession, the bot) pushes the same blasts at the
// same steps; it replays bit for bit on the f64 reference, serial and pipelined
// push alike, and from its recorded inputs on a plain engine; the shot waits for
// its blast before it settles; and leverage charges the blast's nominal yield.
// These cases fire a GrenadeSpec (KEYSTONE_GRENADE, written into the level's weapons):
// since 2026-11-05 a bare w-grenade is the built-in w-grenadem, a WeaponSpec, and its
// own case is the last one here. The GPU replay is rack-grenade-gpu.test.ts (game).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type InputEvent, TIER_FREE } from '@tb/engine-api';
import {
  AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, itemYield, KEYSTONE_GRENADE, L1, type LevelDef, leverage, levelFill, levelWeapon, runSession, type SessionResult, type Shot, shotToSpawn, snapshotHash,
} from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { GRENADE_M, grenadeEnergies, nominalYield } from '@tb/weapons';

const def: LevelDef = { ...L1, rack: ['w-grenade', 'w-grenade', 'marble'], weapons: { grenade: KEYSTONE_GRENADE } };
const c = compileLevel(def);
/** Aimed with aimAt at the tower's middle (2 m up) from L1's par launcher: the prox fuse sets it off on the tower's face. */
const LINE: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 176, power: 100 }];
const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });

/** runSession, keeping the driver's pushed events. */
async function play(make: () => RapierEngine | AvbdReferenceEngine, level: typeof c, shots: Shot[], pipelined: boolean) {
  let pushed: InputEvent[] = [];
  const r = await runSession(make(), level, shots, { pipelined, perStep: (d) => { pushed = d.pushed; return []; } });
  return { r, pushed: [...pushed] };
}

/** Every input the session pushed as scene inputs for a plain engine: the shots' spawns and the weapons' events. */
const inputsOf = (level: typeof c, r: SessionResult, pushed: InputEvent[]): InputEvent[] => [...r.session.inputs.map(({ step, shot }) => shotToSpawn(level.frame, shot, step)), ...pushed];

/** The hash a plain Rapier engine reaches from the session's recorded inputs, as many steps on. */
async function plainHash(level: typeof c, x: Awaited<ReturnType<typeof play>>): Promise<string> {
  const e = new RapierEngine();
  await e.init({ ...level.scene, inputs: inputsOf(level, x.r, x.pushed) });
  while (e.stepIndex < x.r.steps) e.step();
  const h = snapshotHash(e.snapshot());
  e.dispose();
  return h;
}

describe('grenade in the rack', () => {
  it('costs its nominal yield against a solid fill of the level\'s commonest block', () => {
    // L1 is all 0.5 m plaster cubes (31.25 kg) on a 1.02 h horizontal pitch.
    const fill = levelFill(c);
    expect(fill.density).toBeCloseTo(31.25 / (0.125 * 1.02 * 1.02), 9);
    expect(fill.areaPerMass).toBeCloseTo(0.375 / 31.25, 12);
    expect(itemYield(c, 'w-grenade')).toBe(nominalYield(levelWeapon(def, 'grenade')!.blast, fill));
    expect(itemYield(c, 'w-grenade')).toBeCloseTo(15548.4, 1);
    expect(itemYield(c, 'marble')).toBe(0);
    expect(itemYield(c, 'p-wreckingball')).toBe(0);
  });

  it('on the f64 reference: one blast at the same step serial and pipelined, bit-equal replays, leverage over ke + yield', async () => {
    const serial = await play(ref, c, LINE, false), piped = await play(ref, c, LINE, true);
    // The blast, then the spent grenade's removal at the same step (F4): it ends the shot as a tombstone.
    expect(serial.pushed.map((e) => [e.kind, e.step])).toEqual([['blast', 327], ['remove', 327]]);
    expect(serial.pushed[1]).toMatchObject({ id: c.meta.n });
    expect(serial.r.snapshot.tier?.[c.meta.n]).toBe(TIER_FREE);
    expect(piped.pushed).toEqual(serial.pushed);
    expect(serial.r.session.phase).toBe('cleared');
    expect(piped.r.session.score).toEqual(serial.r.session.score);
    expect(piped.r.steps).toBe(serial.r.steps + 1);
    // Bit for bit: again on a fresh engine, and from the recorded inputs on a plain one.
    const again = await play(ref, c, LINE, false);
    expect(snapshotHash(again.r.snapshot)).toBe(snapshotHash(serial.r.snapshot));
    const e = ref();
    await e.init({ ...c.scene, inputs: inputsOf(c, serial.r, serial.pushed) });
    while (e.stepIndex < serial.r.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(serial.r.snapshot));
    const o = serial.r.session.outcomes[0]!;
    expect(o.yield).toBe(itemYield(c, 'w-grenade'));
    expect(o.leverage).toBe(leverage(o.dPE_mJ, o.ke + o.yield));
    expect(o.crownsDown).toBe(4);
    // An outcome level's leverage (outcomeFacts) charges it too: the same shot on L1 scored by outcome.
    const out = compileLevel({ ...def, scoring: 'outcome', objective: { kind: 'collapse', min: 0.01 } });
    const so = (await play(ref, out, LINE, false)).r.session, f = so.outcomeFacts(), oo = so.outcomes[0]!;
    expect(oo.yield).toBe(itemYield(out, 'w-grenade'));
    // One shot from the home pose: the level's leverage is the shot's, ke + yield charged (ke alone would be several times it).
    expect(f.leverage).toBeCloseTo(oo.leverage, 6);
    expect(f.leverage).toBeLessThan(leverage(oo.dPE_mJ, oo.ke) / 2);
    // The page shakes on the blast's feedback, given once, from the first state that shows it.
    expect(serial.r.feedback.filter((f) => f.t === 'blast')).toEqual([{ t: 'blast', step: 327, body: c.meta.n, radius: 1.5 }]);
    expect(piped.r.feedback.filter((f) => f.t === 'blast')).toEqual([{ t: 'blast', step: 327, body: c.meta.n, radius: 1.5 }]);
  }, 120_000);

  it('a shot does not settle while its fuse is live: a timer grenade lying quiet waits for its blast', async () => {
    // Lobbed short of the tower: it lands and lies still long before its 4 s timer.
    const timer: LevelDef = { ...def, weapons: { grenade: { ...KEYSTONE_GRENADE, fuse: 'timer', delay: 4 } } };
    const t = compileLevel(timer), short: Shot = { ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 300, power: 0 };
    const { r, pushed } = await play(() => new RapierEngine(), t, [short], false);
    const fired = r.session.inputs[0]!.step;
    expect(pushed.map((e) => [e.kind, e.step])).toEqual([['blast', fired + 240], ['remove', fired + 240]]);
    expect(r.session.outcomes[0]!.settleStep).toBeGreaterThan(fired + 240);
    // The same shot with a marble, whose structure is just as quiet, settles well before.
    const m = await runSession(new RapierEngine(), compileLevel({ ...def, rack: ['marble'] }), [{ ...short, ammo: 'marble' }]);
    expect(m.session.outcomes[0]!.settleStep).toBeLessThan(fired + 120);
  });

  it('every fuse: serial and pipelined drivers push the same blasts at the same steps, and a two-shot line replays on either (Rapier)', async () => {
    const two: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 300, power: 0 }, ...LINE];
    for (const fuse of ['prox', 'timer', 'proxTimer'] as const) {
      const lvl = compileLevel({ ...def, weapons: { grenade: { ...KEYSTONE_GRENADE, fuse, delay: 0.5 } } });
      const serial = await play(() => new RapierEngine(), lvl, LINE, false), piped = await play(() => new RapierEngine(), lvl, LINE, true);
      expect(serial.pushed.map((e) => e.kind), fuse).toEqual(['blast', 'remove']);
      expect(piped.pushed, fuse).toEqual(serial.pushed);
      expect(piped.r.session.score, fuse).toEqual(serial.r.session.score);
      // A pipelined driver fires a later shot one step later (DriverOptions.pipelined), so a longer
      // line replays exactly on a driver with the same option: each blast, then, at the same step.
      for (const pipelined of [false, true]) {
        const a = await play(() => new RapierEngine(), lvl, two, pipelined), b = await play(() => new RapierEngine(), lvl, two, pipelined);
        expect(a.pushed.map((e) => e.kind), `${fuse} ${pipelined}`).toEqual(['blast', 'remove', 'blast', 'remove']);
        expect(b.pushed, `${fuse} ${pipelined}`).toEqual(a.pushed);
        expect(snapshotHash(b.r.snapshot), `${fuse} ${pipelined}`).toBe(snapshotHash(a.r.snapshot));
        expect(await plainHash(lvl, a)).toBe(snapshotHash(a.r.snapshot));
      }
    }
  });

  it('a bare w-grenade is w-grenadem: one grenade, scaled to L1, 77 x KEYSTONE_GRENADE (76.68); aimed at the tower it clears L1 (f64 reference)', async () => {
    // Will, 2026-11-05: a weapon behaves the same everywhere (scaled to the level's blocks); a smaller one has a smaller name.
    const m = compileLevel({ ...L1, rack: ['w-grenade', 'w-grenadem', 'marble'] });
    expect(m.arms['w-grenade']).toEqual(m.arms['w-grenadem']);
    expect(grenadeEnergies(GRENADE_M)).toBe(1);
    expect(itemYield(m, 'w-grenade') / itemYield(c, 'w-grenade')).toBeCloseTo(76.68, 2);
    // Its shell is w-grenadem's scaled to h = 0.5 m: 0.1 m, 5-40 sqrt(h) m/s. Aimed with aimAt at the tower's middle at full
    // power (game rack-line.ts GRENADE_LINE fires the same shot on the GPU).
    expect(m.frame.shells!['w-grenade']).toMatchObject({ size: { radius: 0.1 }, vMax: 40 * Math.sqrt(0.5) });
    const line: Shot[] = [{ ammo: 'w-grenade', az: 360, y: 8, yaw: 0, pitch: 106, power: 100 }];
    const { r, pushed } = await play(ref, m, line, false);
    expect(pushed.map((e) => [e.kind, e.step])).toEqual([['blast', 314], ['remove', 314]]);
    expect(r.session.phase).toBe('cleared');
    expect(r.session.outcomes[0]!.crownsDown).toBe(4);
    expect(r.session.outcomes[0]!.yield).toBe(itemYield(m, 'w-grenade'));
  }, 120_000);
});

// Charges and the plunger on real engines (C5, docs/design/charges.md), on the f64 reference and
// Rapier: a plunger with a 3-event timeline (cut the left column's base at once, the middle one's 20
// steps later, kick the right one's at 45) puts exactly those events in at exactly those steps; the
// middle cut's blast knocks a relay's host, whose relay (armed at start, moved trigger) cuts it too,
// while a relay out of reach never fires; the session replays bit for bit, serial and pipelined, and
// from its encoded record. Charges at rest send the engine nothing and leave every state (positions
// and sleep) as the level without them. A charge whose host was pulled first is a dud, and a host a
// charge took out cannot be pulled. The GPU plays the same level through the cast page
// (charges-gpu.test.ts).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type InputEvent, type PhysicsEngine, TIER_FREE } from '@tb/engine-api';
import {
  AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, decodeRecord, Driver, encodeRecord, levelCharges, playShots, readShots, runSession, type Shot, snapshotHash, validateLevel, writeShots,
} from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { CHARGE_LINE, CHARGE_REST_LINE, chargeLevel, MISS } from '../src/charge-level.ts';

const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
const ENGINES: Array<[string, () => PhysicsEngine]> = [['reference', ref], ['rapier', () => new RapierEngine()]];
const c = compileLevel(chargeLevel());
const L0 = 0, R0 = 4, M0 = 8, NEAR = 12, FAR = 13;

async function play(make: () => PhysicsEngine, shots: Shot[], pipelined = false, level = c, bank = true) {
  const d = new Driver(make(), level, { pipelined });
  await d.reset();
  const fireStep = d.engine.stepIndex;
  const r = await playShots(d, shots, 0, { bank });
  return { ...r, d, fireStep };
}
const removes = (evs: readonly InputEvent[]) => evs.flatMap((e) => (e.kind === 'remove' ? [[e.id, e.step]] : []));
const blastsOn = (evs: readonly InputEvent[]) => evs.flatMap((e) => (e.kind === 'blast' && typeof e.blast.centre === 'object' && 'body' in e.blast.centre ? [[e.blast.centre.body, e.step]] : []));

describe('charges on real engines', () => {
  it('the level is laid out as the test assumes, and validates clean on both engines', () => {
    expect(c.meta.n).toBe(14);
    expect([L0, R0, M0, NEAR, FAR].map((i) => c.meta.home[3 * i + 1])).toEqual([0.25, 0.25, 0.25, 0.25, 0.25]);
    expect(levelCharges(c).map((ch) => [ch.host, ch.arm])).toEqual([[L0, 'plunger'], [M0, 'plunger'], [R0, 'plunger'], [NEAR, 'start'], [FAR, 'start']]);
    for (const engine of ['gpu', 'rapier'] as const) expect(validateLevel(c, { engine }).filter((i) => !i.warning)).toEqual([]);
    expect(writeShots(CHARGE_LINE)).toBe('plunger.0.0.1.20.2.45');
  });

  for (const [name, make] of ENGINES) {
    it(`${name}: a 3-event timeline goes in at its steps; a relay it jolts cuts its host; the far relay waits`, async () => {
      const r = await play(make, CHARGE_LINE), S = r.fireStep;
      expect(r.session.phase).not.toBe('running');
      expect(r.session.outcomes.length).toBe(1);
      const ev = r.d.pushed;
      // Cutters: blast then removal, at their steps; the kicker blasts and its host stays.
      expect(blastsOn(ev).filter(([id]) => id === L0 || id === M0 || id === R0)).toEqual([[L0, S], [M0, S + 20], [R0, S + 45]]);
      const rm = removes(ev);
      expect(rm.slice(0, 2)).toEqual([[L0, S], [M0, S + 20]]);
      // The near relay fires after the middle cut, once its host has moved; the far one never.
      const near = rm.find(([id]) => id === NEAR);
      expect(near).toBeDefined();
      expect(near![1]!).toBeGreaterThan(S + 20);
      expect(rm.some(([id]) => id === FAR || id === R0)).toBe(false);
      expect(r.session.cut).toEqual([L0, M0, NEAR]);
      for (const id of [L0, M0, NEAR]) expect(r.snapshot.tier![id]).toBe(TIER_FREE);
      expect(r.snapshot.tier![FAR]).not.toBe(TIER_FREE);
      // The press is free; its yield is the three charges it armed.
      const o = r.session.outcomes[0]!, arms = levelCharges(c);
      expect(o.ke).toBe(0);
      expect(o.yield).toBeCloseTo(arms[0]!.yield + arms[1]!.yield + arms[2]!.yield, 9);
      expect(o.yield).toBeGreaterThan(0);
      // The left column fell (its base cut), so the structure lost energy.
      expect(o.dPE_mJ).toBeGreaterThan(0);
    });

    it(`${name}: the session replays bit for bit, serial and pipelined, and from its encoded record`, async () => {
      const a = await runSession(make(), c, CHARGE_LINE), b = await runSession(make(), c, CHARGE_LINE);
      expect(snapshotHash(b.snapshot)).toBe(snapshotHash(a.snapshot));
      expect(b.steps).toBe(a.steps);
      const p = await runSession(make(), c, CHARGE_LINE, { pipelined: true }), q = await runSession(make(), c, CHARGE_LINE, { pipelined: true });
      expect(snapshotHash(q.snapshot)).toBe(snapshotHash(p.snapshot));
      const rec = decodeRecord(encodeRecord({ v: 1, level: c.def.id, levelHash: c.hash, engine: name, inputs: a.session.inputs }));
      expect(rec.inputs).toEqual(a.session.inputs);
      const shots = readShots(writeShots(rec.inputs.map((i) => i.shot)));
      const again = await runSession(make(), c, shots);
      expect(snapshotHash(again.snapshot)).toBe(snapshotHash(a.snapshot));
    });

    it(`${name}: charges at rest send nothing, and every state is the level's without them, sleep included`, async () => {
      const bare = compileLevel({ ...chargeLevel(), charges: undefined, rack: ['marble'] });
      const armed = compileLevel({ ...chargeLevel(), charges: chargeLevel().charges!.filter((ch) => ch.arm === 'start'), rack: ['marble'] });
      expect(armed.hash).not.toBe(bare.hash);
      const states = async (level: typeof c) => {
        const d = new Driver(make(), level);
        await d.reset();
        const out: string[] = [];
        d.fire(MISS);
        for (let k = 0; k < 240 && d.session.phase === 'running'; k++) {
          await d.step();
          out.push(`${snapshotHash(d.snapshot)}:${[...d.snapshot.awake].join('')}`);
        }
        return { out, d };
      };
      const w = await states(armed), wo = await states(bare);
      expect(w.d.pushed).toEqual([]);
      expect(w.out).toEqual(wo.out);
      // A shot that missed settles; the relays only watching never held it open.
      expect(w.d.session.phase).not.toBe('running');
      expect(w.out.length).toBe(wo.out.length);
    });

    it(`${name}: a checkpoint taken mid-timeline restores to the same end (charges armed, removals pending)`, async () => {
      const whole = await runSession(make(), c, CHARGE_LINE);
      const d = new Driver(make(), c);
      await d.reset();
      d.fire(CHARGE_LINE[0]!);
      for (let k = 0; k < 10; k++) await d.step();
      const cp = d.checkpoint();
      if (!cp) return; // an engine without checkpoints
      const once = await playShots(d, CHARGE_LINE, 1);
      cp.restore();
      const twice = await playShots(d, CHARGE_LINE, 1);
      cp.dispose();
      expect(snapshotHash(once.snapshot)).toBe(snapshotHash(whole.snapshot));
      expect(snapshotHash(twice.snapshot)).toBe(snapshotHash(whole.snapshot));
    });

    it(`${name}: a charge whose host was pulled first is a dud; a host a charge took out cannot be pulled`, async () => {
      const lv = compileLevel({ ...chargeLevel(), rack: ['pull', 'plunger', 'pull'] });
      const r = await play(make, [{ ammo: 'pull', body: L0 }, { ammo: 'plunger', fuse: [[0, 0], [1, 5]] }], false, lv, false);
      // The pull's removal, then the middle cutter's: the left cutter rode a gone host.
      expect(removes(r.d.pushed).slice(0, 1)).toEqual([[M0, r.session.inputs[1]!.step + 5]]);
      expect(blastsOn(r.d.pushed).some(([id]) => id === L0)).toBe(false);
      expect(r.session.cut).toContain(M0);
      expect(r.session.pullRefusal(M0)).toMatch(/charge/);
      expect(() => r.d.fire({ ammo: 'pull', body: M0 })).toThrow(/taken out by a charge/);
    });
  }
});

describe('plunger refusals', () => {
  it('a charge armed at start, named twice, armed before, out of range, or delayed past the settle cap', async () => {
    const lv = compileLevel({ ...chargeLevel(), rack: ['plunger', 'plunger'] });
    const d = new Driver(ref(), lv);
    await d.reset();
    const s = d.session;
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: [[3, 0]] })).toMatch(/armed at start/);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: [[0, 0], [0, 4]] })).toMatch(/named twice/);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: [[9, 0]] })).toMatch(/not one of the level's 5/);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: [[0, 99_999]] })).toMatch(/settle cap/);
    expect(s.plungerRefusal(CHARGE_REST_LINE[0] as never)).toBeNull();
    d.fire(CHARGE_REST_LINE[0]!);
    expect(s.armed).toEqual([2]);
    expect(s.plungerRefusal({ ammo: 'plunger', fuse: [[2, 0]] })).toMatch(/already armed/);
  });
});

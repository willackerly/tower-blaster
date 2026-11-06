// Pulls on real engines (C1, docs/game/undercut-bullet-time.md): a pull takes a
// structure body out, what stood on it falls, the pulled body stays a tombstone
// at its pull pose (so the pull itself earns no collapse), leverage is charged
// the nominal pull energy, and a session of pulls replays bit for bit, serial and
// pipelined, and from its recorded inputs on a plain engine.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type InputEvent, type PhysicsEngine, TIER_FREE } from '@tb/engine-api';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, type LevelDef, leverage, pullEnergy, runSession, type Shot, shotEvent, snapshotHash } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';

/**
 * A crown on a one-cube pedestal beside a five-cube column: pull the pedestal and the crown drops to
 * the ground; pull the column's base and the four cubes above settle one h lower.
 */
const def: LevelDef = {
  id: 'PULL', name: 'pull', version: 1, world: 0, lot: { min: [-6, -6], max: [6, 6] }, crownLine: 1.2, objective: { kind: 'crowns' }, par: 2,
  rack: ['pull', 'pull'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [-3, 0, 0], size: [1, 1, 1], material: 'plaster' },
    { kind: 'block', at: [-3, 1, 0], size: [1, 1, 1], material: 'plaster', role: 'crown' },
    { kind: 'block', at: [2, 0, 0], size: [1, 5, 1], material: 'plaster' },
  ],
};
const c = compileLevel(def);
const pedestal = 0, crown = c.meta.crowns[0]!, columnBase = 2;
const LINE: Shot[] = [{ ammo: 'pull', body: columnBase }, { ammo: 'pull', body: pedestal }];
const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
const ENGINES: Array<[string, () => PhysicsEngine]> = [['reference', ref], ['rapier', () => new RapierEngine()]];

describe('pull on real engines', () => {
  it('the level is laid out as the test assumes', () => {
    expect(c.meta.n).toBe(7);
    expect(crown).toBe(1);
    expect(c.meta.home[3 * columnBase + 1]).toBeCloseTo(0.25, 9);
  });

  for (const [name, make] of ENGINES) {
    it(`${name}: the column drops one h, then the crown falls and the level clears; the pulled bodies stay put as tombstones`, async () => {
      const r = await runSession(make(), c, LINE);
      expect(r.session.phase).toBe('cleared');
      expect(r.session.pulled).toEqual([columnBase, pedestal]);
      const [first, second] = r.session.outcomes;
      // Four plaster cubes (31.25 kg) one h (0.5 m) lower: 4 m g h, within a few mm of settling.
      const fourDrop = 4 * 31.25 * 9.81 * 0.5 * 1000;
      expect(first!.dPE_mJ / fourDrop).toBeGreaterThan(0.98);
      expect(first!.dPE_mJ / fourDrop).toBeLessThan(1.02);
      expect(first!.ke).toBe(pullEnergy(c.frame));
      expect(first!.leverage).toBeCloseTo(leverage(first!.dPE_mJ, pullEnergy(c.frame)), 12);
      expect(first!.crownsDown).toBe(0);
      expect(second!.crownsDown).toBe(1);
      for (const b of [columnBase, pedestal]) {
        expect(r.snapshot.tier?.[b]).toBe(TIER_FREE);
        // A tombstone keeps the pose it had when pulled (after the pre-settle), so its potential never changes.
        expect(r.snapshot.pos[3 * b + 1]).toBeCloseTo(c.meta.home[3 * b + 1]!, 2);
      }
    });
  }

  it('reference: replays bit for bit, serial and pipelined each, and from its recorded inputs on a plain engine', async () => {
    const a = await runSession(ref(), c, LINE), b = await runSession(ref(), c, LINE);
    expect(snapshotHash(b.snapshot)).toBe(snapshotHash(a.snapshot));
    expect(b.steps).toBe(a.steps);
    const p = await runSession(ref(), c, LINE, { pipelined: true }), q = await runSession(ref(), c, LINE, { pipelined: true });
    expect(snapshotHash(q.snapshot)).toBe(snapshotHash(p.snapshot));
    expect(p.session.phase).toBe('cleared');
    // The session's inputs alone (removals at their steps) rebuild the end state on a bare engine.
    const inputs: InputEvent[] = a.session.inputs.map(({ step, shot }) => shotEvent(c.frame, shot, step)!);
    expect(inputs.map((e) => e.kind)).toEqual(['remove', 'remove']);
    const e = ref();
    await e.init({ ...c.scene, inputs });
    while (e.stepIndex < a.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(a.snapshot));
    e.dispose();
  });
});

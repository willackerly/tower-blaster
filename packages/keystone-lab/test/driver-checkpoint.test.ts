// Driver.checkpoint() (the game's undo): the engine's checkpoint and a copy of everything the driver
// keeps (session, observer, weapons' fuses, spawns, the pipelined read). Restored, a driver plays on
// exactly as the one that never left: from a checkpoint taken while aiming, the kept line ends where a
// fresh session of it ends; from one taken mid-shot (a cluster's fuses still burning), firing the same
// rapid-fire shot again gives the same state as the first time, and firing nothing lets the shot play
// out to the state a session of it alone settles at. Serial and pipelined, on Rapier.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, Driver, type DriverCheckpoint, L1, type LevelDef, playShots, runSession, type Shot, snapshotHash } from '@tb/keystone';

const def: LevelDef = { ...L1, rack: [...L1.rack, 'w-cluster', 'w-firework'] };
const c = compileLevel(def);
/** A marble well wide of the tower, a cluster bomb into it, then L1's par cannonball. */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const clus: Shot = { ammo: 'w-cluster', az: 360, y: 8, yaw: 0, pitch: 176, power: 30 };
const fire: Shot = { ammo: 'w-firework', az: 360, y: 8, yaw: 0, pitch: 176, power: 30 };
const par = L1.solutions!.par![0]! as Shot;

/** Everything a restored driver must reproduce. */
const state = (d: Driver) => ({
  step: d.engine.stepIndex, snapshotStep: d.snapshotStep, hash: snapshotHash(d.snapshot), count: d.snapshot.count,
  phase: d.session.phase, strokes: d.session.strokes, rackLeft: [...d.session.rackLeft], score: d.session.score,
  outcomes: JSON.stringify(d.session.outcomes), inputs: JSON.stringify(d.session.inputs), pushed: d.pushed.length, bodies: d.bodies.length,
  crowns: [...d.session.crownLive], heritage: [...d.session.heritageBroken],
});
async function settle(d: Driver) {
  while (d.session.phase === 'running') await d.step();
  await d.drain();
}

describe.each([false, true])('Driver.checkpoint (pipelined %s)', (pipelined) => {
  it('taken while aiming before shot 2: after another shot 2, restored, the line plays on exactly as a fresh session of it', async () => {
    const want = new Driver(new RapierEngine(), c, { pipelined });
    await want.reset();
    await playShots(want, [miss, clus, par], 0, { bank: false });

    const d = new Driver(new RapierEngine(), c, { pipelined });
    await d.reset();
    let cp: DriverCheckpoint | null = null, at: ReturnType<typeof state> | null = null;
    await playShots(d, [miss, fire], 0, { bank: false, onAiming: (x, next) => { if (next === 1) { cp = x.checkpoint(); at = state(x); } } });
    expect(cp).not.toBeNull();
    const thrown = state(d);
    expect(thrown.hash).not.toBe(state(want).hash);
    for (let r = 0; r < 2; r++) {
      cp!.restore();
      expect(state(d)).toEqual(at);
      await playShots(d, [miss, clus, par], 1, { bank: false });
      expect(state(d)).toEqual(state(want));
    }
    cp!.dispose();
    expect(() => cp!.restore()).toThrow(/disposed checkpoint/);
    want.engine.dispose(); d.engine.dispose();
  });

  it('taken mid-shot with fuses burning: the same rapid shot again gives the same state; no shot lets the first play out as alone', async () => {
    const alone = await runSession(new RapierEngine(), c, [clus], { pipelined, bank: false });
    const d = new Driver(new RapierEngine(), c, { pipelined });
    await d.reset();
    d.fire(clus);
    for (let i = 0; i < 12; i++) await d.step();
    expect(d.session.phase).toBe('running');
    const cp = d.checkpoint()!, at = state(d);
    d.fire(par);
    await settle(d);
    const first = state(d);
    expect(first.strokes).toBe(2);
    cp.restore();
    expect(state(d)).toEqual(at);
    d.fire(par);
    await settle(d);
    expect(state(d)).toEqual(first);
    cp.restore();
    await settle(d);
    expect({ step: d.engine.stepIndex, hash: snapshotHash(d.snapshot), strokes: d.session.strokes, phase: d.session.phase }).toEqual({ step: alone.steps, hash: snapshotHash(alone.snapshot), strokes: 1, phase: alone.session.phase });
    // The cluster's children were spawned by its fuses after the checkpoint, in both futures.
    expect(d.bodies.length).toBeGreaterThan(at.bodies);
    cp.dispose();
    d.engine.dispose();
  });
});

describe('Driver.checkpoint on an engine without one', () => {
  it('is null', async () => {
    const d = new Driver(new RapierEngine(), c);
    await d.reset();
    (d.engine as { checkpoint?: unknown }).checkpoint = undefined;
    expect(d.checkpoint()).toBeNull();
    d.engine.dispose();
  });
});

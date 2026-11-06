// Bullet Time's freeze on a real engine (C2, docs/game/undercut-bullet-time.md). A freeze is rapid
// fire with the clock stopped: the game stops stepping, the player aims at the world as drawn
// (Driver.snapshot), and the shot goes in through the cut path at the frozen step, recorded `@n`.
// So a frozen line replays bit for bit from its text, on a serial and a pipelined driver alike, with
// no drain and no second replay path; and a line that asks for more cuts than the level's budget
// fires the rest from aiming, as a line without `after`.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, Driver, L1, type LaunchShot, type LevelDef, playShots, PRESETTLE_STEPS, readShots, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';

const par = L1.solutions!.par![0]! as LaunchShot;
/** L1 scored on outcome (so it plays on past its clear), with one freeze. */
const def: LevelDef = { ...L1, scoring: 'outcome', freeze: 1 };
const c = compileLevel(def);
/** The par cannonball, a second down the same line frozen in 20 steps later, then a marble. */
const second: Shot = { ...par };
const marble: LaunchShot = { ...par, ammo: 'marble', power: 40 };

/** The game's loop, headless: step to 20 steps after the first shot, freeze (read the world as the
 * renderer and the aim do, many frames, nothing stepped), fire into it, and play on. */
async function frozen(pipelined: boolean) {
  const d = new Driver(new RapierEngine(), c, { pipelined });
  await d.reset();
  d.fire(par);
  while (d.engine.stepIndex < PRESETTLE_STEPS + 20) await d.step();
  const before = snapshotHash(d.snapshot), at = d.engine.stepIndex, collapse = d.session.liveCollapse;
  for (let frame = 0; frame < 120; frame++) {
    expect(snapshotHash(d.snapshot)).toBe(before);
    expect(d.session.liveCollapse).toBe(collapse);
  }
  expect(d.engine.stepIndex).toBe(at);
  expect(d.session.freezesLeft).toBe(1);
  const fb = d.fire(second);
  expect(fb.map((f) => f.t)).toEqual(['cut', 'fired']);
  expect(d.session.freezesLeft).toBe(0);
  const line = [par, second, marble];
  const r = await playShots(d, line, 2);
  return { r, text: writeShots(r.session.inputs.map((i) => i.shot)) };
}

describe('freeze (Bullet Time) on Rapier', () => {
  for (const pipelined of [false, true]) {
    it(`${pipelined ? 'pipelined' : 'serial'}: a frozen line is recorded @n and replays bit for bit from its text`, async () => {
      const live = await frozen(pipelined);
      expect(live.text).toBe(writeShots([par, { ...second, after: 20 }, marble]));
      const again = await runSession(new RapierEngine(), c, readShots(live.text), { pipelined });
      expect(again.session.inputs).toEqual(live.r.session.inputs);
      expect(again.steps).toBe(live.r.steps);
      expect(again.session.outcomes).toEqual(live.r.session.outcomes);
      expect(again.session.score).toEqual(live.r.session.score);
      expect(snapshotHash(again.snapshot)).toBe(snapshotHash(live.r.snapshot));
      expect(live.r.session.outcomes.map((o) => o.cut ?? false)).toEqual([true, false, false]);
    }, 60_000);
  }

  it('the frozen shot goes in at the same engine step serial and pipelined', async () => {
    const serial = await frozen(false), piped = await frozen(true);
    expect(piped.r.session.inputs.slice(0, 2)).toEqual(serial.r.session.inputs.slice(0, 2));
    // The shot after a settle starts one step later pipelined, as every shot fired from aiming does (DriverOptions.pipelined).
    expect(piped.r.session.inputs[2]!.step).toBe(serial.r.session.inputs[2]!.step + 1);
  }, 60_000);

  it('past the budget a timed shot waits for the settle and goes in from aiming, recorded without `after`', async () => {
    const r = await runSession(new RapierEngine(), c, [par, { ...second, after: 20 }, { ...marble, after: 5 }]);
    expect(r.session.inputs.map((i) => i.shot.after)).toEqual([undefined, 20, undefined]);
    expect(r.session.outcomes.map((o) => o.cut ?? false)).toEqual([true, false, false]);
    expect(r.session.freezesLeft).toBe(0);
  }, 60_000);
});

// Chorus (M9, keystone chorus.ts) through the Driver on Rapier: the round waits for every world to settle,
// its levelEnd carries the score of every world, a world played alone (only: k) is the solo run the verify
// compares with, and the game's undo checkpoint restores all the worlds. Pipelined and serial.
// The verify itself (islands against 64 solo runs) is chorus-verify.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { ChorusEngine, compileLevel, Driver, type DriverCheckpoint, type Feedback, playShots, runSession } from '@tb/keystone';
import { openFire, SHOT } from './chorus-fixture.ts';


describe.each([false, true])('a Chorus round on the Driver (pipelined %s)', (pipelined) => {
  it('waits for every world, then ends with the score of every world', async () => {
    const c = compileLevel(openFire(8)), e = new ChorusEngine(new RapierEngine(), c);
    const r = await runSession(e, c, [SHOT], { pipelined });
    const j = e.judge();
    expect(j.worlds).toBe(8);
    expect(j.leaks).toBe(0);
    expect(e.settleHold()).toBe(false);
    const score = r.session.score!;
    expect(score.worlds).toEqual({ cleared: j.clears, of: 8, thresholds: [4, 6, 8] });
    expect(score.stamp).toBe(`${j.clears}/8 CLEAR`);
    expect(score.gold).toBe(false);
    const end = r.feedback.filter((f): f is Extract<Feedback, { t: 'levelEnd' }> => f.t === 'levelEnd');
    expect(end).toHaveLength(1);
    expect(end[0]!.score).toBe(score);
    expect(end[0]!.cleared).toBe(score.stars > 0);
    // World 0 alone would have ended sooner or at the same step: the hold only ever waits.
    const hero = await runSession(new RapierEngine(), compileLevel({ ...openFire(8), chorus: undefined }), [SHOT], { pipelined });
    expect(r.steps).toBeGreaterThanOrEqual(hero.steps);
    e.dispose();
  });

  it('world 0 played alone is the level played without Chorus: the structure ends bit for bit the same', async () => {
    const c = compileLevel(openFire(8)), plain = compileLevel({ ...openFire(8), chorus: undefined });
    const e = new ChorusEngine(new RapierEngine(), c, { only: 0 });
    const d = new Driver(e, c, { pipelined }), p = new Driver(new RapierEngine(), plain, { pipelined });
    await d.reset();
    await p.reset();
    await playShots(d, [SHOT], 0, {});
    await playShots(p, [SHOT], 0, {});
    const n = c.meta.n;
    expect([...d.snapshot.pos.subarray(0, 3 * n)]).toEqual([...p.snapshot.pos.subarray(0, 3 * n)]);
    expect(e.judge().worlds).toBe(1);
  });

  it('restores every world from the undo checkpoint: the shot fired again ends as it did', async () => {
    const c = compileLevel(openFire(4)), e = new ChorusEngine(new RapierEngine(), c);
    const d = new Driver(e, c, { pipelined });
    await d.reset();
    const cp: DriverCheckpoint = d.checkpoint()!;
    await playShots(d, [SHOT], 0, {});
    const first = e.judge();
    cp.restore();
    await playShots(d, [SHOT], 0, {});
    expect(e.judge()).toEqual(first);
    cp.dispose();
  });
});

describe('a refereed duel never takes the Chorus path', () => {
  it('a plain engine passes its score through', async () => {
    const c = compileLevel({ ...openFire(4), chorus: undefined });
    const r = await runSession(new RapierEngine(), c, [SHOT], { refereed: true });
    expect(r.session.score?.worlds).toBeUndefined();
    expect(r.session.score?.refereed).toBe(true);
  });
});

// Aftershock's quake through the Driver and Session on the reference engine (M7, docs/game/aftershock.md): the
// quake goes in as its field events and the shot holds open until it ends; a replay is bit for bit, and so is a
// checkpoint taken mid-quake and restored; protected towers are judged standing at the settle (a tower that rocked
// and stood is spared, where the pose rule would have broken it); and on Short Sharp Shock the design search's best
// quake clears the level where the brute-force one fails (the gate's claim, on one build). The GPU solver's side
// is quake-gpu.test.ts.
import { describe, expect, it } from 'vitest';
import { compileLevel, Driver, forkDeep, type LevelDef, naiveQuake, playShots, quakeCandidate, quakeInputs, quakeSteps, snapshotHash } from '@tb/keystone';
import { makeEngine } from '../src/engines.ts';
import { nudgeLevel, playQuakes, quake, siteTops } from '../src/quake-search.ts';

const SHOCK = quakeCandidate('QC-4');
/** A quake inside Short Sharp Shock's window (quake-search; docs/game/mode-probes.md, X6 "On levels"): 0.6 g at 1 Hz for 1.5 s. */
const BEST = quake(60, 10, 15, 0);

async function play(level: LevelDef, shot = BEST) {
  const c = compileLevel(level), d = new Driver(makeEngine({ kind: 'ref' }), c);
  await d.reset();
  const fired = d.snapshotStep;
  const r = await playShots(d, [shot], 0);
  return { c, d, r, fired };
}

describe('the quake on the reference engine', () => {
  it('goes in as its field events, and the shot holds open until the quake has ended', async () => {
    const { c, d, r, fired } = await play(SHOCK);
    expect(d.pushed.filter((e) => e.kind === 'field')).toEqual(quakeInputs(c, BEST, fired));
    const o = r.session.outcomes[0]!;
    expect(o.spawnStep).toBe(fired);
    expect(o.settleStep).toBeGreaterThanOrEqual(fired + quakeSteps(BEST, c.scene.dt));
    expect(d.quakeEnd).toBe(fired + quakeSteps(BEST, c.scene.dt));
    expect(r.session.phase).toBe('cleared');
  }, 60_000);

  it('replays bit for bit, and a copy taken mid-quake plays on to the same end', async () => {
    const a = await play(SHOCK), b = await play(SHOCK);
    expect(snapshotHash(b.r.snapshot)).toBe(snapshotHash(a.r.snapshot));
    expect(b.r.steps).toBe(a.r.steps);
    // The reference engine has no checkpoint(): the game's undo path is the GPU's (quake-gpu.test.ts). A deep copy
    // of the driver mid-quake (the cast's fork) carries the quake's pending keys and its hold.
    const c = compileLevel(SHOCK), d = new Driver(makeEngine({ kind: 'ref' }), c);
    await d.reset();
    d.fire(BEST);
    for (let i = 0; i < 40; i++) await d.step();
    const copy = forkDeep(d, [c, ...c.scene.bodies]);
    const r = await playShots(copy, [], 0);
    expect(snapshotHash(r.snapshot)).toBe(snapshotHash(a.r.snapshot));
    expect(r.session.outcomes).toEqual(a.r.session.outcomes);
  }, 120_000);

  it('judges protected towers standing at the settle: the tall one rocks past the pose rule and still stands', async () => {
    const standing = await play(SHOCK), pose = await play({ ...SHOCK, heritage: 'pose' });
    expect(standing.r.session.heritageBroken.reduce((a, x) => a + x, 0)).toBe(0);
    // The same quake under the pose rule: the 8-cube column swings its top more than 0.3 h on the way.
    expect(pose.r.session.heritageBroken.reduce((a, x) => a + x, 0)).toBeGreaterThan(0);
    expect(pose.r.session.objectiveDone).toBe(false);
    // Only the judging differs: the world ends the same.
    expect(snapshotHash(pose.r.snapshot)).toBe(snapshotHash(standing.r.snapshot));
  }, 120_000);

  it('Short Sharp Shock: the best quake clears it on a nudged build; the naive one and a long quake fell the tall towers', async () => {
    const c = compileLevel(SHOCK), naive = naiveQuake(c), long = quake(55, 10, 60, 0);
    expect(siteTops(c).length).toBe(4);
    const ends = await playQuakes(SHOCK, [BEST, naive, long], 3);
    expect(ends.map((e) => e.met)).toEqual([true, false, false]);
    // Condemned (0, 2) down and protected (1, 3) standing for the best; the naive and the long quake fell everything slender.
    expect(ends[0]!.down).toEqual([true, false, true, false]);
    expect(ends[0]!.standing).toEqual([false, true, false, true]);
    expect(ends[1]!.standing[1]).toBe(false);
    expect(ends[2]!.standing[1] && ends[2]!.standing[3]).toBe(false);
  }, 180_000);

  it('a nudged build moves every body a hair, pins none, and keeps the hash', () => {
    const c = compileLevel(SHOCK), n = nudgeLevel(c, 2);
    expect(n.hash).toBe(c.hash);
    let worst = 0;
    n.scene.bodies.forEach((b, i) => { worst = Math.max(worst, Math.hypot(b.pos[0] - c.scene.bodies[i]!.pos[0], b.pos[2] - c.scene.bodies[i]!.pos[2])); expect(b.pos[1]).toBe(c.scene.bodies[i]!.pos[1]); });
    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(Math.SQRT2 * 1e-3);
  });
});

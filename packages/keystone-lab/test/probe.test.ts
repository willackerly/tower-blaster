import { afterAll, describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, L1, type Shot, snapshotHash } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { B1, B3, CASES, candidates, engineSubsteps, inlineRunner, labArgs, makeEngine, makeRunner, nudge, poolRunner, POWER_NUDGES, RAPIER_SUBSTEPS, runProbe, solveOneShot, YAW_NUDGES } from '@tb/keystone-lab';

describe('nudge', () => {
  const launch: Shot = { ammo: 'marble', az: 10, y: 4, yaw: 5, pitch: 100, power: 99 };
  it('moves launch shots in yaw and power, clamping power to 0..100', () => {
    expect(nudge(launch, -6, 3)).toEqual({ ...launch, yaw: -1, power: 100 });
    expect(nudge(launch, 0, 0)).toEqual(launch);
  });
  it('moves cues sideways by at most a quarter cell and drops in x and z', () => {
    const cue: Shot = { ammo: 'cue', x: 0, y: 4, z: -2, dir: 2, power: 50 };
    expect(nudge(cue, 6, -3)).toEqual({ ...cue, x: 1, power: 47 });
    expect(nudge(cue, 2, 0)).toEqual(cue);
    expect(nudge({ ammo: 'drop', x: 4, z: 4 }, -4, 3)).toEqual({ ammo: 'drop', x: 3, z: 5 });
  });
});

describe('lab engines', () => {
  it('builds Rapier and the reference (at AVBD_ITERATIONS and AVBD_GAP_SLOP unless told otherwise)', () => {
    expect(makeEngine({ kind: 'rapier' })).toBeInstanceOf(RapierEngine);
    const ref = makeEngine({ kind: 'ref' });
    expect(ref).toBeInstanceOf(AvbdReferenceEngine);
    expect(ref.info.variant.iterations).toBe(AVBD_ITERATIONS);
    expect(ref.info.variant.gapSlop).toBe(AVBD_GAP_SLOP);
    expect(makeEngine({ kind: 'ref', gapSlop: 0 }).info.variant.gapSlop).toBeUndefined();
    expect(makeEngine({ kind: 'ref', iterations: 7 }).info.variant.iterations).toBe(7);
  });
  it('aims with each engine\'s substeps', () => {
    expect(engineSubsteps({ kind: 'rapier' })).toBe(RAPIER_SUBSTEPS);
    expect(engineSubsteps({ kind: 'ref' })).toBe(1);
    // The aim differs between the two, so a case must not reuse Rapier's shots on the reference.
    expect(B1.shots(1)).not.toEqual(B1.shots(RAPIER_SUBSTEPS));
    expect(candidates(L1, { substeps: 1 }).length).toBe(candidates(L1).length);
  });
  it('reads --engine, --iterations and --jobs, leaving other flags and ids', () => {
    expect(labArgs(['L1', '--engine', 'ref', '--iterations', '30', '--jobs', '3', '--shots', '2', 'L2'], 8)).toEqual({
      spec: { kind: 'ref', iterations: 30 }, jobs: 3, flags: new Map([['engine', 'ref'], ['iterations', '30'], ['jobs', '3'], ['shots', '2']]), ids: ['L1', 'L2'],
    });
    expect(labArgs([], 8)).toMatchObject({ spec: { kind: 'rapier' }, jobs: 8, ids: [] });
    expect(() => labArgs(['--engine', 'gpu'], 1)).toThrow(/unknown engine gpu/);
    expect(() => labArgs(['--jobs', '0'], 1)).toThrow(/--jobs/);
    expect(labArgs(['--engine', 'ref', '--gap-slop', '0'], 1).spec).toEqual({ kind: 'ref', gapSlop: 0 });
    expect(() => labArgs(['--gap-slop', '1e-5'], 1)).toThrow(/--engine ref/);
    expect(() => labArgs(['--engine', 'ref', '--gap-slop', '-1'], 1)).toThrow(/metres >= 0/);
  });
});

describe('runners', () => {
  const rapier = { kind: 'rapier' } as const;
  const pool = poolRunner(rapier, 3);
  afterAll(() => pool.close());
  it('a worker pool gives exactly the inline results, whatever order jobs finish in', async () => {
    const inline = inlineRunner(rapier);
    const [a, b] = await Promise.all([runProbe(B3, inline), runProbe(B3, pool)]);
    expect(b.grid).toEqual(a.grid);
    expect(b.successRate).toBe(a.successRate);
    const shots = B3.shots(RAPIER_SUBSTEPS);
    const [x, y] = await Promise.all([inline.play(B3.level, shots), pool.play(B3.level, shots)]);
    expect(snapshotHash(y.snapshot)).toBe(snapshotHash(x.snapshot));
    expect(y).toEqual(x);
  }, 300_000);
  it('the bot finds the same solutions on a pool', async () => {
    const cands = candidates(L1).slice(0, 12);
    const inline = await solveOneShot(L1, inlineRunner(rapier), cands), pooled = await solveOneShot(L1, pool, cands);
    expect(pooled).toEqual(inline);
  }, 300_000);
  it('the reference plays the same in a worker as in this thread', async () => {
    const ref = { kind: 'ref', iterations: 4 } as const, refPool = makeRunner(ref, 2), shots = B1.shots(1);
    try {
      const [x, y] = await Promise.all([inlineRunner(ref).play(B1.level, shots), refPool.play(B1.level, shots)]);
      expect(y).toEqual(x);
    } finally {
      await refPool.close();
    }
  }, 300_000);
  it('a closed pool refuses new work', async () => {
    const p = poolRunner(rapier, 1);
    await p.close();
    await expect(p.play(B3.level, [])).rejects.toThrow(/closed/);
  });
});

describe('mechanics probe', () => {
  it('runs a case over the full nudge grid', async () => {
    const r = await runProbe(B3, inlineRunner({ kind: 'rapier' }));
    expect(r.grid).toHaveLength(YAW_NUDGES.length);
    expect(r.grid.every((row) => row.length === POWER_NUDGES.length)).toBe(true);
    expect(r.successRate).toBeGreaterThanOrEqual(0);
  });
  // The kill gate from the design: at least 3 of the 6 loose-stack
  // behaviours must survive the nudges. About 30 s, so opt-in.
  it.runIf(process.env.KEYSTONE_SLOW === '1')('passes the gate: at least 3 behaviours robust on Rapier', async () => {
    const runner = makeRunner({ kind: 'rapier' });
    try {
      const results = [];
      for (const pc of CASES) results.push(await runProbe(pc, runner));
      expect(results.filter((r) => r.successRate >= 0.8).length).toBeGreaterThanOrEqual(3);
    } finally {
      await runner.close();
    }
  }, 300_000);
});

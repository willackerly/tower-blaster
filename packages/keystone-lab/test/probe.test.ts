import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { Shot } from '@tb/keystone';
import { B3, CASES, nudge, POWER_NUDGES, runProbe, YAW_NUDGES } from '@tb/keystone-lab';

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

describe('mechanics probe', () => {
  it('runs a case over the full nudge grid', async () => {
    const r = await runProbe(B3, () => new RapierEngine());
    expect(r.grid).toHaveLength(YAW_NUDGES.length);
    expect(r.grid.every((row) => row.length === POWER_NUDGES.length)).toBe(true);
    expect(r.successRate).toBeGreaterThanOrEqual(0);
  });
  // The kill gate from the design: at least 3 of the 6 loose-stack
  // behaviours must survive the nudges. About 30 s, so opt-in.
  it.runIf(process.env.KEYSTONE_SLOW === '1')('passes the gate: at least 3 behaviours robust on Rapier', async () => {
    const results = [];
    for (const pc of CASES) results.push(await runProbe(pc, () => new RapierEngine()));
    expect(results.filter((r) => r.successRate >= 0.8).length).toBeGreaterThanOrEqual(3);
  }, 300_000);
});

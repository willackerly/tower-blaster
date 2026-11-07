// The ice trials need more than their opener (agent playtest 2, PT38: one cannonball brought T-I1 and T-I2
// 100% down, so the rest of the rack did nothing). Their racks lead with marbles (keystone ICE_RACK) and the
// structures are stout enough that a first visit's opener (the first item, clicked at the middle of the
// screen, which lands on the structure's middle) does not clear them, from any side. The cannonball after it
// still brings most of each down, so the rack has a finisher.
//
// Shots: the game's own aim (aimAt down to -80 degrees, 4 substeps) from the high launcher (2 h over the
// top, aim.ts launchRange), at full power, from 8 sides, at 30%, 50% and 75% of the height on the lot's
// centre line. Rapier for the sweep; the f64 reference (the GPU solver's algorithm) at the middle.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { aimAt, compileLevel, type CompiledLevel, ICE_RACK, type LaunchItem, runSession, TRIAL_LEVELS } from '@tb/keystone';

const SIDES = [0, 90, 180, 270, 360, 450, 540, 630]; // azimuth quanta (half degrees)
const level = (id: string) => compileLevel(TRIAL_LEVELS.find((d) => d.id === id)!);

async function fire(c: CompiledLevel, ammo: LaunchItem, az: number, share: number, engine: 'rapier' | 'ref') {
  const y = Math.max(Math.round(c.frame.launcher.y * 4), Math.ceil(4 * (c.height / c.frame.unit + 2)));
  const centre: [number, number, number] = [(c.lot.min[0] + c.lot.max[0]) / 2, share * c.height, (c.lot.min[1] + c.lot.max[1]) / 2];
  const a = aimAt(c.frame, ammo, { az, y, power: 100 }, centre, { substeps: 4, minPitch: -80 });
  expect(a.error).toBeLessThan(0.1 * c.frame.unit); // the shot reaches the structure
  const r = await runSession(engine === 'rapier' ? new RapierEngine() : new AvbdReferenceEngine(), c, [a.shot]);
  const o = r.session.outcomes[0]!;
  return { cleared: r.session.phase === 'cleared', collapse: r.session.collapse(o.pe_mJ), crowns: o.crownsTotal };
}

describe('ice trials (PT38)', () => {
  it('T-I1 and T-I2 lead with marbles, the cannonball third', () => {
    for (const id of ['T-I1', 'T-I2']) expect(TRIAL_LEVELS.find((d) => d.id === id)!.rack, id).toEqual([...ICE_RACK]);
    expect(ICE_RACK.slice(0, 3)).toEqual(['marble', 'marble', 'cannonball']);
  });

  for (const id of ['T-I1', 'T-I2']) {
    it(`${id}: the opener (a marble at the middle) clears it from no side, on Rapier or the reference; a marble anywhere rarely does`, async () => {
      const c = level(id);
      const rows: string[] = [];
      let anywhere = 0;
      for (const az of SIDES) for (const share of [0.3, 0.5, 0.75]) {
        const r = await fire(c, 'marble', az, share, 'rapier');
        rows.push(`${az}/${share}: ${r.collapse.toFixed(2)} ${r.crowns}${r.cleared ? ' cleared' : ''}`);
        if (share === 0.5) expect(r.cleared, `rapier ${rows.at(-1)}`).toBe(false);
        if (r.cleared) anywhere++;
      }
      // Measured: T-I1 4 of 24 (a marble along the crown course), T-I2 0 of 24.
      expect(anywhere, rows.join('; ')).toBeLessThanOrEqual(6);
      for (const az of [0, 90]) {
        const r = await fire(c, 'marble', az, 0.5, 'ref');
        expect(r.cleared, `ref ${az}: ${JSON.stringify(r)}`).toBe(false);
      }
    }, 300_000);

    it(`${id}: the cannonball at the middle brings most of it down (the rack's finisher)`, async () => {
      const c = level(id);
      const got = await Promise.all(SIDES.map((az) => fire(c, 'cannonball', az, 0.5, 'rapier')));
      // Measured on Rapier: T-I1 collapse 0.75-1.0, T-I2 0.55-1.0.
      expect(Math.min(...got.map((g) => g.collapse)), JSON.stringify(got)).toBeGreaterThan(0.5);
      expect(got.filter((g) => g.cleared).length, JSON.stringify(got)).toBeGreaterThanOrEqual(4);
    }, 300_000);
  }
});

// Every rack item fires on the game page under Keystone rules (roadmap G3, spectacle-mode.md
// section 7): one load per rack of up to MAX_RACK items, each shot aimed away from the tower so
// none brings a crown down; each is fired, flies, settles and leaves the rack, the grenade's
// blast goes off once, the level fails when the rack is empty, and the page ends where
// runSession ends the same line headless and where its own replay ends it. Rapier.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { AMMO_KINDS, compileLevel, isLaunchItem, L1, MAX_RACK, type RackItem, runSession, type Shot, snapshotHash, writeShots } from '@tb/keystone';
import { BUILTIN_WEAPONS, PRESET_NAMES } from '@tb/weapons';
import { launchY } from '../src/aim.ts';
import { driverOptions } from '../src/engines.ts';
import { gamePage } from './page.ts';

const game = gamePage();

/** Two loads that between them fire every item once (L1 has no weapons of its own: w-grenade is KEYSTONE_GRENADE, the others @tb/weapons' built-ins). */
const RACKS: RackItem[][] = [
  ['marble', 'cannonball', 'drop', 'w-grenade', 'p-beachball', 'p-bowlingball', 'p-wreckingball', 'p-boulder'],
  ['cue', 'p-basketball', 'p-cannonball', 'w-firework', 'w-cluster'],
];

/** A miss: launched sideways from azimuth 0 (clear of the ground, however big), or a drop or cue push 20 cells off the lot. */
function miss(c: ReturnType<typeof compileLevel>, ammo: RackItem): Shot {
  if (ammo === 'drop') return { ammo, x: 80, z: 80 };
  if (ammo === 'cue') return { ammo, x: 80, y: 2, z: 80, dir: 0, power: 50 };
  if (!isLaunchItem(ammo)) throw new Error(ammo);
  return { ammo, az: 0, y: launchY(c, ammo), yaw: 900, pitch: 300, power: 100 };
}

describe('every rack item on the game page', () => {
  it('the racks hold every item once, and no more than MAX_RACK each', () => {
    expect(RACKS.flat().sort()).toEqual([...AMMO_KINDS, ...PRESET_NAMES.map((p) => `p-${p}`), 'w-grenade', ...Object.keys(BUILTIN_WEAPONS).map((k) => `w-${k}`)].sort());
    for (const r of RACKS) expect(r.length).toBeLessThanOrEqual(MAX_RACK);
  });

  for (const rack of RACKS) {
    it(`fires ${rack.join(', ')}: each settles, the level fails with the rack empty, and the page replays it (Rapier)`, async (ctx) => {
      if (!game.browser()) return ctx.skip();
      const c = compileLevel({ ...L1, rack });
      const line = rack.map((a) => miss(c, a));
      const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&keystone.rack=${rack.join(',')}&keystone.shots=${writeShots(line)}`);
      if (!o) return ctx.skip();
      const { page, errors } = o;
      await page.evaluate(() => { window.__game.fast = true; });
      await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 240_000, polling: 100 });
      const live = await page.evaluate(() => window.__game.state());
      const r = await runSession(new RapierEngine(), c, line, driverOptions('rapier'));
      expect(r.session.phase).toBe('failed');
      expect(r.session.rackLeft).toEqual([]);
      expect(r.session.outcomes.map((x) => x.crownsDown)).toEqual(line.map(() => 0));
      expect(live).toEqual({ step: r.steps, phase: 'failed', strokes: line.length, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
      const counts = await page.evaluate(() => window.__game.counts);
      // Every blast a weapon can set off goes off (each built-in's munitions all blast before they go).
      const blasts = rack.reduce((a, x) => a + (c.arms[x]?.blasts.reduce((b, y) => b + y.count, 0) ?? 0), 0);
      expect(blasts).toBe(rack.includes('w-grenade') ? 1 : 12 + 6);
      expect({ fired: counts.fired, blast: counts.blast ?? 0 }).toEqual({ fired: line.length, blast: blasts });
      expect(await page.evaluate((s) => window.__game.replay(s), line)).toEqual(live);
      expect(errors).toEqual([]);
      await page.close();
    }, 300_000);
  }
});

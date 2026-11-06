// The rack's weapons held to the device tier on the game page (roadmap C12 step 4,
// docs/design/weapon-editor.md): with keystone.tier=mid the XL grenade (16 grenades of energy, over
// mid's 8) is refused on fire with a banner naming the tier that fires it, and nothing is fired; a
// marble from the same rack fires. Without keystone.tier (high) the XL fires (rack-e2e.test.ts). Rapier.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, type Shot } from '@tb/keystone';
import { launchY } from '../src/aim.ts';
import { gamePage, ready } from './page.ts';

const game = gamePage();
const RACK = ['w-grenadexl', 'marble'] as const;

describe('a weapon over the device tier', () => {
  it('is refused on fire with a banner; the rest of the rack fires', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&offscreen=1&engine=rapier&keystone.rack=${RACK.join(',')}&keystone.tier=mid`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    const c = compileLevel({ ...L1, rack: [...RACK] });
    const miss = (ammo: 'w-grenadexl' | 'marble'): Shot => ({ ammo, az: 0, y: launchY(c, ammo), yaw: 900, pitch: 300, power: 100 });
    expect(await page.evaluate((s) => window.__game.fire(s), miss('w-grenadexl'))).toBe(false);
    expect(await page.textContent('#banner')).toMatch(/^w-grenadexl not fired: 16\.00 grenades a shot is over the mid tier's cap of 8 \(it needs high\)$/);
    expect(await page.evaluate(() => window.__game.strokes)).toBe(0);
    expect(await page.evaluate((s) => window.__game.fire(s), miss('marble'))).toBe(true);
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 30_000 });
    expect(errors).toEqual([]);
    await page.close();
  }, 120_000);
});

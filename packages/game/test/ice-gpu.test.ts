// Ice in the game on the GPU solver, the game's default: the Ice Tower trial (T-I1, keystone
// trial-levels.ts) loads painted as ice (@tb/render ice pass), a cannonball cracks blocks
// (feedback iceCrack: the renderer draws each one's level) and shatters some (feedback shatter:
// eight pieces each, drawn as ice, never as bombs), and the page's replay on the same device
// ends bit for bit where the live session did. SwiftShader in CI; Metal with TB_CHANNEL=chrome.
// ICE_SHOTS=<dir> writes the frames before and after. The rules on Rapier and the f64 reference
// are keystone-lab ice.test.ts.
import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { encodePng } from '@tb/testkit';
import { compileLevel, type Shot, TRIAL_LEVELS } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
/** A cannonball low into T-I1's 3 x 3 tower (aimAt at 30% of its height from az 329, y 8, power 74): on the reference it cracks 223 times and shatters 13. */
const SHOT: Shot = { ammo: 'cannonball', az: 329, y: 8, yaw: 0, pitch: 183, power: 74 };
const N = compileLevel(TRIAL_LEVELS.find((d) => d.id === 'T-I1')!).meta.n;

describe('ice in the game, GPU solver', () => {
  it('the Ice Tower loads as ice, cracks and shatters under a cannonball, and replays bit-equal', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const look = process.env.ICE_LOOK ?? 'candy';
    const o = await game.open(`/?level=T-I1&engine=gpu&offscreen=1&look=${look}`, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const shot = async (name: string) => {
      const dir = process.env.ICE_SHOTS;
      if (!dir) return;
      const s = await page.evaluate(() => window.__game.capture(true));
      if (s?.pixels) writeFileSync(`${dir}/game-ice-${look}-${name}.png`, encodePng(s.width, s.height, { data: Uint8Array.from(s.pixels.data), bytesPerRow: s.pixels.bytesPerRow }));
    };
    // Loaded: every one of its N blocks is ice, none cracked.
    expect(N).toBe(90);
    const all = Array.from({ length: N }, (_, i) => i);
    expect(await page.evaluate((s) => window.__game.ice(s), all)).toEqual({ count: N, cracks: all.map(() => 0) });
    await shot('before');
    await playShots(page, [SHOT], 20 * MINUTES);
    const live = await page.evaluate(() => window.__game.state());
    const counts = await page.evaluate(() => ({ ...window.__game.counts }));
    expect(counts.iceCrack ?? 0, JSON.stringify(counts)).toBeGreaterThan(5);
    expect(counts.shatter ?? 0, JSON.stringify(counts)).toBeGreaterThan(0);
    // Every shatter: its block gone, 8 pieces in, drawn as ice and never as bombs; the cracked blocks drawn cracked.
    const shatters = counts.shatter!;
    expect(await page.evaluate(() => window.__game.bodies)).toBe(N + 1 + 8 * shatters);
    expect(counts.bomb ?? 0).toBe(0);
    const pieces = Array.from({ length: 8 * shatters }, (_, k) => N + 1 + k);
    const paint = await page.evaluate((s) => window.__game.ice(s), [...all, ...pieces]);
    expect(paint.cracks.slice(N).every((c) => c >= 0), JSON.stringify(paint)).toBe(true);
    expect(paint.cracks.slice(0, N).filter((c) => c > 0).length).toBeGreaterThan(3);
    expect(paint.count).toBe(N + 8 * shatters);
    await shot('after');
    // The replay banks the round once its shots run out (an outcome level: runSession's bank), where the page waits aiming.
    const { phase: _, ...rest } = live;
    expect(await page.evaluate((s) => window.__game.replay(s), [SHOT])).toMatchObject(rest);
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 40 * MINUTES);
});

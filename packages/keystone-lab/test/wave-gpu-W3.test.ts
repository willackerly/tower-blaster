// W3 Fall Line on the GPU solver (M6, docs/game/wavefront.md), through the game's cast page (the game's own engine
// and settings, so sleep on and the city asleep from the start, C22): the clean line clears with the heritage
// standing, the north row falls end to end in order along the push, every other tower stays asleep and in place,
// and the awake count at the front is logged (probe X1's meter). SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, W3 } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { partGroups, pushShot, towerFace } from '../src/wave.ts';

const MINUTES = 60_000;
let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('Wavefront on the GPU solver', () => {
  it('W3 Fall Line: the north row pushed east clears, nothing else wakes', async (ctx) => {
    if (!player) return ctx.skip();
    expect(player.engine).toBe('gpu');
    const c = compileLevel(W3), groups = partGroups(c), row = [3, 7, 11, 15];
    const r = await player.wave(W3, [pushShot(c, towerFace(c, W3, 3, [1, 0]), [1, 0])], { groups, maxSteps: 2400, fell: 1 });
    console.log(`W3 north row on ${player.adapter}: ${r.cleared ? 'clear' : 'MISS'}, settled ${r.settledSeconds.toFixed(1)} s, awake max ${r.awakeMax} mean ${r.awakeMean.toFixed(0)} of ${c.meta.n}, fell ${row.map((k) => r.fellAt[k]).join(' ')}, displaced ${r.displaced}, ${(r.ms / 1000).toFixed(1)} s`);
    expect(r.limits).toEqual([]);
    expect(r.cleared).toBe(true);
    expect(r.heritageBroken).toBe(0);
    const times = row.map((k) => r.fellAt[k]!);
    expect(times.every((x) => x >= 0) && [...times].sort((a, b) => a - b).join() === times.join(), times.join(' ')).toBe(true);
    expect(r.fellAt.filter((x, k) => !row.includes(k) && x >= 0)).toEqual([]);
    // Asleep until reached: the row's debris lands against the row beside it and wakes it (it stands), but the far
    // half of the city (8 towers, 256 bodies) is never reached, so the front stays under half of it. SwiftShader: 192.
    expect(r.awakeMax).toBeLessThan(c.meta.n / 2);
    expect(r.displaced).toBeLessThanOrEqual(4 * 32 + 8);
  }, 8 * MINUTES);
});

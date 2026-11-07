// The cast page's batch watchdog (cast-browser.ts batchTimeoutMs): a batch still
// running past it is a hung page or GPU (B1 at Bounce 0.4 on the M5 hung 2.5 h),
// so its page is closed and the batch replayed like a lost page; after the
// retries the cast fails instead of hanging. Its own file: cast-gpu.test.ts is
// near the 300 s a CI file should take. SwiftShader in CI; Metal with TB_CHANNEL.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, scenarioLevel } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { competentIntents, intentShot } from '../src/cast.ts';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
/** Six plaster cubes (3 x 2 wall), one cannonball, 60 pre-settle steps. */
const TINY: LevelDef = { ...scenarioLevel('S3', { W: 3, H: 2 }, 1, { rack: ['cannonball'] }), id: 'T2', physics: { presettle: 60 } };

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('cast page watchdog', () => {
  it('a batch that outlives the watchdog closes its page as hung: replayed, then the cast fails instead of hanging', async (ctx) => {
    if (!player) return ctx.skip();
    const c = compileLevel(TINY), line = competentIntents(c, 1, 5)[0]!.map((it) => intentShot(c, it, player!.substeps));
    const before = player.reopens.length;
    player.setBatchTimeout(1);
    try {
      await expect(player.play(TINY, [line])).rejects.toThrow(/closed/i);
    } finally {
      player.setBatchTimeout(30 * MINUTES);
    }
    // Every retry (2 by default) reopened the page and timed out again.
    expect(player.reopens.length).toBe(before + 2);
    // The next batch reopens the closed page and plays normally.
    const [ok] = await player.play(TINY, [line]);
    expect(ok!.complete).toBe(true);
  }, 10 * MINUTES);
});

// Aftershock's quake on the GPU solver (M7 verify, docs/game/aftershock.md), through the game's cast page (the game's
// own engine settings): a quake replays bit for bit, and the quake inside Short Sharp Shock's window clears it as on
// the reference engine (quake.test.ts, which also shows the naive quake failing; it shakes 12 s, too long a play for
// SwiftShader in CI); and Chromium computes the very quake keys Node
// does (exact arithmetic, engine-api exactSin), so a level's quake is one input on every machine. SwiftShader in CI;
// Metal with TB_CHANNEL=chrome.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, quakeCandidate, quakeInputs, type Shot } from '@tb/keystone';
import { launchChromium, loadBundle, requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { quake } from '../src/quake-search.ts';
import { quakeKeysDigest } from './quake-keys.ts';

const MINUTES = 60_000;
/** 60 pre-settle steps keep a play short on SwiftShader. */
const quick = (d: LevelDef): LevelDef => ({ ...d, physics: { presettle: 60 } });
const SHOCK = quick(quakeCandidate('QC-4'));
const BEST: Shot = quake(60, 10, 15, 0);

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('the quake on the GPU solver', () => {
  it('replays bit for bit, and the window quake clears Short Sharp Shock', async (ctx) => {
    if (!player) return ctx.skip();
    expect(player.engine).toBe('gpu');
    const [a, b] = await player.play(SHOCK, [[BEST], [BEST]]);
    expect(b).toEqual(a);
    expect(a!.complete).toBe(true);
    expect(a!.limits).toEqual([]);
    expect(a!.samples.at(-1)!.met).toBe(true);
    expect(a!.samples.at(-1)!.heritage).toBe(0);
    console.log(`quake on ${player.adapter}: ${a!.steps} steps, crowns ${a!.samples.at(-1)!.crowns}; plays ${player.playMs.map((ms) => (ms / 1000).toFixed(1)).join(', ')} s`);
  }, 10 * MINUTES);
});

describe('quake keys', () => {
  it('Chromium computes the same quake keys as Node, bit for bit', async () => {
    const shots = [quake(60, 10, 15, 0), quake(35, 3, 120, 45), quake(80, 30, 5, 179), quake(17, 13, 77, 90)];
    const c = compileLevel(quakeCandidate('QC-2'));
    const node = quakeKeysDigest(shots.map((s) => quakeInputs(c, s, 300)));
    const { browser, close } = await launchChromium({ headless: true });
    try {
      const page = await browser.newPage();
      await loadBundle(page, fileURLToPath(new URL('./quake-keys-page.ts', import.meta.url)), '__keys');
      const web = await page.evaluate((s) => (window as unknown as { __keys: { digest(site: string, s: unknown[]): string } }).__keys.digest('QC-2', s), shots);
      expect(web).toBe(node);
    } finally { await close(); }
  }, 3 * MINUTES);
});

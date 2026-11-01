// The cast on the GPU solver (roadmap G5.1): the game's cast page plays lines
// exactly as the game builds its engine, so the same line twice on one device
// ends bit for bit the same, and a small cast runs end to end. SwiftShader in
// CI (a 6-cube level with 60 pre-settle steps keeps a play near 10 s there);
// Metal with TB_CHANNEL=chrome. Big levels cast with pnpm keystone:cast.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, scenarioLevel } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { castLevel, competentIntents, intentShot } from '../src/cast.ts';
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

describe('cast on the GPU solver', () => {
  it('the same line twice ends bit for bit the same, with each settle sampled', async (ctx) => {
    if (!player) return ctx.skip();
    expect(player.engine).toBe('gpu');
    const c = compileLevel(TINY), line = competentIntents(c, 1, 5)[0]!.map((it) => intentShot(c, it, player!.substeps));
    const [a, b] = await player.play(TINY, [line, line]);
    expect(b).toEqual(a);
    expect(a!.complete).toBe(true);
    expect(a!.samples.length).toBe(1);
    expect(a!.limits).toEqual([]);
    console.log(`cast page on ${player.adapter}: ${a!.steps} steps, collapse ${a!.samples[0]!.collapse.toFixed(3)}, plays ${player.playMs.map((ms) => (ms / 1000).toFixed(1)).join(', ')} s`);
  }, 10 * MINUTES);

  it('a page lost under a batch is reopened and the batch replayed: same plays as an undisturbed page', async (ctx) => {
    if (!player) return ctx.skip();
    const c = compileLevel(TINY), line = competentIntents(c, 1, 5)[0]!.map((it) => intentShot(c, it, player!.substeps));
    const [clean] = await player.play(TINY, [line]);
    for (const kind of ['navigate', 'close'] as const) {
      const before = player.reopens.length;
      player.injectFault(kind);
      const [again] = await player.play(TINY, [line]);
      expect(player.reopens.length, kind).toBe(before + 1);
      expect(player.reopens.at(-1)).toMatch(/plays 1-1: page lost/);
      expect(again, kind).toEqual(clean);
    }
    console.log(`reopens: ${player.reopens.join(' | ')}`);
  }, 10 * MINUTES);

  it('a small cast runs end to end: every play complete, no limit hit, thresholds ordered', async (ctx) => {
    if (!player) return ctx.skip();
    const r = await castLevel(TINY, player, { recipe: { competent: 3, climbLines: 1, climbMoves: 1, climbNudges: 1, cloud: 2 }, seed: 1 });
    expect(r.n).toBe(7);
    expect(r.lines.every((l) => l.complete && l.limits.length === 0)).toBe(true);
    expect(r.stars).toMatchObject({ metric: 'collapse', engine: 'gpu', castOn: player.adapter, hash: compileLevel(TINY).hash, n: 7 });
    expect(r.stars.t2).toBeLessThanOrEqual(r.stars.t3);
    expect(r.gates.limits.pass && r.gates.complete.pass).toBe(true);
  }, 15 * MINUTES);
});

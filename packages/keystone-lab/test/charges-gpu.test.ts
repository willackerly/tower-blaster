// Charges and the plunger on the GPU solver (C5, docs/design/charges.md), through the game's cast
// page (the game's own engine settings): the 3-event timeline of charges.test.ts plays twice to the
// same bit, and brings the left column down (the reference and Rapier check the events step by step);
// the relays armed at start leave a level's states as the level without them (a shot that moves
// nothing ends in the same state, sleep and all). SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { CHARGE_LINE, chargeLevel, MISS } from '../src/charge-level.ts';

const MINUTES = 60_000;
/** 60 pre-settle steps keep a play near 10 s on SwiftShader. */
const quick = (d: LevelDef): LevelDef => ({ ...d, physics: { presettle: 60 } });

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('charges on the GPU solver', () => {
  it('a 3-event timeline replays bit for bit and brings a column down', async (ctx) => {
    if (!player) return ctx.skip();
    expect(player.engine).toBe('gpu');
    const level = quick(chargeLevel());
    const [a, b] = await player.play(level, [CHARGE_LINE, CHARGE_LINE]);
    expect(b).toEqual(a);
    expect(a!.complete).toBe(true);
    expect(a!.limits).toEqual([]);
    expect(a!.samples.length).toBe(1);
    // Two cut bases drop two columns of three plaster cubes by one h each, at least.
    expect(a!.samples[0]!.collapse).toBeGreaterThan(0.05);
    console.log(`charges on ${player.adapter}: ${a!.steps} steps, collapse ${a!.samples[0]!.collapse.toFixed(3)}, plays ${player.playMs.map((ms) => (ms / 1000).toFixed(1)).join(', ')} s`);
  }, 10 * MINUTES);

  it('relays at rest: a shot that moves nothing ends where it ends without them', async (ctx) => {
    if (!player) return ctx.skip();
    const full = chargeLevel();
    const armed = quick({ ...full, rack: ['marble'], charges: full.charges!.filter((ch) => ch.arm === 'start') });
    const bare = quick({ ...full, rack: ['marble'], charges: undefined });
    expect(compileLevel(armed).hash).not.toBe(compileLevel(bare).hash);
    const [w] = await player.play(armed, [[MISS]]), [wo] = await player.play(bare, [[MISS]]);
    expect(w!.complete).toBe(true);
    expect(w!.hash).toBe(wo!.hash);
    expect(w!.steps).toBe(wo!.steps);
    expect(w!.samples).toEqual(wo!.samples);
  }, 10 * MINUTES);
});

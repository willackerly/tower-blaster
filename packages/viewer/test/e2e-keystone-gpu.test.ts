// Keystone's rules in the viewer on the GPU solver (SwiftShader in CI, a few
// minutes): L1's par line clears, and a replay on this device is bit for bit
// the live session. Its own file so CI's shards can place it.
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { browser, useViewer } from './e2e-harness.ts';
import { openRules, play } from './keystone-page.ts';

useViewer();

const MINUTES = 60_000;

describe('viewer under Keystone rules, GPU', () => {
  it('on the GPU solver, the par line clears and replays bit for bit on this device', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await openRules('/?level=L1&rules=keystone&offscreen=1', undefined, 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    expect(await page.evaluate(() => window.__viewer.game!.engine)).toBe('gpu');
    const shots = L1.solutions!.par as Shot[];
    const live = await play(page, shots);
    expect(live.state).toMatchObject({ phase: 'cleared', strokes: shots.length, heritageBroken: 0 });
    expect(await page.evaluate((s) => window.__viewer.game!.replay(s), shots)).toEqual(live.state);
    expect(errors).toEqual([]);
    await page.close();
  }, 20 * MINUTES);
});

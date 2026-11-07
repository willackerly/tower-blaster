// Wavefront on the GPU solver (M6, docs/game/wavefront.md), one level per test file (wave-gpu-W*.test.ts, so each
// stays under CI's per-file budget on SwiftShader), through the game's cast page: the game's own engine and settings,
// so sleep on and the city asleep from the start (C22). Each case is a line Rapier pins in wave-levels.test.ts: the
// towers that fall, in order along the push, and whether it clears. The awake count at the front is logged (probe X1's
// meter) and bounded: sleep keeps the streets the wave never reaches asleep. SwiftShader in CI; Metal with TB_CHANNEL=chrome.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, type LevelDef, type Shot } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { towerGroups } from '../src/wave.ts';

const MINUTES = 60_000;

export interface WaveGpuCase {
  name: string;
  def: LevelDef;
  shot: (c: ReturnType<typeof compileLevel>) => Shot;
  /** Tower indices (towerGroups order) that fall, in the order they fall. */
  falls: number[];
  cleared: boolean;
  /** Most structure bodies awake at once: the towers that fall plus what their debris reaches. */
  awakeMax: number;
}

/** Registers the GPU test of one level's cases. */
export function waveGpuSuite(id: string, cases: WaveGpuCase[]): void {
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
    it(`${id}: ${cases.map((k) => k.name).join('; ')}`, async (ctx) => {
      if (!player) return ctx.skip();
      expect(player.engine).toBe('gpu');
      for (const k of cases) {
        const c = compileLevel(k.def), groups = towerGroups(c);
        const r = await player.wave(k.def, [k.shot(c)], { groups, maxSteps: 2400, fell: 1 });
        const order = r.fellAt.flatMap((t, i) => (t >= 0 ? [i] : [])).sort((a, b) => r.fellAt[a]! - r.fellAt[b]!);
        console.log(`${id} ${k.name} on ${player.adapter}: ${r.cleared ? 'clear' : 'miss'}, D ${r.collapse.toFixed(3)}, order ${order.join(' ')}, settled ${r.settledSeconds.toFixed(1)} s, awake max ${r.awakeMax} mean ${r.awakeMean.toFixed(0)} of ${c.meta.n}, ${(r.ms / 1000).toFixed(1)} s`);
        expect(r.limits).toEqual([]);
        expect(order, k.name).toEqual(k.falls);
        expect(r.cleared, k.name).toBe(k.cleared);
        expect(r.awakeMax, k.name).toBeLessThanOrEqual(k.awakeMax);
      }
    }, 9 * MINUTES);
  });
}

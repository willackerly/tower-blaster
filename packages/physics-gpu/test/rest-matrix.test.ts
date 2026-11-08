// The nightly rest matrix's cases (rest-stability.ts restMatrix, #310): which configurations it gates, and that Kapla
// gets its hold and struck runs their length. No browser: the cases and their setup only.
import { describe, expect, it } from 'vitest';
import { caseName, cityHeight, KAPLA_HOLD, restMatrix, restSetup, STRUCK_MIN_FRAMES } from './rest-stability.ts';

describe('rest matrix (F3, as the nightly gates it)', () => {
  it('runs idle at 40 and 20 iterations, struck at 40 only, and leaves out Kapla at 20 without the slop', () => {
    expect(restMatrix([400], 600).map(caseName)).toEqual([
      'wall 400 idle, 40 it, gapSlop on, 600 frames',
      'wall 400 idle, 40 it, gapSlop off, 600 frames',
      'wall 400 idle, 20 it, gapSlop on, 600 frames',
      'wall 400 idle, 20 it, gapSlop off, 600 frames',
      'wall 400 struck, 40 it, gapSlop on, 1200 frames',
      'wall 400 struck, 40 it, gapSlop off, 1200 frames',
      'city 400 idle, 40 it, gapSlop on, 600 frames',
      'city 400 idle, 40 it, gapSlop off, 600 frames',
      'city 400 idle, 20 it, gapSlop on, 600 frames',
      'city 400 idle, 20 it, gapSlop off, 600 frames',
      'city 400 struck, 40 it, gapSlop on, 1200 frames',
      'city 400 struck, 40 it, gapSlop off, 1200 frames',
      'kapla 400 idle, 40 it, gapSlop on, settle 60 frames at 120 it, sleep, 600 frames',
      'kapla 400 idle, 40 it, gapSlop off, settle 60 frames at 120 it, sleep, 600 frames',
      'kapla 400 idle, 20 it, gapSlop on, settle 60 frames at 120 it, sleep, 600 frames',
      'kapla 400 struck, 40 it, gapSlop on, settle 60 frames at 120 it, sleep, 600 frames, must collapse',
      'kapla 400 struck, 40 it, gapSlop off, settle 60 frames at 120 it, sleep, 600 frames, must collapse',
    ]);
  });

  it('gives struck cube structures at least STRUCK_MIN_FRAMES and keeps a longer run, so the window opens 9 s after the strike', () => {
    expect(STRUCK_MIN_FRAMES).toBe(1200);
    const short = restMatrix([400], 600), long = restMatrix([1000, 10000], 3600);
    expect(new Set(short.filter((c) => c.mode === 'struck' && c.structure !== 'kapla').map((c) => restSetup(c).plan.watchFrom))).toEqual(new Set([600]));
    expect(new Set(long.map((c) => c.frames))).toEqual(new Set([3600]));
    expect(long).toHaveLength(2 * short.length);
  });

  it('settles every Kapla tower at 120 iterations for 60 frames, then sleeps it, and wants the struck one down', () => {
    const kapla = restMatrix([400], 600).filter((c) => c.structure === 'kapla');
    for (const c of kapla) {
      const { scene, opts, params } = restSetup(c);
      expect([scene.sleep, opts.sleep, opts.settleSteps, opts.settleIterations, params.iterations]).toEqual([true, true, KAPLA_HOLD.settle.frames * 7, 120, c.iterations]);
      expect(c.expect).toBe(c.mode === 'struck' ? 'collapse' : undefined);
    }
    // The cube structures run as the game plays them: the engine's sleep off (it acts only with GpuEngineOptions.sleep), no settle.
    for (const c of restMatrix([400], 600).filter((c) => c.structure !== 'kapla')) {
      const { opts } = restSetup(c);
      expect([opts.sleep, opts.settleSteps, c.expect]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("aims the struck city's ball at its tower, however few cubes it has", () => {
    expect([400, 1000, 1600, 10000].map(cityHeight)).toEqual([7, 16, 25, 25]);
    for (const n of [400, 1000, 10000]) {
      const { scene } = restSetup({ structure: 'city', mode: 'struck', n, iterations: 40, gapSlop: true, frames: 1200 });
      const top = Math.max(...scene.bodies.map((b) => b.pos[1])), input = scene.inputs![0]!;
      if (input.kind !== 'spawn') throw new Error('S5 fires its ball by a spawn');
      expect(scene.bodies).toHaveLength(n);
      // The ball flies level, so it hits when it starts below the top course.
      expect(input.body.pos[1]).toBeLessThan(top);
    }
  });
});

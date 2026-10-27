// The GPU AVBD engine knocking a slender tower down, against re-rolled f64
// reference runs: the slowest engine test, so it has a file (a CI shard) of
// its own.
import { describe, expect, it } from 'vitest';
import { bodiesAt, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite, penetration, survival } from '@tb/metrics';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import { gpu, runGpu } from './harness.ts';

describe('GPU AVBD engine: stacks, towers and impacts', () => {
  it('a ball knocks a slender tower down, impacts as shallow as the reference', async (ctx) => {
    if (!gpu) return ctx.skip();
    // One collapse's deepest transient is set by a single tumbling cube and
    // varies 4x between nearby ball speeds, so penetration is compared with
    // the reference as statistics over 5 speeds, sampled every 10 steps.
    // The collapse is chaotic, and the GPU's f32 rounding re-rolls it, so the
    // reference is re-rolled too: 4 runs per speed, each with every start
    // position moved by up to 1e-6 m (fixed seeds). (2026-10-25, before the
    // load floor and against one unmoved reference run: mean 0.0067 GPU vs
    // 0.0075 reference; median of the per-run sampled maxima 0.015 vs 0.011.
    // Over every step the reference's median maximum is 0.053, Rapier's 0.14
    // at speed 15.)
    const moved = (scene: SceneDesc, seed: number): SceneDesc => {
      const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
      return { ...scene, bodies: scene.bodies.map((b) => ({ ...b, pos: b.pos.map((x) => x + 1e-6 * (2 * rnd() - 1)) as Vec3 })) };
    };
    const knock = async (speed: number, si: number) => {
      const scene = buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
      const bodies = bodiesAt(scene, 1);
      const g = await runGpu(scene, 181, {}, 10);
      const refs: AvbdReferenceEngine[] = [];
      for (let r = 1; r <= 4; r++) {
        const e = new AvbdReferenceEngine();
        await e.init(moved(scene, 50000 + 1000 * si + r));
        refs.push(e);
      }
      const gp: number[] = [], rp: number[] = [];
      for (let i = 1; i <= 181; i++) {
        for (const e of refs) e.step();
        const k = g.snaps.findIndex((s) => s.step === i);
        if (k < 1) continue;
        gp.push(penetration(bodies, g.all[k]!, 0).max);
        for (const e of refs) rp.push(penetration(bodies, e.snapshot(), 0).max);
      }
      return { scene, bodies, g, gp, rp };
    };
    const runs = [];
    for (const [si, speed] of [13, 14, 15, 16, 17].entries()) runs.push(await knock(speed, si));
    const mean = (x: number[]) => x.reduce((a, b) => a + b, 0) / x.length;
    const median = (x: number[]) => [...x].sort((a, b) => a - b)[x.length >> 1]!;
    const max = (x: number[]) => x.reduce((a, b) => Math.max(a, b), 0);
    // The outcome is chaotic too (a nudge flips the ball's rebound in a few
    // percent of runs), so it is a median as well. 2026-10-25, after the
    // friction fix: survival 0.22-0.31 (median 0.23; reference 0.18-0.28,
    // median 0.22), ball vx -4.2 to -2.1 (median -3.4; reference -4.4 to
    // -1.6, median -3.1).
    for (const { g } of runs) expect(nonFinite(g.s1)).toBe(0);
    expect(median(runs.map(({ bodies, g }) => survival(bodies, g.all[1]!, g.s1, [0])))).toBeLessThan(0.5);
    expect(median(runs.map(({ bodies, g }) => g.s1.linVel[3 * (bodies.length - 1)]!))).toBeLessThan(-1);
    const gMean = mean(runs.flatMap((r) => r.gp)), rMean = mean(runs.flatMap((r) => r.rp));
    // The GPU's mean over the 4 re-rolled reference runs' mean. One re-rolled
    // reference run over the mean of 4 others gives 0.61-1.93 in 99.9% of
    // bootstrap draws (2026-10-26, with the load cap, 40 re-rolls per speed),
    // so outside the bars means a real difference; the GPU's is 1.11 on
    // SwiftShader. The bars allow for the reference's 4 runs being re-rolled
    // too, as any physics change does: these 4 seeds' mean sits 1.11x the
    // 40-run mean, so with them fixed a GPU re-roll would land in 0.61-1.55.
    // Against the unmoved run alone the band is off-centre: the re-rolls
    // average 1.24x it with the cap (0.80x without), and the GPU's ratio to
    // it was 1.53.
    console.log(`knock: GPU / re-rolled reference mean penetration ${(gMean / rMean).toFixed(3)} (${gMean.toExponential(3)} / ${rMean.toExponential(3)})`);
    expect(gMean / rMean).toBeGreaterThan(0.6);
    expect(gMean / rMean).toBeLessThan(1.95);
    expect(median(runs.map((r) => max(r.gp)))).toBeLessThan(0.08);
  }, 300_000);
});

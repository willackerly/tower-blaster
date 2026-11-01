// Does the S15 Kapla tower stand? (roadmap E5). The F3 rest test (rest-stability.ts) at the game's
// settings, 7 substeps a frame and 20 or 40 iterations, finds every idle Kapla tower down within a
// minute on Metal; this file sweeps the two dials that trade against each other, iterations and
// substeps, through the same harness and verdict (an idle tower at real plank size, gapSlop on, the
// window from frame 120: no plank moves a tenth of its thickness, the top holds).
//
// Without KAPLA_HOLD=1 only the grid and its setup are checked (no GPU). With it, on a physical GPU:
//   TB_CHANNEL=chrome KAPLA_HOLD=1 REQUIRE_WEBGPU=1 REST_LOG=hold.txt \
//     KAPLA_SIZES=10000 KAPLA_ITERATIONS=40,80,120 KAPLA_SUBSTEPS=2,3,4,7 REST_FRAMES=3600 \
//     pnpm vitest run packages/physics-gpu/test/kapla-hold.test.ts
// Each case logs its "rest:" line (REST_LOG appends them), including steps/s; REST_ONLY=<text> keeps
// the cases whose name contains it.
//
// E2 step 2b, sleep as the stabiliser (the M5 gate: the idle 10k tower holds a minute, and the topple still brings it
// down), with KAPLA_SLEEP=1 in place of KAPLA_HOLD=1: sleepGrid's cases at KAPLA_SIZES (default 10000),
//   TB_CHANNEL=chrome KAPLA_SLEEP=1 REQUIRE_WEBGPU=1 REST_LOG=sleep.txt pnpm vitest run packages/physics-gpu/test/kapla-hold.test.ts
// Each line also gives the asleep count, the planks woken in the window, and the creep before the window (with sleep,
// how far planks moved before they slept).
import { describe, expect, it } from 'vitest';
import { KAPLA_SCALE } from '@tb/scenarios';
import { autoSubsteps } from '@tb/viewer';
import { caseName, type RestCase, restSetup, restSuite } from './rest-stability.ts';

const list = (v: string | undefined, d: number[]) => (v ? v.split(',').map(Number) : d);

/** Idle towers of each size, at each iteration count and substep count, gapSlop on (the game's). */
export function holdGrid(sizes: number[], iterations: number[], substeps: number[], frames: number): RestCase[] {
  const out: RestCase[] = [];
  for (const n of sizes) for (const k of substeps) for (const it of iterations) out.push({ structure: 'kapla', mode: 'idle', n, iterations: it, gapSlop: true, frames, substeps: k });
  return out;
}

/**
 * The sleep gate's cases at each size, 40 iterations x 7 substeps (the game's), gapSlop on, traced: the tower idle for
 * a minute and toppled (S15's ball at 2 s, 10 s run), each with sleep alone and with a settle of 60 frames at 120
 * iterations first (the only setting that nearly holds awake). Idle must hold from frame 120 and be asleep by then;
 * toppled must come down.
 */
export function sleepGrid(sizes: number[]): RestCase[] {
  const out: RestCase[] = [];
  for (const n of sizes) for (const settle of [undefined, { frames: 60, iterations: 120 }]) {
    const base: RestCase = { structure: 'kapla', mode: 'idle', n, iterations: 40, gapSlop: true, frames: 3600, substeps: 7, sleep: {}, trace: true, asleepBy: 120, ...(settle && { settle }) };
    out.push(base, { ...base, mode: 'struck', frames: 600, expect: 'collapse' });
  }
  return out;
}

describe('Kapla hold grid', () => {
  it('sweeps iterations x substeps on idle towers, and a case\'s substeps reach the scene and the plan', () => {
    const grid = holdGrid([1000], [40, 80], [2, 7], 600);
    expect(grid.map(caseName)).toEqual([
      'kapla 1000 idle, 40 it x 2 substeps, gapSlop on, 600 frames', 'kapla 1000 idle, 80 it x 2 substeps, gapSlop on, 600 frames',
      'kapla 1000 idle, 40 it x 7 substeps, gapSlop on, 600 frames', 'kapla 1000 idle, 80 it x 7 substeps, gapSlop on, 600 frames',
    ]);
    const two = restSetup(grid[0]!), seven = restSetup(grid[2]!);
    expect([two.plan.substeps, seven.plan.substeps]).toEqual([2, 7]);
    expect(two.scene.dt).toBeCloseTo(1 / 120, 12);
    expect(seven.scene.dt).toBeCloseTo(1 / 420, 12);
    expect(two.params.iterations).toBe(40);
    // Gravity and the tower do not depend on the substeps.
    expect(two.scene.gravity).toEqual(seven.scene.gravity);
    expect(two.scene.bodies.map((b) => b.pos)).toEqual(seven.scene.bodies.map((b) => b.pos));
  });

  it('leaves the F3 cases as they were: no substeps means autoSubsteps, and the name is unchanged', () => {
    const c: RestCase = { structure: 'kapla', mode: 'idle', n: 1000, iterations: 40, gapSlop: true, frames: 3600 };
    expect(caseName(c)).toBe('kapla 1000 idle, 40 it, gapSlop on, 3600 frames');
    expect(restSetup(c).plan.substeps).toBe(autoSubsteps(KAPLA_SCALE));
    expect(restSetup({ ...c, substeps: autoSubsteps(KAPLA_SCALE) }).scene).toEqual(restSetup(c).scene);
    expect(() => restSetup({ ...c, structure: 'wall', substeps: 2 })).toThrow('substeps is for the Kapla tower only');
    expect(() => restSetup({ ...c, substeps: 0 })).toThrow('substeps is for the Kapla tower only');
  });
});

describe('Kapla sleep grid (E2 step 2b)', () => {
  it('runs idle and toppled towers with sleep, alone and after a settle, and the options reach the scene and the engine', () => {
    const grid = sleepGrid([10000]);
    expect(grid.map(caseName)).toEqual([
      'kapla 10000 idle, 40 it x 7 substeps, gapSlop on, sleep, 3600 frames',
      'kapla 10000 struck, 40 it x 7 substeps, gapSlop on, sleep, 600 frames, must collapse',
      'kapla 10000 idle, 40 it x 7 substeps, gapSlop on, settle 60 frames at 120 it, sleep, 3600 frames',
      'kapla 10000 struck, 40 it x 7 substeps, gapSlop on, settle 60 frames at 120 it, sleep, 600 frames, must collapse',
    ]);
    const plain = restSetup(grid[0]!), settled = restSetup(grid[2]!);
    expect([plain.scene.sleep, plain.opts.sleep, plain.opts.settleSteps, plain.plan.trace, plain.plan.watchFrom]).toEqual([true, true, undefined, true, 120]);
    // The settle is counted in frames, 7 engine steps each.
    expect([settled.opts.settleSteps, settled.opts.settleIterations, settled.params.iterations]).toEqual([420, 120, 40]);
    // Rule overrides reach the engine and the name.
    const c: RestCase = { ...grid[0]!, sleep: { sleepSpeed: 0.2 } };
    expect(restSetup(c).opts).toMatchObject({ sleep: true, sleepSpeed: 0.2 });
    expect(caseName(c)).toContain('sleep (sleepSpeed 0.2)');
    // Without sleep the engine options are as before.
    const awake = restSetup({ ...grid[0]!, sleep: undefined, asleepBy: undefined });
    expect([awake.opts.sleep, awake.plan.trace]).toEqual([undefined, true]);
  });

  it('refuses asleepBy without sleep or off the 60-frame samples, and a window outside the run', () => {
    const c = sleepGrid([1000])[0]!;
    expect(() => restSetup({ ...c, sleep: undefined })).toThrow('asleepBy needs sleep and a multiple of 60 frames within the run');
    expect(() => restSetup({ ...c, asleepBy: 90 })).toThrow('asleepBy needs sleep');
    expect(() => restSetup({ ...c, asleepBy: 3660 })).toThrow('asleepBy needs sleep');
    expect(() => restSetup({ ...c, watchFrom: 3600 })).toThrow('watchFrom must be a frame of the run');
    expect(restSetup({ ...c, watchFrom: 60 }).plan.watchFrom).toBe(60);
  });
});

if (process.env.KAPLA_SLEEP === '1') restSuite(sleepGrid(list(process.env.KAPLA_SIZES, [10000])));

if (process.env.KAPLA_HOLD === '1') {
  restSuite(holdGrid(
    list(process.env.KAPLA_SIZES, [1000]), list(process.env.KAPLA_ITERATIONS, [40, 80, 120]),
    list(process.env.KAPLA_SUBSTEPS, [2, 3, 4, 7]), Number(process.env.REST_FRAMES ?? 3600),
  ));
}

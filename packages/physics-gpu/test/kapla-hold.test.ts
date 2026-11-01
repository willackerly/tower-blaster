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

if (process.env.KAPLA_HOLD === '1') {
  restSuite(holdGrid(
    list(process.env.KAPLA_SIZES, [1000]), list(process.env.KAPLA_ITERATIONS, [40, 80, 120]),
    list(process.env.KAPLA_SUBSTEPS, [2, 3, 4, 7]), Number(process.env.REST_FRAMES ?? 3600),
  ));
}

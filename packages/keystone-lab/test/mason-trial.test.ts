// Mason's Trial as the game plays it (keystone mason-trial.ts), on the f64 reference: after
// Play the level as built is loaded and pre-settled by the game's Driver, the trial pushes world
// 0's test into it, and the page steps it. The world the player watches is the judge's solo run
// of world 0 exactly (same counts), on a serial and a pipelined driver; the judge's verdict beside
// it is judgeMason's; the score is masonScore of the judge's count and the build's cost.
import { describe, expect, it } from 'vitest';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, Driver, judgeMason, MasonTrial, masonScore, MT4 } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { MASON_KNIFE, MASON_SOLUTIONS, masonBuild } from '../src/mason-solutions.ts';

const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
const worlds = [0, 1, 2, 3];

async function play(def: typeof MT4, pipelined: boolean) {
  const c = compileLevel(def), d = new Driver(ref(), c, { pipelined });
  await d.reset();
  const t = new MasonTrial(c, d, { judge: ref(), worlds });
  let r = t.observe();
  while (!t.heroDone) { await d.step(); r = t.observe(); }
  await t.judged;
  r = t.observe();
  return { c, t, r: r!, d };
}

describe("Mason's Trial as the game plays it", () => {
  for (const [label, steps] of [['the 3-star author', MASON_SOLUTIONS.MT4![0]!.steps], ['the knife-edge build', MASON_KNIFE.MT4!.steps]] as const) {
    it(`MT4, ${label}: world 0 as watched is the judge's solo world 0, on a serial and a pipelined driver; the score is the judge's`, async () => {
      const b = masonBuild(MT4, steps);
      if ('refused' in b) throw new Error(b.refused);
      const solo = await judgeMason(ref(), compileLevel(b.def), [0]), judge = await judgeMason(ref(), compileLevel(b.def), worlds);
      for (const pipelined of [false, true]) {
        const { r, d, c } = await play(b.def, pipelined);
        expect(r, `pipelined ${pipelined}`).not.toBeNull();
        expect(r.hero.counts, `pipelined ${pipelined}`).toEqual(solo.counts.map((col) => col[0]));
        expect(r.hero.pass).toBe(solo.pass[0]);
        expect(r.verdict.pass).toEqual(judge.pass);
        expect(r.verdict.counts).toEqual(judge.counts);
        expect(r.spent).toBe(b.spent);
        expect(r.score).toEqual(masonScore(c.def, judge.passes, worlds.length, b.spent));
        // The probe went into the driver's world as a body (drawn by the page) and the session never ran a shot.
        expect(d.bodies.length).toBe(c.scene.bodies.length + MT4.mason!.probes.length);
        expect(d.session.strokes).toBe(0);
      }
    }, 120_000);
  }

  it('refuses a driver that is not at the end of its pre-settle', async () => {
    const c = compileLevel(MT4), d = new Driver(ref(), c);
    await d.reset();
    await d.step();
    expect(() => new MasonTrial(c, d, { judge: null })).toThrow(/not at the end of the pre-settle/);
  });
});

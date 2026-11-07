// Mason's Trial on the f64 reference (M8, docs/game/masons-trial.md), one level per
// test file (mason-ref-MT*.test.ts, so each stays well under CI's per-file budget):
// - the recorded builds go through the real build tool, each step a click a player
//   can make (masonUnreachable), and the level's stars are
//   MASON_STAR_SHARE of its tier authors' recorded points (masonStarsFrom);
// - in the judge's first 8 worlds the authors pass and the wrong builds fail;
// - the judge's verify: the knife-edge build (it passes in only some worlds) in 16
//   islands against the same 16 worlds played alone, Fisher's exact test on the
//   two pass counts (KS is degenerate on pass/fail);
// - with PHYSICS_GPU_SLOW=1, the full 64-world judge of every recorded build
//   gives exactly its recorded passes (the reference is deterministic), and the
//   knife's 64 islands agree with its 64 solo runs.
import { describe, expect, it } from 'vitest';
import { compileLevel, judgeMason, type LevelDef, MASON_CLEAR, MASON_WORLDS, soloMason } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS } from '@tb/keystone';
import { MASON_KNIFE, MASON_SOLUTIONS, MASON_WRONG, type MasonBuild, masonBuild, masonStarsFrom, masonUnreachable } from '../src/mason-solutions.ts';
import { fisherExact } from '../src/mason-stats.ts';

const MINUTES = 60_000, SLOW = process.env.PHYSICS_GPU_SLOW === '1';
const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
const range = (n: number) => Array.from({ length: n }, (_, k) => k);

function built(def: LevelDef, b: MasonBuild) {
  const r = masonBuild(def, b.steps);
  if ('refused' in r) throw new Error(`${def.id} ${b.label}: refused (${r.refused})`);
  return { c: compileLevel(r.def), spent: r.spent };
}

/** Islands against solo runs of the same worlds: the pass counts, the per-world agreement and Fisher's p. */
async function verify(def: LevelDef, b: MasonBuild, K: number) {
  const { c } = built(def, b), worlds = range(K), v = await judgeMason(ref(), c, worlds);
  let solo = 0, agree = 0;
  for (const k of worlds) {
    const p = await soloMason(ref(), c, k);
    solo += p ? 1 : 0;
    agree += p === v.pass[k] ? 1 : 0;
  }
  return { islands: v.passes, solo, agree, leaks: v.leaks, p: fisherExact(v.passes, K - v.passes, solo, K - solo) };
}

/** Registers the reference tests of one Mason level. */
export function masonRefSuite(def: LevelDef): void {
  const sols = MASON_SOLUTIONS[def.id]!, knife = MASON_KNIFE[def.id]!, wrong = MASON_WRONG[def.id]!;

  describe(`${def.id} ${def.name} on the reference`, () => {
    it('the recorded builds build, two families set the stars, and the level says what they set', () => {
      expect(sols.map((s) => s.tier).sort()).toEqual([2, 3]);
      for (const b of [...sols, knife, ...wrong]) {
        const { spent } = built(def, b);
        if (b.measured) expect(spent, b.label).toBe(b.measured.spent);
        expect(spent, b.label).toBeLessThanOrEqual(def.build!.budget!);
        // Every step is one a player can make: a click where the pointer lands (with a slide off it, as Hold.slide allows).
        expect(masonUnreachable(def, b.steps), b.label).toEqual([]);
      }
      // ... and the check has teeth: a face hit far past the lot is no click.
      expect(masonUnreachable(def, [(s) => ({ place: 'cube', hit: { body: 0, point: [99 * s.h, 50 * s.h, 0], normal: [0, 1, 0], t: 0 } })])).toHaveLength(1);
      expect(def.mason!.stars).toEqual(masonStarsFrom(def, sols));
      // The 3-star author build is the cheaper one, and both are robust (they pass in most worlds).
      const [t2, t3] = [sols.find((s) => s.tier === 2)!, sols.find((s) => s.tier === 3)!];
      expect(t3.measured!.spent).toBeLessThan(t2.measured!.spent);
      for (const s of sols) expect(s.measured!.passes, s.label).toBeGreaterThanOrEqual(0.9 * MASON_WORLDS);
    });

    it('in the first 8 worlds the authors pass and the wrong builds fail; no island leaks', async () => {
      const K = 8;
      for (const b of sols) {
        const v = await judgeMason(ref(), built(def, b).c, range(K));
        console.log(`${def.id} T${b.tier} ${b.label}: ${v.passes}/${K}`);
        expect(v.passes, b.label).toBeGreaterThanOrEqual(K - 1);
        expect(v.leaks).toBe(0);
      }
      for (const b of wrong) {
        const v = await judgeMason(ref(), built(def, b).c, range(K));
        console.log(`${def.id} wrong ${b.label}: ${v.passes}/${K}`);
        expect(v.passes, b.label).toBeLessThan(K * MASON_CLEAR);
      }
    }, 6 * MINUTES);

    it("the judge's verify: the knife-edge build in 16 islands agrees with its 16 solo runs (Fisher p > 0.05)", async () => {
      const r = await verify(def, knife, 16);
      console.log(`${def.id} knife ${knife.label}: islands ${r.islands}/16, solo ${r.solo}/16, same verdict in ${r.agree}, Fisher p ${r.p.toFixed(3)}`);
      expect(r.leaks).toBe(0);
      expect(r.p).toBeGreaterThan(0.05);
      // The knife is one: over the 64 worlds it passes in some and fails in others (its record).
      expect(knife.measured!.passes).toBeGreaterThan(0);
      expect(knife.measured!.passes).toBeLessThan(MASON_WORLDS);
    }, 6 * MINUTES);

    it.runIf(SLOW)('64 worlds: every recorded build passes exactly as recorded, and the knife agrees with 64 solo runs', async () => {
      for (const b of [...sols, knife]) {
        const v = await judgeMason(ref(), built(def, b).c, range(MASON_WORLDS));
        expect(v.passes, b.label).toBe(b.measured!.passes);
      }
      const r = await verify(def, knife, MASON_WORLDS);
      console.log(`${def.id} knife at 64: islands ${r.islands}, solo ${r.solo}, same verdict in ${r.agree}, Fisher p ${r.p.toFixed(3)}`);
      expect(r.p).toBeGreaterThan(0.05);
    }, 60 * MINUTES);
  });
}

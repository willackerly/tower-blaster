// W6 Orchard (M6 Lay at 1k, docs/game/wavefront.md) on Rapier: a pre-laid field of 1,021 dominoes forking four times
// into sixteen bells. The authored run round the wall to the field's trunk rings all sixteen on every one of 10
// nudged builds (30 nightly) (every fork in the field has to hold, every time); nothing built, or a run into the wall, rings
// none. 150 nudges of both solutions and the parts-par search run with WAVE_SLOW=1 (about 30 minutes here).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, rubePlay, W6 } from '@tb/keystone';
import { build } from '../src/rube.ts';
import { layPar, nudgeClears, steps } from '../src/lay.ts';
import { LAY_SOLUTIONS } from '../src/lay-solutions.ts';

const SLOW = process.env.WAVE_SLOW === '1', NIGHTLY = process.env.PHYSICS_GPU_SLOW === '1';
// 10 nudges (none may fail) on a PR keep the file near 2 minutes on a CI runner (30 took 266 to 375 s there, over the
// per-file budget, O5); the nightly (PHYSICS_GPU_SLOW=1) plays 30. The 98% claim rests on WAVE_SLOW's 150 of each run
// (150 of 150 clean: at 95% confidence, at least 98.0% of nudges clear; docs/game/wavefront.md).
const NUDGES = SLOW ? 150 : NIGHTLY ? 30 : 10, MAY_FAIL = Math.floor(0.02 * NUDGES);

describe('W6 Orchard on Rapier', () => {
  it('holds about 1,000 dominoes and sixteen bells', () => {
    const c = compileLevel(W6);
    expect(c.meta.n).toBeGreaterThanOrEqual(1000);
    expect(c.meta.crowns.length).toBe(16);
  });

  it('nothing built, or a run into the wall, rings no bell', { timeout: 120_000 }, async () => {
    for (const def of [W6, build(W6, [{ stroke: [[1.5, 0], [7, 0]] }])!.def]) {
      const e = new RapierEngine();
      try {
        const r = await rubePlay(e, compileLevel(def));
        expect(r.rung).toBe(0);
      } finally { e.dispose(); }
    }
  });

  it.for(LAY_SOLUTIONS.W6!.slice(0, SLOW ? 2 : 1).map((s) => s.label))(`the %s run rings all sixteen on at least 98 percent of ${NUDGES} nudges`, { timeout: 60 * 60_000 }, async (label) => {
    const s = LAY_SOLUTIONS.W6!.find((x) => x.label === label)!, b = build(W6, steps(s))!;
    const t = performance.now(), ok = await nudgeClears(b.def, NUDGES);
    console.log(`W6 ${label}: ${b.spent} dominoes laid, ${ok}/${NUDGES} nudges ring all 16 bells, ${((performance.now() - t) / NUDGES / 1000).toFixed(1)} s a run`);
    expect(NUDGES - ok).toBeLessThanOrEqual(MAY_FAIL);
  });

  it.runIf(SLOW)('the parts par is the cheapest build the Lay bot finds', { timeout: 60 * 60_000 }, async () => {
    const r = await layPar(W6, LAY_SOLUTIONS.W6!, { samples: 8, amp: 0.8, gate: 4 });
    console.log(`W6: par ${r.par} (${r.best.label}); ${r.clears.length} clear, ${r.failed} failed, ${r.luck} luck, ${r.refused} refused`);
    expect(r.par).toBe(W6.build!.par);
  });
});

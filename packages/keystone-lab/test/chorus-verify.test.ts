// M9's verify (nodes.json): Chorus's per-world outcomes, read off one islands run, have the distribution of
// the same worlds played one at a time (ChorusEngine only: k, each world alone at the origin with its own
// jitter and aim nudge). Two-sample KS on the share of blocks moved and on the crowns down (p > 0.05), and
// Fisher's exact test on the clears (p > 0.05), with a power check: the shot must split the worlds (neither
// none nor all clear), or two constant samples would agree whatever the islands did. On Rapier through the
// Driver, as the game plays it, at the full 64 worlds. The GPU half is mode-probes M9 (chorus-gpu).
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { fisherExact, ks2 } from '@tb/metrics';
import { ChorusEngine, type ChorusJudgement, compileLevel, runSession } from '@tb/keystone';
import { openFire, SHOT } from './chorus-fixture.ts';

const K = 64;

describe('Chorus verify on Rapier: 64 islands against 64 solo runs', () => {
  it('the outcome distributions agree (KS and Fisher p > 0.05), and the shot splits the worlds', { timeout: 280_000 }, async () => {
    const c = compileLevel(openFire(K));
    const isl = new ChorusEngine(new RapierEngine(), c);
    await runSession(isl, c, [SHOT]);
    const a = isl.judge();
    isl.dispose();
    const solo: ChorusJudgement[] = [];
    for (let k = 0; k < K; k++) {
      const e = new ChorusEngine(new RapierEngine(), c, { only: k });
      await runSession(e, c, [SHOT]);
      solo.push(e.judge());
      e.dispose();
    }
    const b = { moved: solo.map((j) => j.moved[0]!), crowns: solo.map((j) => j.crownsDown[0]!), clears: solo.filter((j) => j.cleared[0]).length };
    const moved = ks2(a.moved, b.moved), crowns = ks2(a.crownsDown, b.crowns), clears = fisherExact(a.clears, K, b.clears, K);
    const same = solo.filter((j, k) => j.crownsDown[0] === a.crownsDown[k]).length;
    console.log(`chorus verify (Rapier, ${K} worlds): clears islands ${a.clears}/${K}, solo ${b.clears}/${K} (Fisher p ${clears.toFixed(3)}); moved KS D ${moved.D.toFixed(3)} p ${moved.p.toFixed(3)}; crowns KS D ${crowns.D.toFixed(3)} p ${crowns.p.toFixed(3)}; same crowns world by world ${same}/${K}; leaks ${a.leaks}`);
    expect(a.leaks).toBe(0);
    expect(a.clears).toBeGreaterThan(0);
    expect(a.clears).toBeLessThan(K);
    expect(moved.p).toBeGreaterThan(0.05);
    expect(crowns.p).toBeGreaterThan(0.05);
    expect(clears).toBeGreaterThan(0.05);
  });
});

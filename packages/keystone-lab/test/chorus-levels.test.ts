// The Chorus levels (M9, keystone chorus-levels.ts) on Rapier through the Driver, at their full 64 worlds:
// each validates, its obvious shot splits the worlds (neither none nor all clear: the brief's "interesting
// spread"), and its best line clears at least as many and earns a star. The GPU solver's counts differ (it
// is far less chaotic) and are in docs/game/chorus.md, with chorus-gpu.test.ts for the GPU itself.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { CHORUS_LEVELS, ChorusEngine, chorusLine, chorusOf, compileLevel, runSession, validateLevel } from '@tb/keystone';

const clears = async (id: string, which: 'obvious' | 'best') => {
  const def = CHORUS_LEVELS.find((l) => l.id === id)!, c = compileLevel(def), e = new ChorusEngine(new RapierEngine(), c);
  const r = await runSession(e, c, chorusLine(id, which));
  const j = e.judge();
  e.dispose();
  return { j, score: r.session.score! };
};

describe('Chorus levels on Rapier', () => {
  for (const def of CHORUS_LEVELS) it(`${def.id} (${def.name}): validates; the obvious shot splits the 64 worlds, the best line clears more and earns a star`, async () => {
    expect(validateLevel(compileLevel(def), { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    expect(chorusOf(def)!.worlds).toBe(64);
    const ob = await clears(def.id, 'obvious'), best = await clears(def.id, 'best');
    console.log(`${def.id} on Rapier: obvious ${ob.j.clears}/64 (${ob.score.stars} stars), best ${best.j.clears}/64 (${best.score.stars} stars)`);
    for (const x of [ob, best]) expect(x.j.leaks).toBe(0);
    expect(ob.j.clears).toBeGreaterThan(0);
    expect(ob.j.clears).toBeLessThan(64);
    expect(best.j.clears).toBeGreaterThanOrEqual(ob.j.clears);
    expect(best.score.stars).toBeGreaterThan(0);
  }, 120_000);
});

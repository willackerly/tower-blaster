// Aftershock's retrofit grammar without an engine (M7b, docs/game/aftershock.md "Retrofit"): the level's own quake
// (quake.fixed) locks the dial and refuses any other; a retrofit's quake objective needs only heritage; what the
// player placed is the built star metric (lower is better) and the Budget left line; and a build level's stars and
// progress are kept against the level as authored (CompiledLevel.baseHash), so a build is a play, not a new level.
import { describe, expect, it } from 'vitest';
import {
  AFTERSHOCK_LEVELS, BuildSession, castStars, checkStars, compileLevel, type LevelDef, lowerIsBetter, naiveQuake, objectiveMet, type OutcomeFacts, outcomeScore, outcomeTally, placedCost, QUAKE, quakeRefusal,
  quakeRulesOf, type QuakeShot, levelById, RETROFIT_BUILD, RETROFIT_LEVELS, RETROFIT_QUAKE, RETROFIT_SITES, retrofitCandidate, type Reductions, Session, validateLevel,
} from '../src/index.ts';

const FIXED = { peak: 30, hz: 10, sec: 10, axis: 0 };
const retro = (over: Partial<LevelDef> = {}): LevelDef => ({
  id: 'RQ', name: 'retrofit', version: 1, world: 0, lot: { min: [-10, -10], max: [10, 10] }, crownLine: 1.5, objective: { kind: 'quake' }, par: 1,
  rack: [QUAKE], launcher: { radius: 8, y: 1, dropY: 10 }, scoring: 'outcome', heritage: 'standing', quake: { fixed: FIXED }, build: { budget: 20, brush: false },
  parts: [
    { kind: 'block', at: [0, 0, 0], size: [1, 5, 1], material: 'plaster' }, // 0-4
    { kind: 'block', at: [0, 5, 0], size: [1, 1, 1], material: 'plaster', role: 'heritage' }, // 5: the protected top
  ],
  ...over,
});
const q = (peak: number, hz: number, sec: number, axis = 0): QuakeShot => ({ ammo: 'quake', peak, hz, sec, axis });
/** A pier of three beside the column (the bot's buttress), placed through the build tool. */
function braced(def: LevelDef): LevelDef {
  const s = new BuildSession(def), h = s.h, p = s.pitch;
  expect(s.place(s.ghost({ body: -1, point: [1.5 * p * h, 0, 0.5 * p * h], normal: [0, 1, 0], t: 0 }, { item: 'pier3', yaw: 0, tip: 0 }))).toBe(true);
  return s.def();
}

describe('the level\'s own quake (quake.fixed)', () => {
  it('locks the dial to it: the ranges hold only it, any other quake is refused, and the naive quake is it', () => {
    const c = compileLevel(retro()), r = quakeRulesOf(c.def);
    expect(r).toMatchObject({ peakMax: 30, hz: [10, 10], sec: [10, 10], fixed: FIXED });
    expect(quakeRefusal(c, q(30, 10, 10, 0))).toBeNull();
    for (const other of [q(25, 10, 10), q(30, 8, 10), q(30, 10, 12), q(30, 10, 10, 90)]) expect(quakeRefusal(c, other)).toMatch(/quake is fixed: 30% g, 1 Hz, 1 s at 0 degrees/);
    expect(naiveQuake(c)).toEqual(q(30, 10, 10, 0));
  });

  it('is checked: whole numbers on the dial, no other fields, and no ranges beside it', () => {
    expect(() => compileLevel(retro({ quake: { fixed: { ...FIXED, peak: 0 } } }))).toThrow(/quake.fixed.peak must be a whole number from 1 to 100/);
    expect(() => compileLevel(retro({ quake: { fixed: { ...FIXED, axis: 180 } } }))).toThrow(/fixed.axis/);
    expect(() => compileLevel(retro({ quake: { fixed: { ...FIXED, gust: 1 } as never } }))).toThrow(/fixed.gust is not a quake field/);
    expect(() => compileLevel(retro({ quake: { fixed: FIXED, peakMax: 50 } }))).toThrow(/a fixed quake takes no peakMax/);
    // A budget beside it is fine (the quake's energy is still shown), and it is part of the hash.
    expect(compileLevel(retro({ quake: { fixed: FIXED, budget: 100 } })).hash).not.toBe(compileLevel(retro()).hash);
    expect(compileLevel(retro({ quake: { fixed: { ...FIXED, hz: 12 } } })).hash).not.toBe(compileLevel(retro()).hash);
  });
});

describe('the retrofit objective', () => {
  it('a quake level with a build block needs only heritage; without one it still needs a crown', () => {
    expect(validateLevel(compileLevel(retro())).filter((i) => i.code === 'objective')).toEqual([]);
    const { build: _b, ...noBuild } = retro();
    expect(validateLevel(compileLevel(noBuild)).filter((i) => i.code === 'objective').map((i) => i.message)).toEqual([expect.stringMatching(/needs a crown to bring down/)]);
    const bare = { ...retro(), parts: retro().parts.map((p) => ({ ...p, role: undefined })) };
    expect(validateLevel(compileLevel(bare)).filter((i) => i.code === 'objective').map((i) => i.message)).toEqual([expect.stringMatching(/needs a heritage body/)]);
  });

  it('is met at a settle with no heritage broken; never with none to keep, nor without a build block and no crown', () => {
    const red = {} as Reductions, c = compileLevel(retro());
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0, heritage: 0 }, 'outcome')).toBe(true);
    expect(objectiveMet(c, { red, crownsTotal: 0, collapse: 0, heritage: 1 }, 'outcome')).toBe(false);
    const { build: _b, ...noBuild } = retro();
    expect(objectiveMet(compileLevel(noBuild), { red, crownsTotal: 0, collapse: 0, heritage: 0 }, 'outcome')).toBe(false);
  });
});

describe('retrofit scoring', () => {
  const facts = (over: Partial<OutcomeFacts> = {}): OutcomeFacts => ({
    met: true, collapse: 0, leverage: 0, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0, quake: true, energy: 50,
    built: { spent: 12, budget: 40 }, ...over,
  });

  it('the tally: Objective and the budget left (10 a block), no Condemned line with nothing condemned; heritage costs as before', () => {
    expect(outcomeTally(facts())).toEqual([{ label: 'Objective', value: 1000 }, { label: 'Budget left', value: 280 }]);
    expect(outcomeTally(facts({ met: false, heritageBroken: 2 }))).toEqual([{ label: 'Heritage', value: -1000 }]);
    expect(outcomeTally(facts({ built: { spent: 40, budget: 40 } }))).toEqual([{ label: 'Objective', value: 1000 }]);
    // With condemned towers too, they are still counted.
    expect(outcomeTally(facts({ hasCrowns: true, crownsDown: 1 }))).toContainEqual({ label: 'Condemned', value: 500 });
  });

  it('stars on what was built: lower is better, a retrofit\'s default metric, the objective first', () => {
    expect(lowerIsBetter('built')).toBe(true);
    const cast = checkStars({ metric: 'built', t2: 9, t3: 6, best: 6 });
    expect(() => checkStars({ metric: 'built', t2: 6, t3: 9 })).toThrow(/easier/);
    const star = (spent: number, met = true) => outcomeScore(facts({ met, built: { spent, budget: 40 } }), cast).stars;
    expect([star(20), star(9), star(6), star(4), star(4, false)]).toEqual([1, 2, 3, 3, 0]);
    expect(outcomeScore(facts({ built: { spent: 4, budget: 40 } }), cast).outcome.beatBot).toBe(true);
    expect(outcomeScore(facts(), undefined).outcome.metric).toBe('built');
    expect(outcomeScore(facts({ built: undefined }), undefined).outcome.metric).toBe('energy');
  });

  it('a session reports what was placed and the budget', () => {
    const def = braced(retro()), s = new Session(compileLevel(def));
    expect(placedCost(def)).toBe(3);
    expect(s.outcomeFacts().built).toEqual({ spent: 3, budget: 20 });
    expect(new Session(compileLevel(retro({ build: { brush: false } }))).outcomeFacts().built).toEqual({ spent: 0 });
  });
});

describe('a build level\'s base hash', () => {
  it('is the level as authored: a build changes the hash, not the base; levels without a build keep base = hash', () => {
    const plain = compileLevel(retro()), built = compileLevel(braced(retro()));
    expect(plain.baseHash).toBe(plain.hash);
    expect(built.hash).not.toBe(plain.hash);
    expect(built.baseHash).toBe(plain.hash);
    // A placed part in a level with no build block is authored geometry (a file's): its hash is its base.
    const { build: _b, ...noBuild } = braced(retro());
    const file = compileLevel(noBuild);
    expect(file.baseHash).toBe(file.hash);
  });

  it('keeps the cast stars on a build (they are the authored level\'s), and drops them when the authored level changes', () => {
    const stars = { metric: 'built' as const, t2: 9, t3: 6, hash: compileLevel(retro()).hash };
    expect(castStars(compileLevel(braced(retro({ stars }))))).toEqual(stars);
    expect(castStars(compileLevel(braced(retro({ stars, crownLine: 2 }))))).toBeUndefined();
  });
});

describe('the retrofit candidate sites', () => {
  it('compile and validate clean, protected towers only, the level\'s quake fixed and the build block the retrofit bin', () => {
    for (const id of Object.keys(RETROFIT_SITES)) {
      const def = retrofitCandidate(id), c = compileLevel(def);
      expect(validateLevel(c).filter((i) => !i.warning), id).toEqual([]);
      expect(c.meta.crowns.length, id).toBe(0);
      expect(c.meta.heritage.length, id).toBe(RETROFIT_SITES[id]!.towers.filter((t) => t.role === 'protected').length);
      expect(quakeRulesOf(def).fixed, id).toMatchObject(RETROFIT_QUAKE);
      expect(def.build, id).toEqual(RETROFIT_BUILD);
    }
  });
});

describe('the shipped retrofit levels', () => {
  const SITE: Record<string, string> = { A6: 'RC-1', A7: 'RC-2' };

  it('are the gated sites exactly, in the Aftershock series, with a budget of at most 200 and stars on what was built', () => {
    expect(RETROFIT_LEVELS.map((l) => l.id)).toEqual(Object.keys(SITE));
    expect(AFTERSHOCK_LEVELS.slice(-RETROFIT_LEVELS.length)).toEqual(RETROFIT_LEVELS);
    for (const l of RETROFIT_LEVELS) {
      const c = compileLevel(l), site = compileLevel(retrofitCandidate(SITE[l.id]!));
      expect(validateLevel(c).filter((i) => !i.warning), l.id).toEqual([]);
      // The physics the gate judged: the same bodies and the same quake; the id, name, budget and stars are not physics.
      expect({ ...c.scene, id: '' }).toEqual({ ...site.scene, id: '' });
      expect(quakeRulesOf(l).fixed).toEqual(quakeRulesOf(site.def).fixed);
      expect(l.settle).toBe('v3');
      const s = l.stars!, budget = l.build!.budget!;
      expect({ metric: s.metric, engine: s.engine, best: s.best, hash: s.hash }).toEqual({ metric: 'built', engine: 'gpu', best: s.t3, hash: c.baseHash });
      expect(castStars(c)).toBe(s);
      expect(s.t3).toBeLessThanOrEqual(s.t2);
      expect(s.t2).toBeLessThanOrEqual(budget);
      expect(budget).toBeLessThanOrEqual(200);
      expect({ ...l.build, budget: 200 }).toEqual(RETROFIT_BUILD);
      expect(levelById(l.id)).toBe(l);
    }
  });
});

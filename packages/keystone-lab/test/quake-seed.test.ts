// Aftershock's seeded dials on the reference engine (quake-seed.ts, PT25): each seed is inside its level's dial and
// budget, does part of the job (a condemned tower down, fewer protected broken: the round scores above 0) on at least
// SEED_ROBUST of SEED_NUDGES nudged builds, and clears the level on at most SEED_CLEAR_MAX. And the search's own
// pieces: the dial distance, the candidates' order, and what counts as part of the job.
import { availableParallelism } from 'node:os';
import { describe, expect, it } from 'vitest';
import { AFTERSHOCK_LEVELS, compileLevel, quakeRefusal, quakeRulesOf, type QuakeShot } from '@tb/keystone';
import { dialDistance, OLD_START, partial, SEED_CLEAR_MAX, SEED_NUDGES, SEED_ROBUST, seedCandidates } from '../src/quake-seed.ts';
import { playQuakeTasks, type QuakeEnd } from '../src/quake-search.ts';

const JOBS = Math.min(4, availableParallelism());
const SEEDED = AFTERSHOCK_LEVELS.filter((l) => quakeRulesOf(l).start);
const shot = (q: Omit<QuakeShot, 'ammo'>): QuakeShot => ({ ammo: 'quake', ...q });

describe('the seed search', () => {
  it('measures dial steps from the old start: 5% g, a frequency or duration stop, 15 degrees (the short way round)', () => {
    expect(dialDistance(OLD_START)).toBe(0);
    expect(dialDistance(shot({ peak: 35, hz: 8, sec: 20, axis: 0 }))).toBe(3);
    expect(dialDistance(shot({ peak: 30, hz: 10, sec: 30, axis: 165 }))).toBe(1);
    expect(dialDistance(shot({ peak: 30, hz: 10, sec: 30, axis: 90 }))).toBe(6);
  });

  it('lists candidates inside the level\'s rules and budget, nearest first', () => {
    const a2 = AFTERSHOCK_LEVELS.find((l) => l.id === 'A2')!, c = compileLevel(a2), cands = seedCandidates(a2, 200);
    expect(cands).toHaveLength(200);
    for (const q of cands) expect(quakeRefusal(c, q)).toBeNull();
    for (let i = 1; i < cands.length; i++) expect(dialDistance(cands[i]!)).toBeGreaterThanOrEqual(dialDistance(cands[i - 1]!));
  });

  it('part of the job: a condemned tower down, fewer protected broken, the level not cleared', () => {
    const a1 = compileLevel(AFTERSHOCK_LEVELS.find((l) => l.id === 'A1')!); // col8 C, col4 P, col7 C, col3 P
    const end = (down: boolean[], standing: boolean[], met = false): QuakeEnd => ({ down, standing, met } as QuakeEnd);
    expect(partial(a1, end([true, false, false, false], [true, true, true, true])).part).toBe(true);
    expect(partial(a1, end([true, false, false, false], [true, false, true, true])).part).toBe(false); // one for one: 0 points
    expect(partial(a1, end([true, false, true, false], [true, false, true, true])).part).toBe(true);
    expect(partial(a1, end([true, false, true, false], [true, true, true, true], true)).part).toBe(false); // cleared
    expect(partial(a1, end([false, true, false, true], [true, true, true, true])).part).toBe(false); // protected towers down count for nothing
  });
});

describe('the shipped seeds on the reference engine', () => {
  for (const level of SEEDED) {
    it(`${level.id} ${level.name}: the seed does part of the job on ${SEED_ROBUST} of ${SEED_NUDGES} builds and clears it on at most ${SEED_CLEAR_MAX}`, async () => {
      const c = compileLevel(level), seed = shot(quakeRulesOf(level).start!);
      expect(quakeRefusal(c, seed)).toBeNull();
      const ends = await playQuakeTasks(level, Array.from({ length: SEED_NUDGES }, (_, k) => ({ quakes: [seed], nudge: k + 1 })), JOBS);
      const per = ends.map((e) => partial(c, e[0]!)), part = per.filter((p) => p.part).length, cleared = per.filter((p) => p.met).length;
      console.log(`${level.id} seed ${JSON.stringify(seed)}: part of the job on ${part}/${SEED_NUDGES}, cleared ${cleared}`);
      expect(part).toBeGreaterThanOrEqual(SEED_ROBUST);
      expect(cleared).toBeLessThanOrEqual(SEED_CLEAR_MAX);
    }, 10 * 60_000);
  }
});

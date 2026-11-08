// Choosing a level's pre-aimed opener (PT13, opener.ts): candidates from a cast's first settles, each judged
// on its worst engine's lower quartile; a winner meets the objective on every play within the promise.
import { describe, expect, it } from 'vitest';
import { B1, type CastPlay, type LevelDef, type Shot, writeShots } from '@tb/keystone';
import { type CastPlayer, judgeOpeners, openerCandidates, openerMarkdown } from '../src/index.ts';

const sample = (collapse: number, step: number) => ({ shots: 1, step, met: collapse >= 0.4, collapse, crowns: 0, skyline: 1, score: 0, heritage: 0, pulled: 0 });
const castOf = (lines: Array<[string, number]>) => ({ level: 'B1', metric: 'collapse' as const, lines: lines.map(([shots, c]) => ({ shots, samples: [sample(c, 900)] })) });

/** A player whose plays of a line score by the line's first shot's azimuth (a stand-in physics), settling at `step`. */
function fakePlayer(engine: string, value: (s: Shot) => number, step = 900): CastPlayer {
  return {
    adapter: 'fake', engine, substeps: 1,
    async play(_level: LevelDef, lines: Shot[][]): Promise<CastPlay[]> {
      return lines.map((l) => ({ samples: [sample(value(l[0]!), step)], complete: true, steps: step, hash: '', limits: [] }));
    },
  };
}
const az = (s: Shot) => ('az' in s ? s.az : 0);

describe('openerCandidates', () => {
  it('takes the first shots with the best first settle, each once, across casts', () => {
    const a = castOf([['w-bomb.100.8.0.300.80_w-bomb.1.8.0.300.80', 0.5], ['w-bomb.200.8.0.300.80', 0.7], ['w-bomb.100.8.0.300.80', 0.6]]);
    const b = castOf([['w-bomb.300.8.0.300.80', 0.3]]);
    expect(openerCandidates([a, b], 2)).toEqual([{ shot: 'w-bomb.200.8.0.300.80', recorded: 0.7 }, { shot: 'w-bomb.100.8.0.300.80', recorded: 0.6 }]);
  });
});

describe('judgeOpeners', () => {
  const cands = [{ shot: 'w-bomb.100.8.0.300.80', recorded: 0.6 }, { shot: 'w-bomb.300.8.0.300.80', recorded: 0.5 }];
  it('ranks on the worst engine: a shot strong on one engine and weak on the other loses', async () => {
    const gpu = fakePlayer('gpu', (s) => (az(s) > 200 ? 0.5 : 0.9));
    const rapier = fakePlayer('rapier', (s) => (az(s) > 200 ? 0.45 : 0.1));
    const j = await judgeOpeners(B1, cands, [gpu, rapier], 4, 1);
    expect(j.map((x) => x.shot)).toEqual(['w-bomb.300.8.0.300.80', 'w-bomb.100.8.0.300.80']);
    expect(j[0]!.wins).toBe(true);
    expect(j[0]!.score).toBeCloseTo(0.45);
    expect(j[1]!.wins).toBe(false);
    expect(j[0]!.trials.map((t) => t.values.length)).toEqual([5, 5]); // exact + 4 nudges on each engine
  });
  it('a floor above the objective holds back a candidate whose every play meets the objective but whose lower quartile is under the floor (PT13 second pass)', async () => {
    const gpu = fakePlayer('gpu', (s) => (az(s) > 200 ? 0.43 : 0.47));
    const j = await judgeOpeners(B1, cands, [gpu], 4, 1, 'collapse', 0.45);
    expect(j.map((x) => [x.shot, x.wins])).toEqual([['w-bomb.100.8.0.300.80', true], ['w-bomb.300.8.0.300.80', false]]);
    expect(j[1]!.score).toBeCloseTo(0.43); // meets B1's 0.4 on every play, short of the 0.45 margin
    expect((await judgeOpeners(B1, cands, [gpu], 4, 1)).every((x) => x.wins)).toBe(true); // no floor: the objective's 0.4
    expect(openerMarkdown(B1, j, 4, 0.45)).toContain('the score reached 0.45');
  });
  it('a play settling after the promise does not win, and the markdown says to fall back', async () => {
    const slow = fakePlayer('gpu', () => 0.9, 300 + 60 * 25);
    const j = await judgeOpeners(B1, cands, [slow], 2, 1);
    expect(j.every((x) => !x.wins)).toBe(true);
    expect(j[0]!.trials[0]!.settleS[0]).toBeCloseTo(25);
    expect(openerMarkdown(B1, j, 2)).toContain('route a first visit through L1');
  });
  it('nudges are seeded: the same seed plays the same lines', async () => {
    const seen: string[][] = [];
    const spy: CastPlayer = { ...fakePlayer('gpu', () => 0.5), async play(_l, lines) { seen.push(lines.map((l) => writeShots(l))); return lines.map(() => ({ samples: [sample(0.5, 900)], complete: true, steps: 900, hash: '', limits: [] })); } };
    await judgeOpeners(B1, cands.slice(0, 1), [spy], 3, 7);
    await judgeOpeners(B1, cands.slice(0, 1), [spy], 3, 7);
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0]![0]).toBe(cands[0]!.shot);
  });
});

// PT31 (docs/game/agent-playtest-2.md, docs/game/scoring.md): leverage paid as each shot's share of what fell, at
// its leverage against the level's gold line, capped (the 'share' rule, LevelDef.levPoints), agreed with the scoring
// owner. Opt-in: the default 'log' rule scores every level as before. Pure functions, no engine.
import { describe, expect, it } from 'vitest';
import {
  checkLevPoints, compileLevel, DEFAULT_GOLD, L1, LEV_POINTS, leveragePeak, leveragePoints, levelScore, logLeveragePoints, outcomeTally, type OutcomeFacts,
  roundLeverage, SHARE_CAP, SHARE_POINTS, shareLine, type ShotOutcome,
} from '@tb/keystone';

const shot = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 1000, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
const SPAN = 1_000_000; // mJ: what could fall
const LINE = 15;

/** A small seeded generator (mulberry32), so the "any sequence" sweep is the same every run. */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("the 'share' leverage points rule (PT31)", () => {
  it('a shot that brings nothing down adds 0, whatever its leverage; so does one that raised the structure', () => {
    expect(leveragePoints([shot({ dPE_mJ: 0, leverage: 500 })], LINE, SPAN, 'share')).toBe(0);
    expect(leveragePoints([shot({ dPE_mJ: -SPAN / 2, leverage: 0 })], LINE, SPAN, 'share')).toBe(0);
    const one = leveragePoints([shot({ dPE_mJ: SPAN / 4, leverage: LINE })], LINE, SPAN, 'share');
    // A 0% shot between two others changes nothing.
    expect(leveragePoints([shot({ dPE_mJ: SPAN / 4, leverage: LINE }), shot({ dPE_mJ: 0, leverage: 99 })], LINE, SPAN, 'share')).toBe(one);
  });

  it('pays SHARE_POINTS for everything down at the gold line, up to SHARE_CAP times that from 3x the line', () => {
    expect(SHARE_POINTS * SHARE_CAP).toBe(1000);
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: LINE })], LINE, SPAN, 'share')).toBe(500);
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: 3 * LINE })], LINE, SPAN, 'share')).toBe(1000);
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: 100 * LINE })], LINE, SPAN, 'share')).toBe(1000);
    // Scaled by what fell: 12% down at the line pays 12% of 500.
    expect(leveragePoints([shot({ dPE_mJ: 0.12 * SPAN, leverage: LINE })], LINE, SPAN, 'share')).toBe(60);
    // L1's opener (J1 #7): x0.70 against a line of 15 brings little, however much fell.
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: 0.7 })], LINE, SPAN, 'share')).toBe(Math.floor(500 * Math.log2(1 + 0.7 / 15)));
  });

  it('a pull (no energy fired, leverage 0) adds 0: its fall pays on the Collapse line', () => {
    expect(leveragePoints([shot({ ke: 0, dPE_mJ: SPAN / 2, leverage: 0 })], LINE, SPAN, 'share')).toBe(0);
  });

  it('is at most 1,000 for any sequence, and never negative', () => {
    const r = rng(31);
    for (let k = 0; k < 2000; k++) {
      const shots = Array.from({ length: 1 + Math.floor(r() * 12) }, () => shot({
        ke: r() * 1000, dPE_mJ: (r() * 3 - 0.5) * SPAN, leverage: r() < 0.1 ? 1e9 : r() * 200,
      }));
      const p = leveragePoints(shots, 1 + r() * 30, SPAN, 'share');
      expect(p, JSON.stringify(shots.map((o) => [o.dPE_mJ, o.leverage]))).toBeLessThanOrEqual(1000);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(p)).toBe(true);
    }
    // The shares never sum past 1: two whole falls at the cap still pay 1,000.
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: 1e6 }), shot({ dPE_mJ: SPAN, leverage: 1e6 })], LINE, SPAN, 'share')).toBe(1000);
  });

  it('pays nothing without a span or a line (a flat level)', () => {
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: LINE })], LINE, 0, 'share')).toBe(0);
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: LINE })], 0, SPAN, 'share')).toBe(0);
    expect(leveragePoints([shot({ dPE_mJ: SPAN, leverage: LINE })], LINE, Number.NaN, 'share')).toBe(0);
  });
});

describe("the default 'log' rule is what every level scored before", () => {
  it("leveragePoints 'log' is 300 log2(1 + roundLeverage), floored", () => {
    const shots = [shot({ ke: 2, dPE_mJ: 30_000, leverage: 15 }), shot({ ke: 1, dPE_mJ: 2_000, leverage: 2 })];
    expect(leveragePoints(shots, LINE, SPAN, 'log')).toBe(Math.floor(300 * Math.log2(1 + roundLeverage(shots))));
    expect(logLeveragePoints(0)).toBe(0);
    expect(logLeveragePoints(1, 300)).toBe(300);
  });

  it('levelScore and outcomeTally pay the log line unless the level names share', () => {
    const shots = [shot({ ke: 2, dPE_mJ: 0.12 * SPAN, leverage: 60 })];
    const L = roundLeverage(shots), logLine = Math.floor(300 * Math.log2(1 + L));
    const lev = (s: { lines: { label: string; value: number }[] }) => s.lines.find((l) => l.label === 'Leverage')!.value;
    expect(lev(levelScore(L1, shots, true, 40))).toBe(logLine);
    expect(lev(levelScore(L1, shots, true, 40, 0, SPAN))).toBe(logLine); // the span changes nothing under log
    expect(lev(levelScore({ ...L1, levPoints: 'share' }, shots, true, 40, 0, SPAN))).toBe(leveragePoints(shots, shareLine(L1), SPAN, 'share'));
    const facts: OutcomeFacts = { met: true, collapse: 0.12, leverage: L, comboMax: 0, hasCrowns: false, rackLeft: 0, heritageBroken: 0, outOfLot: 0, crownsDown: 0, skylineRatio: 1, pulled: 0 };
    expect(outcomeTally(facts).find((l) => l.label === 'Leverage')!.value).toBe(logLine);
    const shared = outcomeTally({ ...facts, levShare: { shots, line: DEFAULT_GOLD, span_mJ: SPAN } }).find((l) => l.label === 'Leverage')!.value;
    expect(shared).toBe(leveragePoints(shots, DEFAULT_GOLD, SPAN, 'share'));
    expect(shared).toBeLessThan(logLine); // T-X2's complaint (J3 #19): 12% down no longer pays most of the score
  });
});

describe('LevelDef.levPoints', () => {
  it("is 'log' or 'share'; 'log' hashes as absent, 'share' as a level of its own", () => {
    expect(LEV_POINTS).toEqual(['log', 'share']);
    expect(checkLevPoints('share')).toBe('share');
    expect(() => checkLevPoints('x', 'keystone.levpoints')).toThrow(/keystone.levpoints must be log or share: x/);
    expect(() => compileLevel({ ...L1, levPoints: 'x' as 'log' })).toThrow(/levPoints must be log or share: x/);
    const h = compileLevel(L1).hash;
    expect(compileLevel({ ...L1, levPoints: 'log' }).hash).toBe(h);
    expect(compileLevel({ ...L1, levPoints: 'share' }).hash).not.toBe(h);
  });

  it("the share line is the level's gold line, else DEFAULT_GOLD", () => {
    expect(shareLine(L1)).toBe(L1.lGold ?? DEFAULT_GOLD);
    expect(shareLine({ ...L1, lGold: 4 })).toBe(4);
    expect(shareLine({ ...L1, scoring: 'outcome', lGold: undefined })).toBe(DEFAULT_GOLD);
  });
});

describe('leveragePeak (the card names a drop from it, PT31 follow-up)', () => {
  it('is the highest running roundLeverage, the last shot it stood at, and the later shots\' own', () => {
    // B3 on Metal: x5.09 after two bombs, x0.01 from the third, x3.40 for the round.
    const b3 = [shot({ ke: 1, dPE_mJ: 5090 }), shot({ ke: 1, dPE_mJ: 5090 }), shot({ ke: 1, dPE_mJ: 10 })];
    const p = leveragePeak(b3)!;
    expect(p.after).toBe(2);
    expect(p.peak).toBeCloseTo(roundLeverage(b3.slice(0, 2)), 12);
    expect(p.later).toBeCloseTo(roundLeverage(b3.slice(2)), 12);
    expect(roundLeverage(b3)).toBeLessThan(0.7 * p.peak);
    // Rising to the end: the peak is the round's own figure, with no later shots.
    const up = [shot({ ke: 1, dPE_mJ: 100 }), shot({ ke: 1, dPE_mJ: 9000 })];
    expect(leveragePeak(up)).toEqual({ peak: roundLeverage(up), after: 2, later: 0 });
    expect(leveragePeak([])).toBeNull();
  });
});

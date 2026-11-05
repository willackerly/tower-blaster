// Tagged reductions (groups.ts) and side goals (goals.ts) on synthetic body states: no engine.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import {
  checkLotSheet, compileLevel, type Goal, goalMet, type GoalPred, gradeOf, judgeGoals, type LevelDef, type LotSheet, reduceGroup, roundFacts, type RoundState,
  selectGroup, selectGroups, type ShotOutcome, shownGoals,
} from '@tb/keystone';

// Two towers (parts 0 and 1, west and east), a stone crown course on the east one, a heritage cube.
const def: LevelDef = {
  id: 'G', name: 'g', version: 1, world: 0, lot: { min: [-6, -4], max: [6, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'marble', 'cannonball'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [-4, 0, 0], size: [1, 4, 1], material: 'plaster' },
    { kind: 'block', at: [3, 0, 0], size: [1, 4, 1], material: 'plaster', courses: [{ k: 3, role: 'crown', material: 'stone' }] },
    { kind: 'block', at: [0, 0, 2], size: [1, 1, 1], material: 'plaster', role: 'heritage' },
  ],
};
const c = compileLevel(def);
const n = c.meta.n, h = c.frame.unit;

function world(): Snapshot {
  const s = emptySnapshot(n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < n; i++) s.rot[4 * i + 3] = 1;
  return s;
}
/** Lay body i flat on the ground at its x, 3 h along z (displaced and down). */
const fell = (s: Snapshot, i: number) => { s.pos[3 * i + 1] = 0.5 * h; s.pos[3 * i + 2] = s.pos[3 * i + 2]! + 3 * c.frame.pitch * h; };

const outcome = (o: Partial<ShotOutcome>): ShotOutcome => ({ ke: 100, yield: 0, dPE_mJ: 0, leverage: 0, crownsDown: 0, crownsTotal: 0, heritageNew: 0, displaced: 0, outOfLot: 0, pe_mJ: 0, spawnStep: 0, settleStep: 0, ...o });
function round(o: Partial<RoundState> = {}): RoundState {
  return {
    phase: 'aiming', rackLeft: ['marble', 'cannonball'], outcomes: [outcome({})], inputs: [{ step: 0, shot: { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 100 } }],
    crownDown: new Uint8Array(c.meta.crowns.length), heritageBroken: new Uint8Array(c.meta.heritage.length), score: null, home: c.meta.home.slice(), ...o,
  };
}

describe('groups (C6 tagged reductions)', () => {
  it('selects by part, role, material and region, all conditions together', () => {
    expect(Array.from(selectGroup(c, { parts: [0] }))).toEqual([0, 1, 2, 3]);
    expect(selectGroup(c, { parts: [1] })).toHaveLength(4);
    expect(Array.from(selectGroup(c, { roles: ['crown'] }))).toEqual(Array.from(c.meta.crowns));
    expect(Array.from(selectGroup(c, { materials: ['stone'] }))).toEqual(Array.from(c.meta.crowns));
    expect(selectGroup(c, { materials: ['plaster'] })).toHaveLength(n - 1);
    // West of x = 0 cells, courses 0 and 1 (centres at 0.5 h and 1.5 h).
    expect(Array.from(selectGroup(c, { box: { min: [-10, 0, -10], max: [0, 2, 10] } }))).toEqual([0, 1]);
    expect(selectGroup(c, { parts: [0], roles: ['crown'] })).toHaveLength(0);
    expect(selectGroup(c, {})).toHaveLength(n);
  });

  it('refuses a malformed selector, naming it', () => {
    expect(() => selectGroup(c, { parts: [3] }, 'groups.x')).toThrow(/groups\.x\.parts: 3 is not a part of G/);
    expect(() => selectGroup(c, { roles: ['king' as never] })).toThrow(/unknown role king/);
    expect(() => selectGroup(c, { materials: ['wood' as never] })).toThrow(/unknown material wood/);
    expect(() => selectGroup(c, { box: { min: [1, 0, 0], max: [0, 1, 1] } })).toThrow(/axis x needs finite min <= max/);
    expect(() => selectGroup(c, { part: [0] } as never)).toThrow(/unknown field part/);
  });

  it('counts down, displaced and out of the lot, and sums potential energy exactly', () => {
    const s = world(), east = selectGroup(c, { parts: [1] });
    const r0 = reduceGroup(s, c, east);
    expect(r0).toMatchObject({ n: 4, down: 0, displaced: 0, outOfLot: 0 });
    expect(r0.pe_mJ).toBe(r0.pe0_mJ);
    fell(s, east[3]!);
    fell(s, east[2]!);
    s.pos[3 * east[2]! + 2] = 10 * c.frame.pitch * h; // and out of the lot
    const r1 = reduceGroup(s, c, east);
    expect(r1).toMatchObject({ n: 4, down: 2, displaced: 2, outOfLot: 1 });
    expect(r1.pe_mJ).toBeLessThan(r1.pe0_mJ);
    // The same sum in any body order.
    expect(reduceGroup(s, c, Int32Array.from([...east].reverse())).pe_mJ).toBe(r1.pe_mJ);
  });

  it('judges displacement against the home it is given', () => {
    const s = world(), home = c.meta.home.slice();
    home[1] = home[1]! + h; // body 0 started a cube higher than it stands now
    expect(reduceGroup(s, c, Int32Array.of(0), home).displaced).toBe(1);
    expect(reduceGroup(s, c, Int32Array.of(0)).displaced).toBe(0);
  });
});

describe('goals (C3 predicates)', () => {
  const groups = selectGroups(c, { west: { parts: [0] }, east: { parts: [1] } });

  it('reads whole-round facts', () => {
    const s = world();
    fell(s, c.meta.crowns[0]!);
    const crownDown = Uint8Array.of(1);
    const f = roundFacts(c, round({ phase: 'cleared', crownDown, outcomes: [outcome({ crownsDown: 1 })] }), s, groups);
    expect(f.round).toMatchObject({ cleared: 1, shots: 1, rackLeft: 2, crowns: 1, crownsLeft: 0, heritage: 0, comboMax: 1, score: 0, stars: 0 });
    expect(f.round.collapse).toBeGreaterThan(0);
    expect(f.round.collapse).toBeLessThan(1);
    expect(f.round.skyline).toBeCloseTo(1, 9); // the west tower still reaches the top
    expect(f.used).toEqual({ any: 1, marble: 1 });
    const flat = world();
    for (let i = 0; i < n; i++) flat.pos[3 * i + 1] = 0.5 * h;
    expect(roundFacts(c, round(), flat).round.collapse).toBe(1);
    expect(roundFacts(c, round(), world()).round.collapse).toBe(0);
  });

  it('evaluates terms, groups as shares or counts, items, shots and combinators', () => {
    const s = world();
    for (const i of groups.east!) fell(s, i);
    const f = roundFacts(c, round(), s, groups);
    const yes: GoalPred[] = [
      { group: 'east', of: 'displaced', op: '==', value: 1 },
      { group: 'east', of: 'down', op: '==', value: 0.75 }, // the bottom course slid: displaced, not down
      { group: 'west', of: 'displaced', op: '==', value: 0 },
      { group: 'west', of: 'standing', count: true, op: '==', value: 4 },
      { used: 'cannonball', op: '==', value: 0 },
      { used: 'any', op: '<=', value: 1 },
      { shot: 1, fact: 'crownsDown', op: '==', value: 0 },
      { all: [{ fact: 'shots', op: '==', value: 1 }, { not: { fact: 'heritage', op: '>', value: 0 } }] },
      { any: [{ fact: 'cleared', op: '==', value: 1 }, { fact: 'rackLeft', op: '>=', value: 2 }] },
    ];
    for (const p of yes) expect(goalMet(p, f), JSON.stringify(p)).toBe(true);
    const no: GoalPred[] = [
      { group: 'west', of: 'down', op: '>', value: 0.5 },
      { shot: 2, fact: 'crownsDown', op: '>=', value: 0 }, // a shot not fired fails, whatever the op
      { not: { fact: 'shots', op: '==', value: 1 } },
      { all: [{ fact: 'shots', op: '==', value: 1 }, { fact: 'cleared', op: '==', value: 1 }] },
    ];
    for (const p of no) expect(goalMet(p, f), JSON.stringify(p)).toBe(false);
  });

  it('grades a round by the band its metric reaches', () => {
    const g = { metric: 'collapse' as const, cuts: [0.1, 0.2, 0.3, 0.4, 0.5] as [number, number, number, number, number], source: 'test' };
    const f = (collapse: number) => ({ round: { collapse } } as never);
    expect([0.05, 0.1, 0.25, 0.45, 0.9].map((x) => gradeOf(g, f(x)))).toEqual([null, 'E', 'D', 'B', 'A']);
    const sky = { metric: 'skyline' as const, cuts: [0.9, 0.8, 0.7, 0.6, 0.5] as [number, number, number, number, number], source: 'test' };
    expect(gradeOf(sky, { round: { skyline: 0.65 } } as never)).toBe('C');
    expect(gradeOf(undefined, f(1))).toBeNull();
  });

  const goal = (o: Partial<Goal>): Goal => ({ id: 'a', text: 'A', when: { fact: 'cleared', op: '==', value: 1 }, proof: 'marble.0.4.0.0.100', ...o });
  const sheet = (o: Partial<LotSheet>): LotSheet => ({ level: 'G', engine: 'ref', groups: { east: { parts: [1] } }, goals: [goal({})], ...o });

  it('checks a sheet against its level, naming the fault', () => {
    expect(() => checkLotSheet(c, sheet({}))).not.toThrow();
    const bad: Array<[Partial<LotSheet>, RegExp]> = [
      [{ level: 'L1' }, /is for L1, not G/],
      [{ goals: [] }, /needs 1 to 8 goals/],
      [{ goals: [goal({ id: 'A b' })] }, /id must be/],
      [{ goals: [goal({}), goal({})] }, /id used twice/],
      [{ goals: [goal({ text: ' ' })] }, /text is empty/],
      [{ goals: [goal({ when: { group: 'north', of: 'down', op: '>=', value: 1 } })] }, /no group north/],
      [{ goals: [goal({ when: { used: 'drop', op: '==', value: 0 } })] }, /used drop is not in G's rack/],
      [{ goals: [goal({ when: { shot: 4, fact: 'leverage', op: '>=', value: 1 } })] }, /shot must be from 1 to 3/],
      [{ goals: [goal({ when: { fact: 'luck' as never, op: '>=', value: 1 } })] }, /fact must be one of/],
      [{ goals: [goal({ when: { fact: 'shots', op: '=' as never, value: 1 } })] }, /op must be one of/],
      [{ goals: [goal({ when: { all: [] } })] }, /non-empty list/],
      [{ goals: [goal({ proof: 'cannonball.0.4.0.0.100_cannonball.0.4.0.0.100' })] }, /fires 2 cannonball, the rack holds 1/],
      [{ groups: { none: { parts: [0], roles: ['crown'] } } }, /groups\.none holds no bodies/],
      [{ grades: { metric: 'collapse', cuts: [0.5, 0.4, 0.6, 0.7, 0.8], source: '' } }, /harder from E to A/],
    ];
    for (const [o, re] of bad) expect(() => checkLotSheet(c, sheet(o)), re.source).toThrow(re);
  });

  it('judges goals in sheet order and shows only proven ones unless asked', () => {
    const s = sheet({ goals: [goal({ id: 'one' }), goal({ id: 'two', when: { fact: 'shots', op: '<=', value: 1 }, proof: undefined })] });
    const f = roundFacts(c, round(), world(), selectGroups(c, s.groups!));
    expect(judgeGoals(s, f)).toEqual([{ id: 'one', met: false }, { id: 'two', met: true }]);
    expect(shownGoals(s).map((g) => g.id)).toEqual(['one']);
    expect(shownGoals(s, true).map((g) => g.id)).toEqual(['one', 'two']);
  });
});

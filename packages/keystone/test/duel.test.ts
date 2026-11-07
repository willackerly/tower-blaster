// The Siege Table's turn controller (duel.ts) on synthetic body states, and its tables (duels.ts) validated.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { checkDuel, compileLevel, D1, D2, Duel, type DuelDef, duelLevel, DUELS, findDuel, inArc, type Shot, validateLevel } from '@tb/keystone';

const shotAt = (az: number, ammo: Shot['ammo'] = 'cannonball'): Shot => ({ ammo, az, y: 8, yaw: 0, pitch: 100, power: 100 } as Shot);
const WEST = 360, EAST = 0;

function world(def: DuelDef) {
  const c = compileLevel(duelLevel(def));
  const s = emptySnapshot(c.meta.n);
  s.pos.set(c.meta.home);
  for (let i = 0; i < c.meta.n; i++) s.rot[4 * i + 3] = 1;
  return { c, s };
}
/** Drop the bodies of `parts` to the ground where they stand. */
const flatten = (c: ReturnType<typeof world>['c'], s: Snapshot, parts: number[], keep = 0) => {
  let k = 0;
  for (let i = 0; i < c.meta.n; i++) if (parts.includes(c.meta.part[i]!) && k++ >= keep) s.pos[3 * i + 1] = 0.5 * c.frame.unit;
};

describe('duel tables', () => {
  it.each(DUELS.map((d) => [d.id, d] as const))('%s compiles to a valid uncast outcome level for either player first', (_id, def) => {
    for (const first of [0, 1] as const) {
      const lv = duelLevel(def, first), c = compileLevel(lv);
      expect(lv).toMatchObject({ scoring: 'outcome', autobank: false, custom: true, par: lv.rack.length });
      expect(lv.rack).toHaveLength(def.sides[0].rack.length + def.sides[1].rack.length);
      expect(lv.rack[0]).toBe(def.sides[first].rack[0]);
      expect(lv.id).toBe(first === 0 ? def.id : `${def.id}-2`);
      const errors = validateLevel(c).filter((x) => !x.warning);
      expect(errors, JSON.stringify(errors)).toEqual([]);
      expect(() => checkDuel(def, c)).not.toThrow();
    }
  });

  it('finds a table by id or ruleset, any case', () => {
    expect(findDuel('d2')).toBe(D2);
    expect(findDuel('KEEPS')).toBe(D1);
    expect(findDuel('chess')).toBeUndefined();
  });

  it('refuses a malformed duel, naming the fault', () => {
    const c = compileLevel(duelLevel(D1));
    const bad = (o: Partial<DuelDef> | ((d: DuelDef) => DuelDef)) => () => checkDuel(typeof o === 'function' ? o(structuredClone(D1)) : { ...D1, ...o }, c);
    expect(bad({ ruleset: 'chess' as never })).toThrow(/ruleset must be/);
    expect(bad((d) => { d.sides[1].owns = { parts: [0] }; return d; })).toThrow(/own bodies in common/);
    expect(bad((d) => { d.sides[0].king = { parts: [3] }; return d; })).toThrow(/king must be part of what the side owns/);
    expect(bad((d) => { d.sides[0].arc = [0, 720]; return d; })).toThrow(/arc needs azimuths/);
    expect(bad((d) => { d.sides[0].rack = []; return d; })).toThrow(/rack is empty/);
    expect(bad({ fallShare: 1 })).toThrow(/fallShare/);
    expect(bad({ turnSeconds: 0 })).toThrow(/turnSeconds/);
  });

  it('arcs wrap through 0', () => {
    expect([200, 360, 520, 199, 521].map((a) => inArc(a, [200, 520]))).toEqual([true, true, true, false, false]);
    expect([560, 719, 0, 160, 161, 559].map((a) => inArc(a, [560, 160]))).toEqual([true, true, true, true, false, false]);
  });
});

describe('Duel, Two Keeps', () => {
  it('alternates turns, refuses the wrong side, an empty item and a shot while one is in the air', () => {
    const { c, s } = world(D1), d = new Duel(D1, c);
    expect(d.turn).toBe(0);
    expect(d.refuse(shotAt(EAST))).toMatchObject({ why: 'arc' });
    expect(d.refuse(shotAt(WEST, 'marble'))).toMatchObject({ why: 'rack' });
    expect(d.refuse(shotAt(WEST))).toBeNull();
    d.fired(shotAt(WEST));
    expect(d.refuse(shotAt(WEST))).toMatchObject({ why: 'over', message: /settle/ });
    expect(() => d.fired(shotAt(WEST))).toThrow(/settle/);
    expect(d.settled(s)).toEqual({ over: false });
    expect(d.turn).toBe(1);
    expect(d.sides[0]).toMatchObject({ shotsLeft: 3, share: 1, kingDown: false });
    expect(d.refuse(shotAt(WEST))).toMatchObject({ why: 'arc' });
    d.fired(shotAt(EAST));
    d.settled(s);
    expect(d.turn).toBe(0);
    expect(d.log.map((x) => x.player)).toEqual([0, 1]);
  });

  // PT5 (agent playtest 1): one shot ended a duel before the other side fired. A round now ends before the duel does.
  it('decides at the end of a round: the answer comes first, then the other king down wins and your own loses', () => {
    /** First player's shot downs `first`; the answer (if asked) downs `answer`. */
    const run = (first: number[], answer: number[] | null, by: 0 | 1 = 0) => {
      const { c, s } = world(D1), d = new Duel(D1, c, by), az = (p: number) => (p === 0 ? WEST : EAST);
      d.fired(shotAt(az(by)));
      flatten(c, s, first);
      const r = d.settled(s);
      if (answer === null) return { d, r };
      expect(r).toEqual({ over: false });
      expect(d.answering).toBe(1 - by);
      expect(d.turn).toBe(1 - by);
      d.fired(shotAt(az(1 - by)));
      flatten(c, s, answer);
      return { d, r: d.settled(s) };
    };
    expect(run([3], []).r).toMatchObject({ over: true, winner: 0, why: "Blue's keep fell" });
    expect(run([2], []).r).toMatchObject({ over: true, winner: 1, why: 'Gold toppled its own keep' });
    // The answer brings Gold's king down too: a round both keeps fell in is a draw.
    expect(run([3], [2]).r).toMatchObject({ over: true, winner: null, why: 'both keeps fell in one round' });
    // An own goal answered by an own goal: a draw too.
    expect(run([2], [3]).r).toMatchObject({ over: true, winner: null });
    // Blue went first and toppled its own keep; Gold's answer misses: Gold wins.
    expect(run([3], [], 1).r).toMatchObject({ over: true, winner: 0, why: 'Blue toppled its own keep' });
    // Both down on one shot: nothing is left to answer, and the shooter loses at once.
    const both = run([2, 3], null, 1);
    expect(both.r).toMatchObject({ over: true, winner: 0, why: 'Blue toppled both keeps' });
    expect(both.d.log).toHaveLength(1);
  });

  it('a keep that falls to the answer ends the duel at once (the round is complete)', () => {
    const { c, s } = world(D1), d = new Duel(D1, c);
    d.fired(shotAt(WEST)); expect(d.settled(s)).toEqual({ over: false });
    d.fired(shotAt(EAST)); flatten(c, s, [2]);
    expect(d.settled(s)).toMatchObject({ over: true, winner: 1, why: "Gold's keep fell" });
    expect(d.sides.map((x) => x.fired)).toEqual([1, 1]);
  });

  it('a side with no shots left owes no answer', () => {
    const lopsided: DuelDef = { ...D1, sides: [{ ...D1.sides[0], rack: ['cannonball', 'cannonball'] }, { ...D1.sides[1], rack: ['cannonball'] }] };
    const { c, s } = world(lopsided), d = new Duel(lopsided, c);
    d.fired(shotAt(WEST)); d.settled(s);
    d.fired(shotAt(EAST)); d.settled(s);
    d.fired(shotAt(WEST)); flatten(c, s, [3]);
    expect(d.answering).toBeNull();
    expect(d.settled(s)).toMatchObject({ over: true, winner: 0 });
  });

  it('with both racks spent, the keep with more standing wins, and alike is a draw', () => {
    for (const [hurt, winner] of [[[0], 1], [[1], 0], [[], null]] as const) {
      const { c, s } = world(D1), d = new Duel(D1, c);
      let r = d.result;
      for (let k = 0; k < 8; k++) {
        d.fired(shotAt(d.turn === 0 ? WEST : EAST, k < 6 ? 'cannonball' : 'w-grenade'));
        if (k === 7) flatten(c, s, [...hurt], 30); // part of a keep comes down, its king stays up
        r = d.settled(s);
        if (k < 7) expect(r.over).toBe(false);
      }
      expect(r).toMatchObject({ over: true, winner });
      expect(d.sides[0].shotsLeft + d.sides[1].shotsLeft).toBe(0);
    }
  });

  it('passes the turn back when the other player has no shots left', () => {
    const lopsided: DuelDef = { ...D1, sides: [{ ...D1.sides[0], rack: ['cannonball', 'cannonball'] }, { ...D1.sides[1], rack: ['cannonball'] }] };
    const { c, s } = world(lopsided), d = new Duel(lopsided, c);
    d.fired(shotAt(WEST)); d.settled(s);
    d.fired(shotAt(EAST)); d.settled(s);
    expect(d.turn).toBe(0);
    d.fired(shotAt(WEST));
    expect(d.settled(s)).toMatchObject({ over: true, winner: null });
  });
});

describe('Duel, Heraldry', () => {
  it("scores each shot: the rival's blocks it brought down, less your own", () => {
    const { c, s } = world(D2), d = new Duel(D2, c);
    const down = (part: number, keep = 0) => flatten(c, s, [part], keep);
    // D2's parts are half-courses: 2k + 0 the south half of course k, 2k + 1 the north, six blocks each; the top course is 22 (blue) and 23 (gold).
    expect(new Duel(D2, c).owned.map((g) => g.length)).toEqual([72, 72]);
    d.fired(shotAt(WEST));
    down(22); down(23, 4); // the top course's blue half (6 blocks) and 2 of its gold half
    d.settled(s);
    expect(d.sides.map((x) => x.points)).toEqual([6 - 2, 0]);
    d.fired(shotAt(EAST));
    down(21); // 6 blue blocks down on Blue's own shot
    d.settled(s);
    expect(d.sides.map((x) => x.points)).toEqual([4, -6]);
    for (let k = 2; k < 8; k++) { d.fired(shotAt(d.turn === 0 ? WEST : EAST, k < 4 ? 'cannonball' : 'marble')); d.settled(s); }
    expect(d.result).toMatchObject({ over: true, winner: 0, why: 'Gold scored more' });
  });

  it('tallies each shot for the score float: rival blocks down, own blocks down, points', () => {
    const { c, s } = world(D2), d = new Duel(D2, c);
    d.fired(shotAt(WEST));
    flatten(c, s, [22]); flatten(c, s, [23], 4);
    d.settled(s);
    expect(d.lastShot).toEqual({ player: 0, rival: 6, own: 2, points: 4 });
    expect(d.sides[0].struck).toBe(6);
  });

  // PT5: at 95% down the tower had nothing left to hit and the duel ran on for two more turns.
  it('ends at the end of the round the tower falls to endShare, on points', () => {
    const { c, s } = world(D2), d = new Duel(D2, c);
    d.fired(shotAt(WEST));
    flatten(c, s, Array.from({ length: 24 }, (_, k) => k)); // all on the ground: only the bottom course (12 of 144) has not dropped
    expect(d.settled(s)).toEqual({ over: false }); // Blue answers first
    expect(d.standingShare).toBeCloseTo(12 / 144);
    d.fired(shotAt(EAST));
    const r = d.settled(s);
    expect(r).toMatchObject({ over: true, why: /, the tower is down$/ });
    expect(d.sides[0].shotsLeft + d.sides[1].shotsLeft).toBe(6);
  });

  it('level on points: the side that brought down more of the other\'s blocks wins', () => {
    const { c, s } = world(D2), d = new Duel(D2, c);
    d.fired(shotAt(WEST)); flatten(c, s, [22, 23]); d.settled(s); // 6 blue, 6 gold: Gold 0 pts, struck 6
    for (let k = 1; k < 8; k++) { d.fired(shotAt(d.turn === 0 ? WEST : EAST, k < 4 ? 'cannonball' : 'marble')); d.settled(s); }
    expect(d.sides.map((x) => [x.points, x.struck])).toEqual([[0, 6], [0, 0]]);
    expect(d.result).toMatchObject({ over: true, winner: 0, why: 'level on points, Gold brought down more' });
  });

  it('keeps going while more than endShare stands', () => {
    const { c, s } = world(D2), d = new Duel(D2, c);
    d.fired(shotAt(WEST)); flatten(c, s, [23, 22, 21, 20, 19, 18, 17, 16]); d.settled(s);
    d.fired(shotAt(EAST));
    expect(d.settled(s)).toEqual({ over: false });
    expect(() => checkDuel({ ...D2, endShare: 1 }, c)).toThrow(/endShare/);
  });
});

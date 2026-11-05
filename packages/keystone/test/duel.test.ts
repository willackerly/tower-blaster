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

  it('the other king down wins at once; your own king down loses; both down: the shooter loses', () => {
    const run = (parts: number[], shooter: 0 | 1) => {
      const { c, s } = world(D1), d = new Duel(D1, c, shooter);
      d.fired(shotAt(shooter === 0 ? WEST : EAST));
      flatten(c, s, parts);
      return d.settled(s);
    };
    expect(run([3], 0)).toMatchObject({ over: true, winner: 0, why: "Blue's keep fell" });
    expect(run([2], 0)).toMatchObject({ over: true, winner: 1, why: 'Gold toppled its own keep' });
    expect(run([2, 3], 1)).toMatchObject({ over: true, winner: 0, why: 'Blue toppled both keeps' });
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
    d.fired(shotAt(WEST));
    down(11); down(10, 4); // the top course (blue, 9 blocks) and 5 of the gold course under it
    d.settled(s);
    expect(d.sides.map((x) => x.points)).toEqual([9 - 5, 0]);
    d.fired(shotAt(EAST));
    down(9); // 9 blue blocks down on Blue's own shot
    d.settled(s);
    expect(d.sides.map((x) => x.points)).toEqual([4, -9]);
    for (let k = 2; k < 8; k++) { d.fired(shotAt(d.turn === 0 ? WEST : EAST, k < 4 ? 'cannonball' : 'marble')); d.settled(s); }
    expect(d.result).toMatchObject({ over: true, winner: 0, why: 'Gold scored more' });
  });
});

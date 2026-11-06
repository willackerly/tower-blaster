// Bullet Time's freeze budget (C2, docs/game/undercut-bullet-time.md): LevelDef.freeze caps the
// shots that go in while another runs (each cuts it, rapid fire); shots fired while aiming spend
// nothing; the budget is part of the level (its hash, validation, stars). Synthetic body states,
// no engine.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, type Snapshot } from '@tb/engine-api';
import { B1, castStars, compileLevel, CpuObserver, freezeProblem, type LevelDef, MAX_FREEZE, Session, type Shot, validateLevel } from '@tb/keystone';

const base: LevelDef = {
  id: 'F', name: 'f', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['marble', 'marble', 'marble', 'marble'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [{ kind: 'block', at: [0, 0, 0], size: [1, 3, 1], material: 'plaster', courses: [{ k: 2, role: 'crown' }] }],
};
const marble: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 100 };

function world(c: ReturnType<typeof compileLevel>, ammo: number): Snapshot {
  const s = emptySnapshot(c.meta.n + ammo);
  s.pos.set(c.meta.home);
  for (let i = 0; i < s.count; i++) s.rot[4 * i + 3] = 1;
  return s;
}

/** A session on `def` with one shot running, and a way to cut it at `step` with another. */
function running(def: LevelDef) {
  const c = compileLevel(def), se = new Session(c), s = world(c, 4), obs = new CpuObserver(c, s);
  se.fire(marble, 0);
  const cut = (step: number) => se.fire(marble, step, undefined, obs.peek(s, step, se.watchIdx));
  return { se, cut };
}

describe('freeze budget', () => {
  it('no budget: rapid fire is unlimited (freezesLeft Infinity)', () => {
    const { se, cut } = running(base);
    expect(se.freezesLeft).toBe(Infinity);
    cut(5); cut(9); cut(12);
    expect(se.inputs.map((i) => i.shot.after)).toEqual([undefined, 5, 4, 3]);
    expect(se.freezesLeft).toBe(Infinity);
  });

  it('freeze 2: two shots may cut, the third must wait for the settle; each cut spends one', () => {
    const { se, cut } = running({ ...base, freeze: 2 });
    expect(se.freezesLeft).toBe(2);
    cut(5);
    expect(se.freezesLeft).toBe(1);
    cut(9);
    expect(se.freezesLeft).toBe(0);
    expect(se.phase).toBe('running');
    expect(se.canFire('marble')).toBe(false);
    expect(() => cut(12)).toThrow(/no freezes left \(the level gives 2\)/);
    // The refused shot took nothing: the rack and the record are as they were.
    expect(se.rackLeft).toEqual(['marble']);
    expect(se.inputs).toHaveLength(3);
  });

  it('freeze 0: no shot may go in while another runs (the rules\' own "rapid fire off")', () => {
    const { se, cut } = running({ ...base, freeze: 0 });
    expect(se.canFire('marble')).toBe(false);
    expect(() => cut(5)).toThrow(/no freezes left \(the level gives 0\)/);
  });

  it('a shot fired while aiming spends nothing', () => {
    const se = new Session(compileLevel({ ...base, freeze: 1 }));
    se.fire({ ...marble, after: 3 }, 0); // `after` on a shot from aiming is dropped, as rapid fire records it
    expect(se.freezesLeft).toBe(1);
  });

  it('is part of the level: validated, hashed apart, and drops cast stars', () => {
    expect(freezeProblem(0)).toBeNull();
    expect(freezeProblem(MAX_FREEZE)).toBeNull();
    for (const bad of [-1, MAX_FREEZE + 1, 1.5, NaN]) expect(freezeProblem(bad), String(bad)).toMatch(/freeze must be a whole number from 0 to 9/);
    expect(validateLevel(compileLevel({ ...base, freeze: 3 })).filter((i) => i.code === 'freeze')).toEqual([]);
    expect(validateLevel(compileLevel({ ...base, freeze: 12 })).filter((i) => i.code === 'freeze')).toEqual([{ code: 'freeze', message: 'freeze must be a whole number from 0 to 9: 12' }]);
    const h = compileLevel(base).hash;
    expect(compileLevel({ ...base, freeze: 3 }).hash).not.toBe(h);
    expect(compileLevel({ ...base, freeze: 0 }).hash).not.toBe(compileLevel({ ...base, freeze: 3 }).hash);
    expect(castStars(compileLevel(B1))).toBe(B1.stars);
    expect(castStars(compileLevel({ ...B1, freeze: 3 }))).toBeUndefined();
  });
});

// The pull rack item (C1, docs/game/undercut-bullet-time.md): a shot that removes a
// structure body. Here without an engine: the item, its shot text and record code,
// its event, its nominal energy and what Session refuses. keystone-lab pull.test.ts
// plays pulls on real engines.
import { describe, expect, it } from 'vitest';
import { massOf } from '@tb/engine-api';
import {
  ammoBody, checkShot, compileLevel, decodeRecord, encodeRecord, isLaunchItem, isRackItem, itemBodies, itemRef, itemSpec, type LevelDef, MAX_PULL_BODY,
  pullEnergy, rackBodies, readShots, Session, type SessionRecord, type Shot, shotEvent, shotToSpawn, validateLevel, writeShots,
} from '@tb/keystone';

const def: LevelDef = {
  id: 'P', name: 'p', version: 1, world: 0, lot: { min: [-4, -4], max: [4, 4] }, crownLine: 2, objective: { kind: 'crowns' }, par: 1,
  rack: ['pull', 'pull', 'marble'], launcher: { radius: 10, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [0, 0, 0], size: [1, 3, 1], material: 'plaster', courses: [{ k: 2, role: 'crown' }] },
    { kind: 'block', at: [2, 0, 0], size: [1, 1, 1], material: 'plaster', role: 'heritage' },
  ],
};
const c = compileLevel(def);
const crown = c.meta.crowns[0]!, heritage = c.meta.heritage[0]!;

describe('pull: the item', () => {
  it('is a rack item that is not launched, spawns no body and has no item spec', () => {
    expect(isRackItem('pull')).toBe(true);
    expect(itemRef('pull')).toEqual({ kind: 'pull' });
    expect(isLaunchItem('pull')).toBe(false);
    expect(itemBodies('pull')).toBe(0);
    expect(rackBodies(['pull', 'pull', 'marble'])).toBe(1);
    expect(() => itemSpec('pull', c.frame)).toThrow(/pull fires no body/);
  });

  it('passes level validation in a rack (no ammo-ratio, tunnelling or dud issue for it)', () => {
    expect(validateLevel(c).filter((i) => /pull/.test(i.message))).toEqual([]);
  });

  it('round-trips through shot text and records, and old records decode unchanged', () => {
    const shots: Shot[] = [{ ammo: 'pull', body: 0 }, { ammo: 'marble', az: 60, y: 8, yaw: -3, pitch: 20, power: 95 }, { ammo: 'pull', body: 123456 }];
    expect(writeShots(shots)).toBe('pull.0_marble.60.8.-3.20.95_pull.123456');
    expect(readShots(writeShots(shots))).toEqual(shots);
    expect(() => readShots('pull')).toThrow(/pull takes 1 fields \(body\), got 0/);
    expect(() => readShots('pull.-1')).toThrow(/shot\.body = -1/);
    expect(() => checkShot({ ammo: 'pull', body: MAX_PULL_BODY + 1 })).toThrow(/shot\.body/);
    const rec: SessionRecord = { v: 1, level: 'P', levelHash: 'h', engine: 'rapier', inputs: shots.map((shot, i) => ({ step: 300 + 100 * i, shot })) };
    expect(decodeRecord(encodeRecord(rec))).toEqual(rec);
    // A record written before pulls existed (a marble then an anvil) still decodes the same.
    const old: SessionRecord = { v: 1, level: 'L1', levelHash: 'x', engine: 'ref', inputs: [{ step: 300, shot: shots[1]! }, { step: 700, shot: { ammo: 'drop', x: 4, z: -8 } }] };
    expect(decodeRecord(encodeRecord(old))).toEqual(old);
  });

  it('becomes one remove event for its body, never a spawn', () => {
    expect(shotEvent(c.frame, { ammo: 'pull', body: 1 }, 412)).toEqual({ step: 412, kind: 'remove', id: 1 });
    expect(() => shotToSpawn(c.frame, { ammo: 'pull', body: 1 }, 0)).toThrow(/spawns nothing/);
    expect(shotEvent(c.frame, { ammo: 'marble', az: 0, y: 4, yaw: 0, pitch: 0, power: 50 }, 3)!.kind).toBe('spawn');
  });

  it('is charged a marble at power 0: 409 J at h = 0.5 m, scaling with the marble\'s mass', () => {
    const m = massOf(ammoBody('marble', 0.5, [0, 0, 0], [0, 0, 0]));
    expect(pullEnergy({ unit: 0.5 })).toBeCloseTo(0.5 * m * 5 * 5, 9);
    expect(pullEnergy({ unit: 0.5 })).toBeCloseTo(408.4, 1);
    expect(pullEnergy({ unit: 1 }) / pullEnergy({ unit: 0.5 })).toBeCloseTo(8, 9);
  });
});

describe('pull: the session', () => {
  it('takes a plain structure body: running, the rack spent, the body listed, no ammo id used, the nominal energy charged', () => {
    const se = new Session(c);
    const plain = [...Array(c.meta.n).keys()].find((i) => i !== crown && i !== heritage)!;
    const { spawn, event, feedback } = se.fire({ ammo: 'pull', body: plain }, 300);
    expect(spawn).toBeNull();
    expect(event).toEqual({ step: 300, kind: 'remove', id: plain });
    expect(feedback).toEqual([{ t: 'fired', step: 300, ammo: 'pull', body: plain, ke: pullEnergy(c.frame) }]);
    expect(se.phase).toBe('running');
    expect(se.rackLeft).toEqual(['pull', 'marble']);
    expect(se.pulled).toEqual([plain]);
    // Only crowns and heritage are watched: there is no ammo body.
    expect(Array.from(se.watchIdx)).toEqual([crown, heritage]);
    expect(se.inputs).toEqual([{ step: 300, shot: { ammo: 'pull', body: plain } }]);
  });

  it('refuses crowns, heritage, bodies that are not structure and bodies already pulled', () => {
    const se = new Session(c);
    expect(se.pullRefusal(crown)).toMatch(/is a crown/);
    expect(se.pullRefusal(heritage)).toMatch(/is heritage/);
    expect(se.pullRefusal(c.meta.n)).toMatch(/not a structure body/);
    expect(se.pullRefusal(-1)).toMatch(/not a structure body/);
    expect(() => se.fire({ ammo: 'pull', body: crown }, 0)).toThrow(/cannot pull: body \d+ is a crown/);
    // A refused pull changes nothing.
    expect(se.phase).toBe('aiming');
    expect(se.rackLeft).toEqual(['pull', 'pull', 'marble']);
    se.fire({ ammo: 'pull', body: 0 }, 0);
    expect(se.pullRefusal(0)).toMatch(/already pulled/);
  });
});

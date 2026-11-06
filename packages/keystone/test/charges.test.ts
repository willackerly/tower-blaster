// Charges and the plunger without an engine (C5, docs/design/charges.md): plunger shot text and
// records round trip (and refuse what is not a timeline), charges resolve and join the level hash
// (built-ins written out, as w- items' are), and the validator names every way a charge can be wrong.
import { describe, expect, it } from 'vitest';
import { CUTTER, RELAY, type WeaponSpec } from '@tb/weapons';
import {
  checkShot, compileLevel, decodeRecord, encodeRecord, type LevelDef, levelCharges, MAX_TIMELINE, PLUNGER, pullEnergy, readShots, type Shot, validateLevel, writeShots,
} from '../src/index.ts';

const def = (over: Partial<LevelDef> = {}): LevelDef => ({
  id: 'CH', name: 'charges', version: 1, world: 0, lot: { min: [-6, -6], max: [6, 6] }, crownLine: 1.2, objective: { kind: 'crowns' }, par: 1,
  rack: ['plunger'], launcher: { radius: 7, y: 1, dropY: 10 },
  parts: [
    { kind: 'block', at: [-2, 0, 0], size: [1, 3, 1], material: 'plaster' }, // 0-2
    { kind: 'block', at: [2, 0, 0], size: [1, 1, 1], material: 'plaster' }, // 3
    { kind: 'block', at: [2, 1, 0], size: [1, 1, 1], material: 'plaster', role: 'crown' }, // 4
    { kind: 'block', at: [0, 0, 3], size: [1, 1, 1], material: 'ice' }, // 5
  ],
  charges: [{ host: 0, weapon: 'cutter' }, { host: 3, weapon: 'kicker', at: [0.5, 0, 0] }, { host: 1, weapon: 'relay', arm: 'start' }],
  ...over,
});
const codes = (d: LevelDef) => validateLevel(compileLevel(d)).filter((i) => i.code === 'charge' || i.code === 'weapon').map((i) => [i.code, i.message]);

describe('plunger shots', () => {
  const line: Shot[] = [{ ammo: 'marble', az: 10, y: 4, yaw: 0, pitch: 100, power: 50 }, { ammo: 'plunger', fuse: [[0, 0], [2, 20], [1, 45]], after: 7 }, { ammo: 'pull', body: 3 }];

  it('text: charge.delay pairs after the name, in their order; reads back what it wrote', () => {
    expect(writeShots(line)).toBe('marble.10.4.0.100.50_plunger.0.0.2.20.1.45@7_pull.3');
    expect(readShots(writeShots(line))).toEqual(line);
  });

  it('text refuses an odd field count, no pairs, negatives and too many pairs', () => {
    expect(() => readShots('plunger.0.0.1')).toThrow(/pairs/);
    expect(() => readShots('plunger')).toThrow(/pairs/);
    expect(() => readShots('plunger.0.-1')).toThrow(/whole numbers/);
    expect(() => readShots(`plunger${'.0.0'.repeat(MAX_TIMELINE + 1)}`)).toThrow(/1 to 16/);
    expect(() => checkShot({ ammo: PLUNGER, fuse: [[0, 1e9]] })).toThrow(/delay/);
  });

  it('records: code 6, the pairs as varints; every other shot decodes as before', () => {
    const inputs = line.map((shot, i) => ({ step: 300 + 40 * i, shot: shot.after === undefined ? shot : (({ after: _, ...s }) => s)(shot) as Shot }));
    const r = { v: 1 as const, level: 'CH', levelHash: 'h', engine: 'ref', inputs };
    expect(decodeRecord(encodeRecord(r))).toEqual(r);
  });
});

describe('level charges', () => {
  it('resolve in cube units scaled to the level, with their yields: blasts plus a pull per removal', () => {
    const c = compileLevel(def()), arms = levelCharges(c);
    expect(arms.map((a) => [a.index, a.host, a.arm, a.spec.name])).toEqual([[0, 0, 'plunger', 'cutter'], [1, 3, 'plunger', 'kicker'], [2, 1, 'start', 'relay']]);
    // Points in metres in the host's frame: h = 0.5.
    expect(arms[1]!.point).toEqual([0.25, 0, 0]);
    // A cutter costs its blast and one pull; a kicker its blast only (it never removes).
    expect(arms[0]!.yield).toBeGreaterThan(pullEnergy(c.frame));
    expect(arms[1]!.yield).toBeGreaterThan(0);
    expect(validateLevel(c).filter((i) => i.code === 'charge' || i.code === 'weapon')).toEqual([]);
  });

  it('join the hash, built-ins written out', () => {
    const a = compileLevel(def()), none = compileLevel(def({ charges: undefined })), moved = compileLevel(def({ charges: [{ host: 1, weapon: 'cutter' }] }));
    expect(new Set([a.hash, none.hash, moved.hash]).size).toBe(3);
    // A retuned cutter is another level (the built-in is in the hash, so retuning it drops cast stars).
    const written = compileLevel(def({ weapons: { cutter: CUTTER } }));
    expect(compileLevel(def({ weapons: { cutter: { ...CUTTER, rules: [{ when: { after: 0.1 }, do: [{ removeTarget: true }] }] } } })).hash).not.toBe(written.hash);
  });

  it('a level weapon only charges name is checked as a charge, not as a thrown weapon', () => {
    const own: WeaponSpec = { ...RELAY, name: 'trip' };
    expect(codes(def({ weapons: { trip: own }, charges: [{ host: 0, weapon: 'trip', arm: 'start' }], rack: ['marble'] }))).toEqual([]);
    // The same spec racked as w-trip: a thrown weapon cannot removeTarget.
    const racked = codes(def({ weapons: { trip: own }, charges: [{ host: 0, weapon: 'trip', arm: 'start' }], rack: ['w-trip'] }));
    expect(racked.length).toBeGreaterThan(0);
    expect(racked.every(([code]) => code === 'weapon')).toBe(true);
    expect(racked[0]![1]).toMatch(/target/);
  });

  const bad: [string, Partial<LevelDef>, RegExp][] = [
    ['a host past the structure', { charges: [{ host: 6, weapon: 'cutter' }] }, /not a structure body/],
    ['a crown host', { charges: [{ host: 4, weapon: 'cutter' }] }, /crown or heritage/],
    ['an ice host', { charges: [{ host: 5, weapon: 'cutter' }] }, /ice/],
    ['a point outside its host', { charges: [{ host: 0, weapon: 'cutter', at: [0, 2, 0] }] }, /outside its host/],
    ['an unknown weapon', { charges: [{ host: 0, weapon: 'nuke' }] }, /neither the level's nor a built-in/],
    ['a GrenadeSpec', { weapons: { g: { fuse: 'timer', delay: 1, prox: 0.2, arm: 0, ground: true, blast: { radius: 2, impulse: 10 } } as never }, charges: [{ host: 0, weapon: 'g' }] }, /GrenadeSpec/],
    ['a spec with near', { weapons: { n: { version: 1, shell: CUTTER.shell, rules: [{ when: { near: 0.1 }, do: [{ removeTarget: true }] }] } }, charges: [{ host: 0, weapon: 'n' }] }, /near/],
    ['a bad arm', { charges: [{ host: 0, weapon: 'cutter', arm: 'later' as never }] }, /arm must be/],
    ['a plunger with nothing to arm', { charges: [{ host: 1, weapon: 'relay', arm: 'start' }] }, /no charge a plunger arms/],
  ];
  it.each(bad)('refused: %s', (_, over, msg) => {
    const found = codes(def(over));
    expect(found.some(([code, m]) => code === 'charge' && msg.test(m!)), JSON.stringify(found)).toBe(true);
  });
});

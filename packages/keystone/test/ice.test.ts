// Ice that cracks and shatters (ice.ts) on hand-made states: the damage rule, crack levels,
// the pieces (mass, momentum, where they sit), IceBreaker's bookkeeping, the scoring proxy, the
// level block's checks and its part in the level hash. Played on an engine: keystone-lab ice.test.ts.
import { describe, expect, it } from 'vitest';
import { emptySnapshot, massOf, type Quat, type Snapshot, type SpawnEvent, type Vec3 } from '@tb/engine-api';
import { checkIce, compileLevel, crackLevel, GRAVITY, hitDamage, ICE_DEFAULTS, IceBreaker, iceOf, L1, type LevelDef, pieceGrid, PIECE_FILL, Session, shatterPieces } from '../src/index.ts';

/** L1's footprint built of ice: a 2 x 3 x 2 block of cubes (12 bodies), the top course crowns. */
const ICE: LevelDef = { ...L1, id: 'ICE-T', parts: [{ kind: 'block', at: [-1, 0, -1], size: [2, 3, 2], material: 'ice', courses: [{ k: 2, role: 'crown' }] }] };
const c = compileLevel(ICE);
const n = c.meta.n, dt = c.scene.dt;

/** A snapshot of the structure at rest where it was built, every body active and awake. */
function rest(count = n): Snapshot {
  const s = emptySnapshot(count);
  c.scene.bodies.forEach((b, i) => { s.pos.set(b.pos, 3 * i); s.rot.set(b.rot, 4 * i); s.awake[i] = 1; });
  for (let i = c.scene.bodies.length; i < count; i++) s.rot[4 * i + 3] = 1;
  return s;
}
const copy = (s: Snapshot): Snapshot => ({ ...s, pos: s.pos.slice(), rot: s.rot.slice(), linVel: s.linVel.slice(), angVel: s.angVel.slice(), awake: s.awake.slice(), ...(s.tier ? { tier: s.tier.slice() } : {}) });
/** `s` with body i's velocity set to v (one hit if it differs from the step before by more than gravity). */
function moved(s: Snapshot, i: number, v: Vec3, w: Vec3 = [0, 0, 0]): Snapshot {
  const o = copy(s);
  o.linVel.set(v, 3 * i);
  o.angVel.set(w, 3 * i);
  return o;
}
const quat = (axis: Vec3, a: number): Quat => { const l = Math.hypot(...axis), s = Math.sin(a / 2) / l; return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(a / 2)]; };

describe('the damage rule', () => {
  it('nothing under crackDv; one hit at shatterDv is damage 1; the square in between, so two hits 71% of the way add to 1', () => {
    const r = ICE_DEFAULTS;
    expect(hitDamage(r.crackDv, r)).toBe(0);
    expect(hitDamage(r.crackDv * 0.5, r)).toBe(0);
    expect(hitDamage(r.shatterDv, r)).toBeCloseTo(1, 12);
    expect(hitDamage((r.crackDv + r.shatterDv) / 2, r)).toBeCloseTo(0.25, 12);
    const x = r.crackDv + Math.SQRT1_2 * (r.shatterDv - r.crackDv);
    expect(2 * hitDamage(x, r)).toBeCloseTo(1, 12);
    expect(hitDamage(NaN, r)).toBe(0);
  });

  it('crack levels: 0 whole, then ceil(7 d) up to 7', () => {
    expect(crackLevel(0)).toBe(0);
    expect(crackLevel(1e-9)).toBe(1);
    expect(crackLevel(1 / 7)).toBe(1);
    expect(crackLevel(1 / 7 + 1e-9)).toBe(2);
    expect(crackLevel(0.99)).toBe(7);
    expect(crackLevel(5)).toBe(7);
  });

  it('the level block: defaults, range checks naming the field', () => {
    expect(iceOf(undefined)).toEqual(ICE_DEFAULTS);
    expect(iceOf({ crackDv: 2 })).toEqual({ ...ICE_DEFAULTS, crackDv: 2 });
    expect(() => checkIce({ crackDv: 0 })).toThrow(/crackDv/);
    expect(() => checkIce({ crackDv: 7 })).toThrow(/shatterDv must be over crackDv/);
    expect(() => checkIce({ shatterDv: 1 })).toThrow(/shatterDv/);
    expect(() => compileLevel({ ...ICE, physics: { ice: { shatterDv: 500 } } })).toThrow(/physics\.ice\.shatterDv/);
    checkIce({ crackDv: 1, shatterDv: 2, shatter: false });
  });
});

describe('the pieces', () => {
  it('a cube splits 2 x 2 x 2; a plank only across its long axes; a rod only along its length', () => {
    expect(pieceGrid([0.25, 0.25, 0.25])).toEqual([2, 2, 2]);
    expect(pieceGrid([1, 0.125, 0.5])).toEqual([2, 1, 1]);
    expect(pieceGrid([1, 0.125, 0.8])).toEqual([2, 1, 2]);
    expect(pieceGrid([0.1, 2, 0.1])).toEqual([1, 2, 1]);
  });

  it('keep the mass and the momentum, sit inside the block apart from each other, and spin with it', () => {
    const b = c.scene.bodies[0]!, M = massOf(b);
    const rot = quat([1, 2, 0.5], 0.7), pos: Vec3 = [0.3, 1.2, -0.4], v: Vec3 = [3, -1, 0.5], w: Vec3 = [0.4, -2, 1];
    for (const dv of [ICE_DEFAULTS.shatterDv, 5 * ICE_DEFAULTS.shatterDv]) {
      const ps = shatterPieces(b, pos, rot, v, w, dv, ICE_DEFAULTS, 41);
      expect(ps).toHaveLength(8);
      let m = 0;
      const p: Vec3 = [0, 0, 0], com: Vec3 = [0, 0, 0];
      for (const e of ps) {
        expect(e.step).toBe(41);
        const mi = massOf(e.body);
        m += mi;
        for (let k = 0; k < 3; k++) { p[k] = p[k]! + mi * e.body.linVel![k]!; com[k] = com[k]! + mi * e.body.pos[k]!; }
        expect(e.body.rot).toEqual(rot);
        expect(e.body.angVel).toEqual(w);
        // Its centre, in the block's frame, is a cell centre: inside the block, a quarter of the way in on each axis.
        const h = (b.shape as { half: Vec3 }).half;
        expect((e.body.shape as { half: Vec3 }).half).toEqual(h.map((x) => (x / 2) * PIECE_FILL));
      }
      expect(m).toBeCloseTo(M, 9);
      // Momentum is the block's: v + w x r and the outward kicks each sum to zero over a symmetric split.
      for (let k = 0; k < 3; k++) { expect(p[k]! / m).toBeCloseTo(v[k]!, 9); expect(com[k]! / m).toBeCloseTo(pos[k]!, 9); }
      // Pieces start apart: centres 2 cells apart, each PIECE_FILL of a cell across, so a gap of (1 - PIECE_FILL) of a cell.
      const gaps: number[] = [];
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) gaps.push(Math.hypot(...ps[i]!.body.pos.map((x, k) => x - ps[j]!.body.pos[k]!) as Vec3));
      expect(Math.min(...gaps)).toBeCloseTo(2 * 0.125, 9);
    }
  });

  it('the kick grows with the hit, up to twice PIECE_KICK', () => {
    const b = c.scene.bodies[0]!;
    const speed = (dv: number) => { const e = shatterPieces(b, [0, 0, 0], [0, 0, 0, 1], [0, 0, 0], [0, 0, 0], dv, ICE_DEFAULTS, 0)[0]!; return Math.hypot(...e.body.linVel!); };
    expect(speed(ICE_DEFAULTS.shatterDv)).toBeCloseTo(0.6, 9);
    expect(speed(2 * ICE_DEFAULTS.shatterDv)).toBeCloseTo(1.2, 9);
    expect(speed(10 * ICE_DEFAULTS.shatterDv)).toBeCloseTo(1.2, 9);
  });
});

describe('IceBreaker', () => {
  it('tracks the level\'s ice and budgets its pieces; a level without ice has none', () => {
    expect(new IceBreaker(c).any).toBe(true);
    expect(IceBreaker.budget(c)).toBe(8 * n);
    expect(IceBreaker.budget(compileLevel({ ...ICE, physics: { ice: { shatter: false } } }))).toBe(0);
    expect(new IceBreaker(compileLevel(L1)).any).toBe(false);
    expect(IceBreaker.budget(compileLevel(L1))).toBe(0);
  });

  it('resting, falling freely and stopping on the first step are not hits', () => {
    const ice = new IceBreaker(c);
    let s = rest();
    for (let k = 0; k < 5; k++) expect(ice.observe(s, k, c.scene.bodies, dt)).toEqual({ events: [], cracks: [], shatter: null });
    // Free fall: velocity drops by g dt per step, which is gravity's, not a hit.
    for (let k = 0; k < 30; k++) { s = moved(s, 3, [0, -GRAVITY * dt * k, 0]); expect(ice.observe(s, 5 + k, c.scene.bodies, dt).cracks).toEqual([]); }
  });

  it('hits crack a block in levels, the crack starting on the face the hit came from; a big one shatters it the step after', () => {
    const ice = new IceBreaker(c);
    const s0 = rest();
    ice.observe(s0, 10, c.scene.bodies, dt);
    // A hit of 2.5 m/s pushing +x (from the -x face): damage ((2.5 - 1.5) / 3.5)^2 = 0.08, level 1.
    const s1 = moved(s0, 2, [2.5, 0, 0]);
    const a = ice.observe(s1, 11, c.scene.bodies, dt);
    expect(a.shatter).toBeNull();
    // The support's g dt is in the change too (the hit is the whole change beyond gravity): the origin is the -x face, a little low.
    expect(a.cracks).toEqual([{ body: 2, level: 1, at: [-1, expect.closeTo(-GRAVITY * dt / 2.5, 9), 0], seed: expect.any(Number) }]);
    // Back to rest is another 2.5 m/s change: 0.16, level 2 (the origin stays where it first was).
    const b = ice.observe(s0, 12, c.scene.bodies, dt);
    expect(b.cracks).toEqual([{ ...a.cracks[0]!, level: 2 }]);
    // A 6 m/s hit on body 5 (over shatterDv, 5) shatters it: removed and its 8 pieces spawned, due the step after.
    const s2 = moved(s0, 5, [0, 0, -6]);
    const r = ice.observe(s2, 13, c.scene.bodies, dt);
    expect(r.shatter).toEqual({ body: 5, dv: expect.closeTo(Math.hypot(6, GRAVITY * dt), 12) });
    expect(r.events[0]).toEqual({ step: 14, kind: 'remove', id: 5 });
    expect(r.events.slice(1).every((e) => e.kind === 'spawn' && e.step === 14)).toBe(true);
    expect(r.events).toHaveLength(9);
    const placed = ice.placed(Array.from({ length: 8 }, (_, k) => n + k));
    expect(placed).toEqual({ step: 14, body: 5, pieces: [n, n + 1, n + 2, n + 3, n + 4, n + 5, n + 6, n + 7], dv: r.shatter!.dv });
    expect(ice.shattered.get(5)).toEqual(placed.pieces);
    expect(() => ice.placed([1])).toThrow(/no shatter pending/);
    // What to paint: every block but the shattered one, body 2 cracked, the pieces whole.
    const paint = ice.surfaces();
    expect(paint.map((x) => x.body)).toEqual([...Array.from({ length: n }, (_, k) => k).filter((k) => k !== 5), ...placed.pieces]);
    expect(paint.find((x) => x.body === 2)).toEqual({ ...a.cracks[0]!, level: 2 });
    expect(paint.find((x) => x.body === 0)).toEqual({ body: 0, level: 0, at: [0, 0, 0], seed: expect.any(Number) });
  });

  it('one shatter per step, the hardest hit first; the other keeps its damage and goes the next step', () => {
    const ice = new IceBreaker(c);
    const s0 = rest();
    ice.observe(s0, 0, c.scene.bodies, dt);
    let s = moved(moved(s0, 1, [7, 0, 0]), 4, [0, 9, 0]);
    s.linVel[3 * 4 + 1] = 9 - GRAVITY * dt;
    const r = ice.observe(s, 1, c.scene.bodies, dt);
    expect(r.shatter?.body).toBe(4);
    ice.placed(Array.from({ length: 8 }, (_, k) => n + k));
    // Body 1 held still at its new speed: no new hit, but its damage is past 1, so it goes now.
    s = copy(s);
    s.linVel[3 * 1 + 1] = -GRAVITY * dt;
    const r2 = ice.observe(s, 2, c.scene.bodies, dt);
    expect(r2.shatter?.body).toBe(1);
  });

  it('a body in rubble, the lattice or removed is not judged, and its speed history starts again', () => {
    const ice = new IceBreaker(c);
    const s0 = { ...rest(), tier: new Uint8Array(n) };
    ice.observe(s0, 0, c.scene.bodies, dt);
    const s1 = moved(s0, 3, [5, 0, 0]);
    s1.tier![3] = 1; // rubble: held still, the change of speed is the tier's
    expect(ice.observe(s1, 1, c.scene.bodies, dt).cracks).toEqual([]);
    const s2 = copy(s1);
    s2.tier![3] = 0; // active again at the same speed: no history, so no hit
    expect(ice.observe(s2, 2, c.scene.bodies, dt).cracks).toEqual([]);
    expect(ice.observe(s2, 3, c.scene.bodies, dt).cracks).toEqual([]);
  });

  it('pieces crack but never shatter', () => {
    const ice = new IceBreaker(c);
    const s0 = rest(n + 8);
    ice.observe(s0, 0, c.scene.bodies, dt);
    const r = ice.observe(moved(s0, 0, [0, 0, 8]), 1, c.scene.bodies, dt);
    const ids = Array.from({ length: 8 }, (_, k) => n + k);
    ice.placed(ids);
    const bodies = [...c.scene.bodies, ...r.events.filter((e): e is SpawnEvent => e.kind === 'spawn').map((e) => e.body)];
    ice.observe(s0, 2, bodies, dt);
    const hit = ice.observe(moved(s0, n + 3, [20, 0, 0]), 3, bodies, dt);
    expect(hit.shatter).toBeNull();
    expect(hit.cracks).toEqual([expect.objectContaining({ body: n + 3, level: 7 })]);
  });

  it('the scoring proxy: a shattered block sits at its pieces\' mass-weighted centre, so the potential energy is the pieces\' own', () => {
    const ice = new IceBreaker(c);
    const s0 = rest(n + 8);
    ice.observe(s0, 0, c.scene.bodies, dt);
    expect(ice.view(s0)).toBe(s0);
    const r = ice.observe(moved(s0, 6, [0, 0, 8]), 1, c.scene.bodies, dt);
    const spawns = r.events.filter((e): e is SpawnEvent => e.kind === 'spawn');
    ice.placed(spawns.map((_, k) => n + k));
    // Before the pieces exist (they come the step after) the block is scored where it is.
    expect(Array.from(ice.view(rest()).pos)).toEqual(Array.from(rest().pos));
    // Scatter the pieces: on the ground, on top, wherever; some awake.
    const s = copy(s0);
    let pe = 0, mass = 0;
    spawns.forEach((e, k) => {
      const id = n + k, y = 0.1 + 0.37 * k, mi = massOf(e.body);
      s.pos.set([k * 0.3, y, -k * 0.1], 3 * id);
      s.linVel.set([k, 0, 0], 3 * id);
      s.awake[id] = k === 5 ? 1 : 0;
      pe += mi * GRAVITY * y;
      mass += mi;
    });
    s.awake[6] = 0;
    const v = ice.view(s);
    expect(mass).toBeCloseTo(c.meta.mass[6]!, 9);
    expect(c.meta.mass[6]! * GRAVITY * v.pos[3 * 6 + 1]!).toBeCloseTo(pe, 9);
    expect(v.awake[6]).toBe(1);
    expect(v.linVel[3 * 6]).toBeCloseTo(spawns.reduce((a, e, k) => a + massOf(e.body) * k, 0) / mass, 12);
    // The rest is the snapshot's own; the snapshot itself is untouched.
    expect(v.rot).toBe(s.rot);
    expect(Array.from(v.pos.subarray(0, 18))).toEqual(Array.from(s.pos.subarray(0, 18)));
    expect(s.pos[3 * 6 + 1]).toBe(s0.pos[3 * 6 + 1]);
  });
});

describe('a shattered crown is down, a shattered heritage block broken', () => {
  it('Session.shatter', () => {
    const s = new Session(c);
    s.shatter(9);
    s.shatter(9);
    expect(s.shattered).toEqual([9]);
  });
});

describe('ice in the level hash', () => {
  it('a level without ice hashes the same whatever physics.ice says; with ice, the rules join the hash written out', () => {
    expect(compileLevel({ ...L1, physics: { ice: { crackDv: 3 } } }).hash).toBe(compileLevel(L1).hash);
    const base = compileLevel(ICE).hash;
    expect(compileLevel({ ...ICE, physics: { ice: { ...ICE_DEFAULTS } } }).hash).toBe(base);
    expect(compileLevel({ ...ICE, physics: { ice: { crackDv: 2 } } }).hash).not.toBe(base);
    expect(compileLevel({ ...ICE, physics: { ice: { shatter: false } } }).hash).not.toBe(base);
  });
});

describe('telling a piece from other spawned bodies', () => {
  it('a piece has the ice piece density, so the game can sound and draw it as ice; ammo and the blocks do not', async () => {
    const { isIcePiece, ammoBody } = await import('../src/index.ts');
    const p = shatterPieces(c.scene.bodies[0]!, [0, 0, 0], [0, 0, 0, 1], [0, 0, 0], [0, 0, 0], 6, ICE_DEFAULTS, 0);
    expect(p.every((e) => isIcePiece(e.body))).toBe(true);
    expect(isIcePiece(c.scene.bodies[0]!)).toBe(false);
    expect(isIcePiece(ammoBody('cannonball', c.frame, [0, 0, 0], [1, 0, 0]))).toBe(false);
  });
});

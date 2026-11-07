// Rube Lab's level grammar and rules (M10, docs/game/rube-lab.md): pinned and
// tilted pieces, balls, the bell objective, the release charge, the bin's
// ramp, bumper and ball, and the parts-par stars. Physics is in keystone-lab
// (rube.test.ts on the reference, rube-gpu.test.ts on the GPU solver).
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '@tb/engine-api';
import {
  axisOf, BALL_RADIUS, bellRung, BuildSession, catalog, compileLevel, type Hit, type LevelDef, pieceQuat, RAMP_HALF, RAMP_TILT, rampTo, RL1, RL2, RL3, RUBE_GATE, rubeStars,
  Session, validateLevel, yawQuat,
} from '@tb/keystone';

const h = 0.5;
const ground = (x: number, z: number): Hit => ({ body: -1, point: [x * h, 0, z * h], normal: [0, 1, 0], t: 1 });
const base = (extra: Partial<LevelDef> = {}): LevelDef => ({
  id: 'RUBE-T', name: 'rube test', version: 1, world: 6, lot: { min: [-10, -10], max: [10, 10] }, crownLine: 0, objective: { kind: 'bell' }, par: 1,
  rack: ['plunger'], launcher: { radius: 12, y: 1, dropY: 8 }, charges: [{ host: 0, weapon: 'release' }],
  parts: [
    { kind: 'piece', at: [0, 2, 0], half: [0.6, 0.1, 0.6], pinned: true, material: 'stone' },
    { kind: 'ball', at: [0, 2.5, 0], radius: 0.4, material: 'stone' },
    { kind: 'piece', at: [4, 1, 0], half: [0.5, 1, 0.15], material: 'plaster', role: 'crown' },
  ],
  ...extra,
});

describe('pieces: tilt and pinned', () => {
  it('pieceQuat is yawQuat with no tilt, and a positive tilt raises the +x end', () => {
    for (const yaw of [0, 15, -90, 135]) expect(pieceQuat(yaw)).toEqual(yawQuat(yaw));
    const q = pieceQuat(0, 30), x = axisOf(q, 0);
    expect(x[0]).toBeCloseTo(Math.cos(Math.PI / 6), 12);
    expect(x[1]).toBeCloseTo(Math.sin(Math.PI / 6), 12);
    // Yaw after tilt: the rising axis turns with the yaw (90: +x goes to -z).
    const r = axisOf(pieceQuat(90, 30), 0);
    expect(r[2]).toBeCloseTo(-Math.cos(Math.PI / 6), 12);
    expect(r[1]).toBeCloseTo(Math.sin(Math.PI / 6), 12);
  });

  it('compiles pinned, tilted pieces and balls; the hash sees tilt and pinned, not their key order', () => {
    const c = compileLevel(base());
    expect(c.scene.bodies[0]!.pinned).toBe(true);
    expect(c.scene.bodies[1]!.shape).toEqual({ kind: 'sphere', radius: 0.4 * h });
    expect(Array.from(c.meta.half.subarray(3, 6))).toEqual([0.2, 0.2, 0.2]);
    expect(c.scene.bodies[2]!.pinned).toBeUndefined();
    const tilted = base({ parts: [...base().parts, { kind: 'piece', at: [-4, 1, 0], half: [2, 0.2, 0.5], tilt: 10, pinned: true, material: 'stone' }] });
    const t = compileLevel(tilted);
    expect(t.scene.bodies[3]!.rot).toEqual(pieceQuat(0, 10));
    const reordered = base({ parts: [...base().parts, { material: 'stone', pinned: true, tilt: 10, half: [2, 0.2, 0.5], at: [-4, 1, 0], kind: 'piece' }] });
    expect(compileLevel(reordered).hash).toBe(t.hash);
    const unpinned = base({ parts: [...base().parts, { kind: 'piece', at: [-4, 1, 0], half: [2, 0.2, 0.5], tilt: 10, material: 'stone' }] });
    const flat = base({ parts: [...base().parts, { kind: 'piece', at: [-4, 1, 0], half: [2, 0.2, 0.5], pinned: true, material: 'stone' }] });
    expect(new Set([t.hash, compileLevel(unpinned).hash, compileLevel(flat).hash]).size).toBe(3);
  });

  it('validates: pins may interpenetrate and float, a free body may not overlap a pin', () => {
    expect(validateLevel(compileLevel(base()), { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    // A ramp dipping into a pinned shelf: scenery, no issue.
    const dip = base({ parts: [...base().parts, { kind: 'piece', at: [-4, 0.5, 0], half: [2, 0.5, 1], pinned: true, material: 'stone' }, rampTo([-4, 1, 0], 12, 4)] });
    expect(validateLevel(compileLevel(dip), { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    // A free cube pushed into a pin is an overlap.
    const into = base({ parts: [...base().parts, { kind: 'piece', at: [0.3, 2.3, 0], half: [0.5, 0.5, 0.5], material: 'plaster' }] });
    expect(validateLevel(compileLevel(into), { engine: 'gpu' }).some((i) => i.code === 'overlap')).toBe(true);
    // A bell must be there to ring, and a region must be a box.
    expect(validateLevel(compileLevel(base({ parts: base().parts.slice(0, 2) }))).some((i) => i.code === 'objective')).toBe(true);
    expect(validateLevel(compileLevel(base({ objective: { kind: 'bell', region: { min: [5, 0, 1], max: [6, 2, -1] } } }))).some((i) => i.code === 'objective')).toBe(true);
    // A runner bell that starts inside its region has already rung.
    const inside = base({ parts: [base().parts[0]!, { kind: 'ball', at: [0, 2.5, 0], radius: 0.4, material: 'stone', role: 'crown' }], objective: { kind: 'bell', region: { min: [-1, 2, -1], max: [1, 3, 1] } } });
    expect(validateLevel(compileLevel(inside)).some((i) => i.code === 'crown-start')).toBe(true);
  });

  it('the gate puzzles validate clean on both engines', () => {
    for (const def of RUBE_GATE) for (const engine of ['gpu', 'rapier'] as const) {
      expect([def.id, engine, validateLevel(compileLevel(def), { engine }).filter((i) => !i.warning)]).toEqual([def.id, engine, []]);
    }
    expect(RUBE_GATE.map((d) => d.id)).toEqual([RL1.id, RL2.id, RL3.id]);
  });
});

describe('bell', () => {
  it('rings in its region, or once moved a quarter h (default) from home', () => {
    const c = compileLevel(base()), home: Vec3 = [4 * h, h, 0];
    expect(bellRung(c, home, home)).toBe(false);
    expect(bellRung(c, [4 * h + 0.24 * h, h, 0], home)).toBe(false);
    expect(bellRung(c, [4 * h + 0.25 * h, h, 0], home)).toBe(true);
    const r = compileLevel(base({ objective: { kind: 'bell', region: { min: [6, 0, -1], max: [8, 2, 1] } } }));
    expect(bellRung(r, [7 * h, h, 0], home)).toBe(true);
    expect(bellRung(r, [5.9 * h, h, 0], home)).toBe(false);
    // Not a bell level: never.
    expect(bellRung(compileLevel({ ...base(), objective: { kind: 'crowns' } }), [9, 9, 9], home)).toBe(false);
  });

  it('a session keeps a rung bell rung and clears on it, whatever the bell does after', () => {
    const c = compileLevel(base()), s = new Session(c), n = c.meta.n;
    const w = (x: number) => ({ idx: Int32Array.from([2]), pos: Float64Array.from([x, h, 0]), rot: Float64Array.from([0, 0, 0, 1]), linVel: new Float64Array(3), angVel: new Float64Array(3) });
    type Obs = Parameters<Session['observe']>[0];
    const red = (step: number, moving: boolean): Obs['red'] => ({
      step, nAwake: moving ? 1 : 0, maxSpeed: moving ? 1 : 0, maxAngSpeed: 0, pe_mJ: 0, displaced: 0, outOfLot: 0, heightHist: new Uint32Array(8), impacts: new Uint32Array(48),
      nMoving: moving ? 1 : 0, movingBox: new Float64Array(6), ammoSpeed: 0,
    });
    s.fire({ ammo: 'plunger', fuse: [[0, 0]] }, 300);
    s.observe({ step: 301, red: red(301, true), watched: w(4.5 * h), basePe_mJ: 0 } as Obs);
    expect(s.crownLive[0]).toBe(1);
    // Back home by the settle: still rung.
    let fb: ReturnType<Session['observe']> = [];
    for (let step = 302; step < 2000 && s.phase === 'running'; step++) fb = s.observe({ step, red: red(step, false), watched: w(4 * h), basePe_mJ: 0 } as Obs);
    expect(s.phase).toBe('cleared');
    expect(fb.some((f) => f.t === 'levelEnd' && f.cleared)).toBe(true);
    expect(n).toBe(3);
  });
});

describe('the bin: ramp, bumper and ball', () => {
  const rubeBin = (): LevelDef => base({ build: { budget: 9, pieces: ['ramp', 'bumper', 'ball', 'cube'] } });

  it('are offered only when a level names them', () => {
    const plain = new BuildSession(base({ build: { budget: 5 } }));
    expect(plain.items.map((i) => i.name)).toEqual(['cube', 'domino', 'plank', 'slab', 'beam', 'course4', 'wall4x2', 'pier3']);
    expect(new BuildSession(rubeBin()).items.map((i) => i.name)).toEqual(['cube', 'ball', 'ramp', 'bumper']);
    const cat = catalog(1.02);
    expect(cat.find((i) => i.name === 'ramp')).toMatchObject({ pinned: true, tilt: RAMP_TILT, cost: 3 });
    expect(cat.find((i) => i.name === 'ball')).toMatchObject({ ball: BALL_RADIUS, cost: 1, material: 'stone' });
  });

  it('a ramp goes down with its foot flush on the ground, pinned, and may dip into the ground but not into a free body', () => {
    const s = new BuildSession(rubeBin());
    const g = s.ghost(ground(-6, 4), { item: 'ramp', yaw: 0, tip: 0 });
    expect(g.ok).toBe(true);
    expect(g.parts[0]).toMatchObject({ kind: 'piece', half: [...RAMP_HALF], tilt: RAMP_TILT, pinned: true, placed: true });
    expect(s.place(g)).toBe(true);
    const c = s.compiled(), b = c.scene.bodies.at(-1)!;
    expect(b.pinned).toBe(true);
    // The top face's low end: centre + R (-L/2, t/2, 0). At y = 0, give or take the 1e-6 h of a placed piece's rounding.
    const X = axisOf(b.rot, 0), Y = axisOf(b.rot, 1), L = 2 * RAMP_HALF[0] * h, t = 2 * RAMP_HALF[1] * h;
    expect(Math.abs(b.pos[1] - (L / 2) * X[1] + (t / 2) * Y[1])).toBeLessThan(2e-6 * h);
    expect(s.spent()).toBe(3);
    // Onto the bell (a free body): refused.
    expect(s.ghost(ground(3, 0), { item: 'ramp', yaw: 0, tip: 0 }).ok).toBe(false);
  });

  it('a ball goes down as a ball, drawn as one, costing 1; a bumper is pinned', () => {
    const s = new BuildSession(rubeBin());
    const g = s.ghost(ground(-5, -4), { item: 'ball', yaw: 0, tip: 0 });
    expect(g.ok).toBe(true);
    expect(g.spheres).toEqual([true]);
    expect(g.parts[0]).toMatchObject({ kind: 'ball', radius: BALL_RADIUS, material: 'stone', placed: true });
    expect(g.parts[0]!.at[1]).toBeCloseTo(BALL_RADIUS, 6);
    expect(s.place(g)).toBe(true);
    expect(s.place(s.ghost(ground(-2, -6), { item: 'bumper', yaw: 30, tip: 0 }))).toBe(true);
    expect(s.compiled().scene.bodies.at(-1)!.pinned).toBe(true);
    expect(s.spent()).toBe(4);
    expect(validateLevel(s.compiled(), { engine: 'gpu' }).filter((i) => !i.warning)).toEqual([]);
    // Play is the level a saved file loads.
    expect(compileLevel(JSON.parse(JSON.stringify(s.def())) as LevelDef).hash).toBe(s.compiled().hash);
  });
});

describe('stars', () => {
  it('3 at or under the parts par, 2 within half again, 1 for any clear, 0 uncleared', () => {
    expect([rubeStars(true, 2, 3), rubeStars(true, 3, 3), rubeStars(true, 5, 3), rubeStars(true, 6, 3), rubeStars(false, 1, 3)]).toEqual([3, 3, 2, 1, 0]);
  });
  it('the parts par is in the level hash: a retuned par is a new level for progress records', () => {
    expect(compileLevel({ ...RL1, rube: { partsPar: 3 } }).hash).not.toBe(compileLevel(RL1).hash);
  });
});

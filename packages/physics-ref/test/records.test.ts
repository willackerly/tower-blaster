// Manifold records (AvbdParams.records). 1, the GPU's exact record, is the
// same step as points here; 2 replaces each manifold's per-point friction by
// one friction state at the points' centre (FrictionRecord).
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { nonFinite } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { type ColumnSample, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import { AvbdReferenceEngine, type AvbdParams, AvbdWorld, DEFAULT_AVBD, GROUND } from '../src/index.ts';

const G = 9.81, MU = 0.6;
const box = (pos: Vec3, half: Vec3 = [0.5, 0.5, 0.5], linVel: Vec3 = [0, 0, 0], angVel: Vec3 = [0, 0, 0], friction = MU): BodyDesc => ({
  shape: { kind: 'box', half }, pos, rot: [0, 0, 0, 1], linVel, angVel, density: 1, friction, restitution: 0, tag: 0,
});
const sceneOf = (bodies: BodyDesc[], ground = MU): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity: [0, -G, 0], dt: 1 / 60, ground: { y: 0, friction: ground }, sleep: false, bodies, inputs: [],
});
async function engine(scene: SceneDesc, params: Partial<AvbdParams>) {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  return e;
}
const knock = () => buildScenario('S5', { N: 64, F: 2, H: 8, street: 2, fireStep: 0, radius: 0.6, speed: 15 }, 1);

describe('manifold records on the reference (AvbdParams.records)', () => {
  it('takes 0, 1 or 2; 1 is the point form, bit for bit, and 2 keeps one record per manifold, its points those of the pair', async () => {
    for (const bad of [3, -1, 0.5]) await expect(engine(sceneOf([]), { records: bad })).rejects.toThrow(`AvbdParams.records must be one of 0, 1, 2, got ${bad}`);
    // Off and unset run the same engine, so they record the same variant.
    expect(new AvbdReferenceEngine({ records: 0 }).info.variant).toEqual(new AvbdReferenceEngine().info.variant);
    expect(new AvbdReferenceEngine({ records: 2 }).info.variant).toMatchObject({ records: 2 });
    // records 1 takes the points' code path here (it is a GPU layout with no physics of its own), so this
    // comparison only guards that it stays so; the evidence for the GPU's records 1 is
    // physics-gpu/test/records.test.ts, against points bit for bit.
    const [a, b, c] = [await engine(knock(), {}), await engine(knock(), { records: 1 }), await engine(knock(), { records: 2 })];
    for (let i = 0; i < 40; i++) { a.step(); b.step(); c.step(); }
    expect([...b.snapshot().pos]).toEqual([...a.snapshot().pos]);
    expect([...b.snapshot().angVel]).toEqual([...a.snapshot().angVel]);
    expect(a.world!.records).toEqual([]);
    const w = c.world!;
    expect(w.records.length).toBe(w.stats.manifolds);
    expect(w.records.reduce((s, q) => s + q.nc, 0)).toBe(w.contacts.length);
    for (const q of w.records) {
      expect(q.points.every((p) => p.a === q.a && p.b === q.b && !p.stick)).toBe(true);
      expect(q.nc).toBeGreaterThanOrEqual(1);
      expect(q.nc).toBeLessThanOrEqual(4);
      if (q.nc === 1) expect(q.rt).toBe(0);
    }
  });

  // The single-body checks (perf-competition round 1, the physics judge on the entrant "patch"): a slide and a
  // spin each stop as with points, as the ball mu |sum lambda_n| is the points' cones summed (rt is the corners'
  // radius, sqrt(1/2) for a unit cube's face).
  it('2: a cube sliding at 3 m/s stops where points stop, and a spinning cube on the step Coulomb friction says', async () => {
    const slide = async (records: number) => {
      const e = await engine(sceneOf([box([0, 0.5, 0], [0.5, 0.5, 0.5], [3, 0, 0])]), { records });
      for (let s = 0; s < 120; s++) e.step();
      return e.snapshot().pos[0]!;
    };
    expect(Math.abs((await slide(2)) - (await slide(0)))).toBeLessThan(1e-3);
    for (const [mu, w0] of [[1, 10], [0.6, 5]] as const) {
      const e = await engine({ ...sceneOf([box([0, 0.5, 0], [0.5, 0.5, 0.5], [0, 0, 0], [0, w0, 0], mu)], mu) }, { records: 2 });
      const b = e.world!.bodies[0]!;
      let stop = -1, after = 0;
      for (let s = 1; s <= 180; s++) {
        e.step();
        if (stop < 0 && Math.abs(b.angVel[1]) < 1e-2) stop = s;
        if (stop > 0 && s > stop + 10) after = Math.max(after, Math.hypot(...b.angVel), Math.hypot(...b.linVel));
      }
      expect(Math.abs(stop - Math.ceil(w0 / ((6 * Math.SQRT1_2 * mu * G) / 60)))).toBeLessThanOrEqual(1);
      expect(after).toBeLessThan(1e-4);
    }
  });

  it('2: a one-point record is a rolling contact: a ball sliding with backspin starts to roll on time and keeps rolling', async () => {
    const R = 0.25, v0 = 3, w0 = 5 / R;
    const e = await engine(sceneOf([{ ...box([0, R, 0], [R, R, R], [v0, 0, 0], [0, 0, w0]), shape: { kind: 'sphere', radius: R } }]), { records: 2 });
    const b = e.world!.bodies[0]!;
    let rolled = -1, late = 0;
    for (let s = 1; s <= 180; s++) {
      e.step();
      const slip = Math.abs(b.linVel[0] + b.angVel[2] * R);
      if (rolled < 0 && slip < 0.05) rolled = s;
      if (s >= 60) late = Math.max(late, slip);
    }
    expect(e.world!.records.map((q) => q.nc)).toEqual([1]);
    expect(Math.abs(rolled - ((v0 + w0 * R) / (3.5 * MU * G)) * 60)).toBeLessThan(2);
    expect(late).toBeLessThan(0.025);
    expect(Math.abs(b.linVel[0] / ((5 * v0 - 2 * w0 * R) / 7) - 1)).toBeLessThan(0.01);
    expect(Math.abs(b.pos[1] - R)).toBeLessThan(1e-3);
  });

  // S13 (physics-ref/test/collapse.test.ts) with records 2. Measured 2026-10-26: 4 deg topples +2.14% / +0.05%
  // late at 10 / 20 iterations (points +3.03% / +0.61%); 2 deg uprights 4.85% / 0.53% early with far side 0.689 /
  // 0.957 of the rigid column's (points 6.12% / 1.63%, 0.632 / 0.897).
  const column = async (deg: number, steps: number, iterations: number) => {
    const H = 20, e = await engine(buildScenario('S13', { H, deg }, 1), { records: 2, iterations });
    const s: ColumnSample[] = [{ t: 0, pos: [...e.snapshot().pos] }];
    for (let i = 1; i <= steps; i++) { e.step(); s.push({ t: i / 60, pos: [...e.snapshot().pos] }); }
    return readColumn(s, H);
  };
  it.for([[10, 0.12, Infinity], [20, 0.03, 0.1]] as const)('2: S13, a 20-cube column leaning 4 deg topples like the rigid column (%s iterations)', async ([iterations, tol, maxBend]) => {
    const r = await column(4, 330, iterations), rod = rodToppleTime(20, 4, 30);
    expect(r.topple).not.toBeNull();
    expect(Math.abs(r.topple! / rod - 1)).toBeLessThan(tol);
    expect(r.bend).toBeLessThan(maxBend);
  });
  it.for([[10, 0.15, 0.6], [20, 0.03, 0.85]] as const)('2: S13, a 20-cube column leaning 2 deg rocks back past upright on time, no further than the rigid column (%s iterations)', async ([iterations, tol, farMin]) => {
    const r = await column(2, 300, iterations), rod = rodRock(20, 2);
    expect(r.upright).not.toBeNull();
    expect(Math.abs(r.upright! / rod.upright - 1)).toBeLessThan(tol);
    expect(r.before).toBeLessThan(tippingAngle(20));
    expect(r.turned).toBe(true);
    expect(r.farSide / rod.farSide).toBeGreaterThan(farMin);
    expect(r.farSide / rod.farSide).toBeLessThan(1.02);
  });

  it('2: a knocked tower\'s debris changes its records\' point counts under warm start, stays finite and comes to rest', async () => {
    const e = await engine(knock(), { records: 2 });
    const w = e.world!;
    const last = new Map<string, number>();
    let changed = 0, keMax = 0, ke = 0, ground = 0;
    for (let s = 1; s <= 300; s++) {
      e.step();
      for (const q of w.records) {
        const key = `${q.a},${q.b}`, prev = last.get(key);
        if (prev !== undefined && prev !== q.nc) changed++;
        if (q.a === GROUND) ground++;
      }
      last.clear();
      for (const q of w.records) last.set(`${q.a},${q.b}`, q.nc);
      ke = w.bodies.reduce((sum, b) => sum + 0.5 * b.mass * (b.linVel[0] ** 2 + b.linVel[1] ** 2 + b.linVel[2] ** 2), 0);
      keMax = Math.max(keMax, ke);
    }
    expect(nonFinite(e.snapshot())).toBe(0);
    expect(changed).toBeGreaterThan(50);
    expect(ground).toBeGreaterThan(0);
    expect(ke).toBeLessThan(1e-3 * keMax);
  });

  // The loaded-gap slop (AvbdParams.gapSlop; physics-ref/test/avbd.test.ts has the point form's cases): records 2's
  // points keep their normal rows, so they excuse a loaded gap as points do. Its probe there: an 8-cube column kicked
  // sideways at up to 0.01 m/s per cube at step 401. Measured 2026-10-27, max speed over steps 1201-1500 at 10 / 20
  // iterations: records 2 0.15 / 0.015 m/s, with gapSlop 3e-5 8.4e-5 / 1.1e-5 (points 0.25 / 0.016, and 8.2e-5 /
  // 1.1e-5 with it).
  const kicked = async (params: Partial<AvbdParams>) => {
    const scene = buildScenario('S1', { F: 1, H: 8, gap: 0 }, 1);
    const e = await engine(scene, params);
    let maxV = 0, side = 0, seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 1; i <= 1500; i++) {
      if (i === 401) for (const b of e.world!.bodies) { b.linVel[0] += 0.01 * (2 * rnd() - 1); b.linVel[2] += 0.01 * (2 * rnd() - 1); }
      e.step();
      if (i > 1200) for (const b of e.world!.bodies) maxV = Math.max(maxV, Math.hypot(...b.linVel));
    }
    e.world!.bodies.forEach((b, i) => { const p0 = scene.bodies[i]!.pos; side = Math.max(side, Math.hypot(b.pos[0] - p0[0], b.pos[2] - p0[2])); });
    return { maxV, side };
  };
  it.for([10, 20])('2 with gapSlop 3e-5: the kicked 8-cube column comes back to rest, as points do (%s iterations)', async (iterations) => {
    const r = await kicked({ iterations, records: 2, gapSlop: 3e-5 });
    expect(r.maxV).toBeLessThan(1e-3);
    expect(r.side).toBeLessThan(1e-3);
  });
  it('2 without gapSlop: that column keeps rocking, so the slop is what stops it', async () => {
    expect((await kicked({ iterations: 10, records: 2 })).maxV).toBeGreaterThan(1e-2);
  });

  // Restitution (AvbdParams.restitution): the pass reads and zeroes the points' normal forces, which records 2 keeps
  // per point, so a bounce is the point form's. The friction is the record's: see AvbdParams.records.
  const bouncy = (bodies: BodyDesc[]): SceneDesc => ({ ...sceneOf(bodies.map((b) => ({ ...b, restitution: 0.6 }))), ground: { y: 0, friction: MU, restitution: 0.6 } });
  it('2 with restitution: a cube thrown down and sideways onto the ground rebounds at e times its approach, as points do', async () => {
    const rebound = async (records: number) => {
      const e = await engine(bouncy([box([0, 0.52, 0], [0.5, 0.5, 0.5], [3, -5, 0])]), { restitution: true, records });
      let up = 0, bounced = 0;
      for (let s = 0; s < 60; s++) { e.step(); up = Math.max(up, e.world!.bodies[0]!.linVel[1]); bounced += e.world!.stats.restitution.contacts; }
      return { up, bounced };
    };
    const [points, centre] = [await rebound(0), await rebound(2)];
    expect(centre.bounced).toBeGreaterThan(0);
    expect(centre.bounced).toBe(points.bounced);
    // e 0.6 (cube and ground, averaged) times the 5 m/s approach.
    expect(points.up).toBeCloseTo(3, 3);
    expect(centre.up).toBeCloseTo(3, 3);
  });
  it('2 with restitution: a record whose points all bounced apart carries no friction on, the same bits as with its lamT zeroed', () => {
    // restitute() zeroes the force of a point that bounces apart, and with it the point's share of its record's
    // friction bound. A ball into two towers, every body's e 0.5 (the ball's 0.8), run twice: as is, and with every
    // record whose points restitute() all zeroed also getting lamT = 0.
    const s = knock();
    const scene = { ...s, bodies: s.bodies.map((b) => ({ ...b, restitution: 0.5 })), inputs: s.inputs.map((ev) => ({ ...ev, body: { ...ev.body, restitution: 0.8 } })) };
    const run = (zero: boolean) => {
      const w = new AvbdWorld(scene, { ...DEFAULT_AVBD, iterations: 6, records: 2, restitution: true });
      for (const b of scene.bodies) w.add(b);
      const pending = [...scene.inputs];
      const restitute = w.restitute.bind(w);
      let whole = 0, part = 0;
      w.restitute = (v0, w0, q0) => {
        const loaded = new Set(w.contacts.filter((c) => c.lambda[0] < 0));
        restitute(v0, w0, q0);
        for (const q of w.records) {
          const zeroed = q.points.filter((c) => loaded.has(c) && c.lambda.every((l) => l === 0)).length;
          if (!zeroed) continue;
          if (zeroed < q.nc) { part++; continue; }
          whole++;
          if (zero) q.lamT = [0, 0, 0];
        }
      };
      const states: Float64Array[] = [];
      for (let k = 0; k < 40; k++) {
        while (pending.length && pending[0]!.step <= k) w.add(pending.shift()!.body);
        w.step();
        states.push(Float64Array.from([...w.bodies.flatMap((b) => [...b.pos, ...b.rot, ...b.linVel, ...b.angVel]), ...w.contacts.flatMap((c) => c.lambda)]));
      }
      return { states, whole, part };
    };
    const [a, b] = [run(false), run(true)];
    // Measured: 19 records bounced whole and 45 in part over the 40 steps.
    expect(a.whole).toBeGreaterThan(10);
    expect(a.part).toBeGreaterThan(10);
    b.states.forEach((x, k) => expect(new Uint32Array(x.buffer), `step ${k}`).toEqual(new Uint32Array(a.states[k]!.buffer)));
  });
});

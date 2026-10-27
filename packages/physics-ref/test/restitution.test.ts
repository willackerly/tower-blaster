// Opt-in restitution (AvbdParams.restitution, AvbdWorld.restitute()): off it
// changes nothing; on, a contact that approached at restitutionThreshold or
// faster and carried a force bounces with the combined restitution of its
// pair (SceneDesc.restitutionCombine, default average; the ground's is
// SceneDesc.ground.restitution, default 0). Drops here give the ground the
// body's own e, so the pair's e is the body's.
//
// Rebound speeds are measured "at contact" with the integrator's invariant:
// in free flight under semi-implicit Euler, (v_y - g h / 2)^2 + 2 g (y - y_c)
// is exactly constant, so a sample's speed at touching height y_c needs no
// interpolation. A step-based rule loses about (1 + e) g h / 2 of rebound
// against it (gravity acts over the impact step): 2.5-7% at 5-10 m/s, up to
// 24% at 2 m/s (a 1-D model of the rule: a hard contact, then -e times the
// start-of-step normal velocity).
import { describe, expect, it } from 'vitest';
import { type BodyDesc, type CombineRule, combineRestitution, DEFAULT_RESTITUTION_COMBINE, type SceneDesc, type Vec3 } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { nonFinite } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { AvbdReferenceEngine, type AvbdParams, AvbdWorld, DEFAULT_AVBD, RESTITUTION_DEFAULTS } from '../src/index.ts';

const G = 9.81, H = 1 / 60;
const ON: Partial<AvbdParams> = { restitution: true };
const rotZ = (a: number): [number, number, number, number] => [0, 0, -Math.sin(a / 2), Math.cos(a / 2)];
const cube = (pos: Vec3, o: { e?: number; linVel?: Vec3; rot?: [number, number, number, number]; density?: number; friction?: number } = {}): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: o.rot ?? [0, 0, 0, 1], linVel: o.linVel ?? [0, 0, 0], angVel: [0, 0, 0], density: o.density ?? 1, friction: o.friction ?? 0.6, restitution: o.e ?? 0, tag: 0,
});
const ball = (pos: Vec3, o: { e?: number; linVel?: Vec3; mass?: number; radius?: number; friction?: number } = {}): BodyDesc => {
  const r = o.radius ?? 0.5;
  return {
    shape: { kind: 'sphere', radius: r }, pos, rot: [0, 0, 0, 1], linVel: o.linVel ?? [0, 0, 0], angVel: [0, 0, 0],
    density: (o.mass ?? 1) / ((4 / 3) * Math.PI * r ** 3), friction: o.friction ?? 0.6, restitution: o.e ?? 0, tag: -1,
  };
};
/** A scene on a ground of restitution groundE (undefined: unset, 0), or in zero g with no ground. */
const sceneOf = (bodies: BodyDesc[], o: { gravity?: Vec3; ground?: boolean; groundE?: number; friction?: number; rule?: CombineRule } = {}): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity: o.gravity ?? [0, -G, 0], dt: H,
  ground: o.ground === false ? null : { y: 0, friction: o.friction ?? 0.6, ...(o.groundE !== undefined ? { restitution: o.groundE } : {}) },
  sleep: false, ...(o.rule ? { restitutionCombine: o.rule } : {}), bodies, inputs: [],
});
const zeroG = (bodies: BodyDesc[], rule?: CombineRule) => sceneOf(bodies, { gravity: [0, 0, 0], ground: false, rule });
/** Every body's (and spawned body's) restitution set to e. */
const withE = (s: SceneDesc, e: number): SceneDesc => ({ ...s, bodies: s.bodies.map((b) => ({ ...b, restitution: e })), inputs: s.inputs.map((ev) => ({ ...ev, body: { ...ev.body, restitution: e } })) });
const knock = (speed: number) => buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
const state = (e: AvbdReferenceEngine) => { const s = e.snapshot(); return [...s.pos, ...s.rot, ...s.linVel, ...s.angVel]; };
const spin = (e: AvbdReferenceEngine, i = 0) => Math.hypot(...e.world!.bodies[i]!.angVel);
const maxSpeed = (e: AvbdReferenceEngine) => Math.max(...e.world!.bodies.map((b) => Math.hypot(...b.linVel)));
/** Semi-implicit Euler's invariant energy of the bodies: 1/2 m |v + g h/2|^2 - m g.x + 1/2 w.I w. */
function shadowEnergy(e: AvbdReferenceEngine, gravity: Vec3) {
  let E = 0;
  for (const b of e.world!.bodies) {
    const v = [0, 1, 2].map((k) => b.linVel[k]! + gravity[k]! * H / 2);
    const wb = rotate([-b.rot[0], -b.rot[1], -b.rot[2], b.rot[3]], b.angVel); // body frame
    E += 0.5 * b.mass * (v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2) + 0.5 * (b.inertia[0] * wb[0] ** 2 + b.inertia[1] * wb[1] ** 2 + b.inertia[2] * wb[2] ** 2);
    E -= b.mass * (gravity[0] * b.pos[0] + gravity[1] * b.pos[1] + gravity[2] * b.pos[2]);
  }
  return E;
}
/**
 * Run a scene for `steps`: the largest rise of the shadow energy over its start, relative to |E0| (or to
 * `scale`), the energy at the end over the start, and the largest body speed over the last 20% of the steps.
 */
async function gainOf(scene: SceneDesc, params: Partial<AvbdParams>, steps: number, scale?: number) {
  const eng = new AvbdReferenceEngine(params);
  await eng.init(scene);
  const E0 = shadowEnergy(eng, scene.gravity);
  let eMax = E0, late = 0;
  for (let k = 1; k <= steps; k++) {
    eng.step();
    eMax = Math.max(eMax, shadowEnergy(eng, scene.gravity));
    if (k > 0.8 * steps) late = Math.max(late, maxSpeed(eng));
  }
  return { gain: (eMax - E0) / (scale ?? Math.abs(E0)), end: shadowEnergy(eng, scene.gravity) / E0, late };
}

type Shape = 'sphere' | 'cube' | 'edge';
/**
 * Drop body 0 onto the ground at impact speed v and measure its first bounce: eV, the rebound over the impact
 * speed at contact (0 if it never left), the spin from the impact on, and the largest energy over the start.
 * The ground's restitution is the body's (so the pair's e is e) unless `groundE` says otherwise.
 */
async function drop(shape: Shape, v: number, e: number, params: Partial<AvbdParams> = ON, o: { vt?: number; groundE?: number; rule?: CombineRule } = {}) {
  const vt = o.vt ?? 0, yc = shape === 'edge' ? Math.SQRT1_2 : 0.5, height = v * v / (2 * G);
  const pos: Vec3 = [0, yc + height, 0], linVel: Vec3 = [vt, 0, 0];
  const friction = vt ? 0 : 0.6;
  const body = shape === 'sphere' ? ball(pos, { e, linVel, friction }) : cube(pos, { e, linVel, rot: shape === 'edge' ? rotZ(Math.PI / 4) : undefined, friction });
  const scene = sceneOf([body], { friction, groundE: 'groundE' in o ? o.groundE : e, rule: o.rule });
  const eng = new AvbdReferenceEngine(params);
  await eng.init(scene);
  const E0 = shadowEnergy(eng, scene.gravity);
  const atContact = (y: number, vy: number) => Math.sqrt(Math.max(0, (vy - G * H / 2) ** 2 + 2 * G * (y - yc)));
  const b = () => eng.world!.bodies[0]!;
  let prev = { y: b().pos[1], vy: b().linVel[1] }, vIn = 0, vOut = 0, impact = false, spinMax = 0, eMax = E0, minY = Infinity, vtOut = NaN;
  const steps = Math.ceil(3 * v / (G * H)) + 60;
  for (let k = 0; k < steps; k++) {
    eng.step();
    const cur = { y: b().pos[1], vy: b().linVel[1] };
    eMax = Math.max(eMax, shadowEnergy(eng, scene.gravity));
    const free = Math.abs(cur.vy - prev.vy + G * H) < 1e-4;
    if (!impact && !free) { impact = true; vIn = atContact(prev.y, prev.vy); }
    if (impact) {
      spinMax = Math.max(spinMax, spin(eng));
      minY = Math.min(minY, cur.y);
      // The rebound: the first upward sample whose next step is free flight.
      if (!vOut && prev.vy > 0 && free) { vOut = atContact(prev.y, prev.vy); vtOut = b().linVel[0]; }
    }
    prev = cur;
  }
  return { eV: vIn ? vOut / vIn : 0, spinMax, eGain: (eMax - E0) / Math.abs(E0), minY: minY - yc, vtOut };
}

/** Zero-g head-on pair along x: body 0 (mass mA) at +v onto body 1 (mass mB) at rest, 0.5 m apart. */
async function pair(kind: 'sphere' | 'box', v: number, mA: number, mB: number, eA: number, eB: number, params: Partial<AvbdParams> = ON, rule?: CombineRule) {
  const mk = (x: number, m: number, e: number, vx: number) => (kind === 'sphere' ? ball([x, 0, 0], { e, mass: m, linVel: [vx, 0, 0] }) : cube([x, 0, 0], { e, density: m, linVel: [vx, 0, 0] }));
  const eng = new AvbdReferenceEngine(params);
  await eng.init(zeroG([mk(-0.75, mA, eA, v), mk(0.75, mB, eB, 0)], rule));
  // The pass alone: total linear momentum just before and after each call.
  const w = eng.world!, inner = w.restitute.bind(w);
  let passDrift = 0;
  const P = () => w.bodies.reduce((s, b) => s + b.mass * b.linVel[0], 0);
  w.restitute = (...a: Parameters<AvbdWorld['restitute']>) => { const p0 = P(); inner(...a); passDrift = Math.max(passDrift, Math.abs(P() - p0) / Math.abs(p0)); };
  for (let k = 0; k < Math.ceil(0.5 / v / H) + 90; k++) eng.step();
  const [a, b] = w.bodies;
  return { vA: a!.linVel[0], vB: b!.linVel[0], eEff: (b!.linVel[0] - a!.linVel[0]) / v, passDrift, spin: Math.max(spin(eng, 0), spin(eng, 1)) };
}

describe('restitution off (the default)', () => {
  it('is not in DEFAULT_AVBD, and off the engine variant lists no restitution key; on, it lists the switch and every default', () => {
    expect(Object.keys(DEFAULT_AVBD).some((k) => k.startsWith('restitution'))).toBe(false);
    const keys = Object.keys(new AvbdReferenceEngine().info.variant);
    expect(Object.keys(new AvbdReferenceEngine({ restitution: false, restitutionThreshold: 3, restitutionRounds: 2 }).info.variant)).toEqual(keys);
    expect(keys.some((k) => k.startsWith('restitution'))).toBe(false);
    expect(new AvbdReferenceEngine(ON).info.variant).toMatchObject({ restitution: true, ...RESTITUTION_DEFAULTS });
    expect(new AvbdReferenceEngine({ ...ON, restitutionRounds: 3 }).info.variant).toMatchObject({ restitutionThreshold: RESTITUTION_DEFAULTS.restitutionThreshold, restitutionRounds: 3 });
  });

  it('checks its params and the ground\'s restitution: threshold finite and >= 0, rounds an integer >= 1, ground restitution in [0, 1]', async () => {
    for (const t of [-0.1, NaN, Infinity]) expect(() => new AvbdReferenceEngine({ restitutionThreshold: t })).toThrow(`restitutionThreshold must be a finite number >= 0, got ${t}`);
    for (const r of [0, 2.5, -1, NaN]) expect(() => new AvbdReferenceEngine({ ...ON, restitutionRounds: r })).toThrow(`restitutionRounds must be an integer >= 1, got ${r}`);
    expect(() => new AvbdReferenceEngine({ ...ON, restitutionThreshold: 0, restitutionRounds: 1 })).not.toThrow();
    for (const g of [-0.1, 1.5, NaN]) await expect(new AvbdReferenceEngine().init(sceneOf([], { groundE: g }))).rejects.toThrow(`ground.restitution must be in [0, 1], got ${g}`);
    await expect(new AvbdReferenceEngine().init(sceneOf([], { groundE: 1 }))).resolves.toBeUndefined();
  });

  it('ignores BodyDesc.restitution, the ground\'s and the combine rule: a knockdown of bodies with e 0.9 is bit-identical to one with e 0', async () => {
    const run = async (e: number, params: Partial<AvbdParams>) => {
      const s = withE(knock(15), e);
      const eng = new AvbdReferenceEngine(params);
      await eng.init(e ? { ...s, ground: { ...s.ground!, restitution: e }, restitutionCombine: 'max' } : s);
      for (let k = 0; k < 60; k++) eng.step();
      return state(eng);
    };
    const base = await run(0, {});
    expect(await run(0.9, {})).toEqual(base);
    expect(await run(0.9, { restitution: false })).toEqual(base);
  });
});

describe('restitution on', () => {
  it.for([10, 20])('the dial: a sphere, a flat cube and a cube on its edge dropped at 5 and 10 m/s bounce at e within 10%, never above e (%i iterations)', async (iterations) => {
    for (const shape of ['sphere', 'cube', 'edge'] as const) for (const e of [0.3, 0.6, 0.9]) for (const v of [5, 10]) {
      const r = await drop(shape, v, e, { ...ON, iterations });
      // The pass sets the rebound (a separating point's force does not carry into the next step): measured 0.926-0.977.
      expect(r.eV / e, `${shape} e ${e} at ${v} m/s`).toBeGreaterThan(0.9);
      expect(r.eV / e, `${shape} e ${e} at ${v} m/s`).toBeLessThan(1);
    }
  });

  it('at 2 and 3 m/s the bounce is within the step-based band, [0.75, 1] x e', async () => {
    for (const shape of ['sphere', 'cube', 'edge'] as const) for (const e of [0.3, 0.9]) for (const v of [2, 3]) {
      const r = await drop(shape, v, e);
      // Measured 0.760 (sphere, e 0.3, 2 m/s; the 1-D model of the rule gives 0.762, so the bar is 0.012 under
      // the model) to 0.896.
      expect(r.eV / e, `${shape} e ${e} at ${v} m/s`).toBeGreaterThan(0.75);
      expect(r.eV / e, `${shape} e ${e} at ${v} m/s`).toBeLessThan(1);
    }
  });

  it('the ground\'s restitution combines with the body\'s: e 0.6 on a ground of 0.6 bounces at 0.6, on the default ground (0) at 0.3 under average, 0.6 under max', async () => {
    // The step-based band at 5 m/s, which the 1-D model of the rule puts at 0.956 for a pair e of 0.6, 0.929 for
    // 0.3 and 0.902 for 0.2: measured 0.956, 0.930, 0.956 and 0.905. Each bar is its model's value less 0.02.
    for (const [o, e, model] of [[{ groundE: 0.6 }, 0.6, 0.956], [{ groundE: undefined }, 0.3, 0.929], [{ groundE: undefined, rule: 'max' }, 0.6, 0.956], [{ groundE: 0.2, rule: 'min' }, 0.2, 0.902]] as const) {
      const eV = (await drop('sphere', 5, 0.6, ON, o)).eV / e;
      expect(eV, JSON.stringify(o)).toBeGreaterThan(model - 0.02);
      expect(eV, JSON.stringify(o)).toBeLessThan(1);
    }
  });

  it('below the threshold speed, and at e = 0, nothing changes: bit-identical to off', async () => {
    const run = async (params: Partial<AvbdParams>, e: number, v: number) => {
      const eng = new AvbdReferenceEngine(params);
      await eng.init(sceneOf([ball([0, 0.5 + v * v / (2 * G), 0], { e })], { groundE: e }));
      for (let k = 0; k < 120; k++) eng.step();
      return state(eng);
    };
    for (const v of [0.25, 0.5]) expect(await run(ON, 0.9, v)).toEqual(await run({}, 0.9, v));
    expect(await run(ON, 0, 5)).toEqual(await run({}, 0, 5));
    // A threshold above the impact speed turns it off too.
    expect(await run({ ...ON, restitutionThreshold: 6 }, 0.9, 5)).toEqual(await run({}, 0.9, 5));
  });

  it('a contact that reaches the threshold speed bounces (>=, as Box2D), one just below does not', async () => {
    expect((await pair('sphere', 1, 1, 1, 0.6, 0.6)).eEff).toBeCloseTo(0.6, 9);
    // Measured 0: below the threshold the two stay together.
    expect((await pair('sphere', 0.999, 1, 1, 0.6, 0.6)).eEff).toBeLessThan(0.1);
  });

  it.for(['sphere', 'box'] as const)('zero-g %s pairs separate at e x the approach speed, the pass keeping momentum to 1e-9', async (kind) => {
    for (const [mA, mB] of [[1, 1], [1, 5], [5, 1]] as const) for (const v of [3, 5]) for (const e of [0.3, 0.9]) {
      const r = await pair(kind, v, mA, mB, e, e);
      const id = `${kind} ${mA}:${mB} at ${v} m/s, e ${e}`;
      // Measured: eEff / e 1 to 6.7e-16, the pass's momentum change at most 3.6e-16 of the momentum, spin 0.
      expect(r.eEff / e, id).toBeCloseTo(1, 6);
      // At these speeds the solve keeps momentum too, so the end state is the 1-D formula's.
      expect(r.vA / v, id).toBeCloseTo((mA - mB * e) / (mA + mB), 4);
      expect(r.vB / v, id).toBeCloseTo(mA * (1 + e) / (mA + mB), 4);
      expect(r.passDrift, id).toBeLessThan(1e-9);
      expect(r.spin, id).toBeLessThan(1e-6);
    }
  });

  it('two coefficients combine by SceneDesc.restitutionCombine (default average), in either order, clamped to [0, 1]', async () => {
    for (const rule of [undefined, 'average', 'min', 'max', 'multiply'] as const) for (const [eA, eB] of [[0.2, 0.8], [0.8, 0.2]]) {
      const want = combineRestitution(rule ?? DEFAULT_RESTITUTION_COMBINE, eA!, eB!);
      // Measured: the combined e to 2.8e-17.
      expect((await pair('sphere', 5, 1, 1, eA!, eB!, ON, rule)).eEff, `${rule} ${eA}/${eB}`).toBeCloseTo(want, 6);
    }
    expect((await pair('sphere', 5, 1, 1, 1.5, 1.5)).eEff).toBeCloseTo(1, 6);
    // The pair's e, -0.1, is clamped to 0: no bounce. Measured 0.0185, the solve's own rebound.
    expect((await pair('sphere', 5, 1, 1, 0.6, -0.8)).eEff).toBeLessThan(0.1);
  });

  it('a flat cube and a cube balanced on its edge bounce straight: no spin (centroid step)', async () => {
    // Measured at most 8.3e-10 rad/s.
    for (const shape of ['cube', 'edge'] as const) for (const e of [0.3, 0.9]) for (const v of [3, 10]) {
      expect((await drop(shape, v, e)).spinMax, `${shape} e ${e} at ${v} m/s`).toBeLessThan(1e-6);
    }
  });

  it('frictionless oblique impacts keep the tangential velocity and gain no spin', async () => {
    for (const shape of ['sphere', 'cube'] as const) {
      const r = await drop(shape, 5, 0.6, ON, { vt: 4 });
      // Measured: eV 0.573-0.585 (the bar is 0.9 e), |vt' / vt - 1| 0, spin 0.
      expect(r.eV).toBeGreaterThan(0.54);
      expect(Math.abs(r.vtOut / 4 - 1)).toBeLessThan(1e-6);
      expect(r.spinMax).toBeLessThan(1e-6);
    }
  });

  it('bounces only off a contact that carried force: a speculative contact a step early does not turn the body around', async () => {
    // At these speeds the contact is found a step before touching (the margin grows with speed), and that step
    // it has no force. Bounced there, the ball turned around 2-17 mm above the ground. Measured: every drop reaches
    // it (minY -8.5e-5 to -5.5e-9 m).
    for (const v of [1.5, 2.75, 5.5, 9.25]) expect((await drop('sphere', v, 0.9)).minY, `${v} m/s`).toBeLessThan(1e-3);
  });

  it('energy never grows: drops at every speed, including e = 1', async () => {
    // Measured at most 1.9e-15.
    for (const shape of ['sphere', 'cube', 'edge'] as const) for (const e of [0.6, 1]) for (const v of [1, 2, 5, 10]) {
      expect((await drop(shape, v, e)).eGain, `${shape} e ${e} at ${v} m/s`).toBeLessThan(1e-9);
    }
  });

  // A body in two bouncing manifolds at once: two cubes strike a box side by side along the same normal. Each
  // manifold solves against its bodies with their masses divided by the number of the pass's manifolds they are
  // in (mass splitting). Plain Jacobi (each against the full masses) gives the box both impulses in full: in
  // one round it gained 32% of the energy here (e 1), 0.5-0.9% at e 0.5 with 5-10x heavier strikers.
  const twoOnOne = (rounds: number) => {
    const e = 1, box: BodyDesc = { ...cube([0, 0, 0], { e }), shape: { kind: 'box', half: [0.5, 1, 0.5] } };
    return gainOf(zeroG([cube([-1.3, 0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), cube([-1.3, -0.5, 0], { e, density: 2, linVel: [4, 0, 0] }), box]), { ...ON, restitutionRounds: rounds }, 90);
  };
  it('two cubes striking a box side by side (e = 1) gain no energy, in one round, four or eight (mass splitting)', async () => {
    const one = await twoOnOne(1), four = await twoOnOne(4), eight = await twoOnOne(8);
    // Measured 0 in all three (without supports, eight rounds gained 6.2e-4).
    for (const r of [one, four, eight]) expect(r.gain).toBeLessThan(1e-9);
    // It converges from below: measured 0.741 of the energy kept after one round, 0.973 after four (elastic: 1).
    // (At e 1 it overshoots beyond 8 rounds: 1.0019 at 16, 1.0034 at 64; see restitute().)
    expect(one.end).toBeGreaterThan(0.7);
    expect(four.end).toBeGreaterThan(0.95);
  });

  it('a cube dropped flat onto two cubes (two bouncing manifolds) gains no energy, comes to rest, and pins the pass\'s details', async () => {
    const e = 0.9, scene = sceneOf([cube([-0.55, 0.5, 0], { e }), cube([0.55, 0.5, 0], { e }), cube([0, 1.5 + 25 / (2 * G), 0], { e })], { groundE: e });
    const eng = new AvbdReferenceEngine(ON);
    await eng.init(scene);
    const E0 = shadowEnergy(eng, scene.gravity);
    let eMax = E0, up = 0, second: Vec3 = [0, 0, 0];
    for (let k = 1; k <= 600; k++) {
      eng.step();
      eMax = Math.max(eMax, shadowEnergy(eng, scene.gravity));
      up = Math.max(up, eng.world!.bodies[2]!.linVel[1]);
      if (k === 100) second = [...eng.world!.bodies[2]!.linVel];
    }
    // Measured: gain 0, end speed 1.0e-16 m/s.
    expect((eMax - E0) / Math.abs(E0)).toBeLessThan(1e-9);
    expect(maxSpeed(eng)).toBeLessThan(1e-9);
    // The first rebound off the two resting cubes: measured 3.843 m/s (supports held at 0 instead of at the solve's
    // normal velocity: 3.772).
    expect(up).toBeGreaterThan(3.8);
    // The pass's details have no measure of their own, so this run pins them by the top cube's velocity at step
    // 100, after its second landing. A 1e-12 m change of its start moves that by at most 4e-11 m/s; each of these
    // moves it by 1e-4 m/s or more: zeroing a bounced point's force where its impulse was 0 (the reset needs
    // P > 0), supports at unloaded points too, supports held at 0 (above), a centroid step that may pull. A
    // solver change that moves it needs these re-measured.
    expect(second[0]).toBeCloseTo(0.03865229182299252, 6);
    expect(second[1]).toBeCloseTo(0.023948944869160167, 6);
    expect(second[2]).toBeCloseTo(0.041232210571120045, 6);
  });

  it.for([10, 20])('resting stacks with e = 0.5 on every body still rest (%i iterations)', async (iterations) => {
    for (const s of [buildScenario('S1', { F: 1, H: 10, gap: 0 }, 1), buildScenario('S9', { H: 10, ratio: 100 }, 1)]) {
      const eng = new AvbdReferenceEngine({ ...ON, iterations });
      await eng.init({ ...withE(s, 0.5), sleep: false, ground: { ...s.ground!, restitution: 0.5 } });
      let maxV = 0;
      for (let k = 1; k <= 600; k++) {
        eng.step();
        if (k > 300) maxV = Math.max(maxV, maxSpeed(eng));
      }
      // Measured at most 1.4e-16 m/s.
      expect(maxV, s.id).toBeLessThan(1e-9);
    }
  });

  it('a ball of e 0.9 dropped at 5 m/s onto a 10-cube column bounces, and everything comes back to rest', async () => {
    const bodies = Array.from({ length: 10 }, (_, k) => cube([0, 0.5 + k, 0], { e: 0.9 }));
    const eng = new AvbdReferenceEngine(ON);
    await eng.init({ ...sceneOf(bodies, { groundE: 0.9 }), inputs: [{ step: 120, kind: 'spawn', body: ball([0, 10.5 + 25 / (2 * G), 0], { e: 0.9 }) }] });
    let up = 0, late = 0;
    for (let k = 1; k <= 1320; k++) {
      eng.step();
      if (k > 120) up = Math.max(up, eng.world!.bodies[10]!.linVel[1]);
      if (k > 1200) late = Math.max(late, maxSpeed(eng));
    }
    // Measured: up 2.23 m/s, late 7.6e-17 m/s.
    expect(up).toBeGreaterThan(2);
    expect(late).toBeLessThan(1e-9);
  });

  it('never pulls bodies together: a 144 kg ball (e 0.6) at 20 m/s onto a 10-cube column of e 0.05 leaves it standing', async () => {
    // A rubber ball on plaster, the ball's contact at 0.6 under max. Let a point's impulse go below 0 (pulling a
    // point the solve left separating faster than its target back down to it) and the column fell: a cube ended
    // 17.7 m from its place.
    const bodies = Array.from({ length: 10 }, (_, k) => cube([0, 0.5 + k, 0], { e: 0.05 }));
    const eng = new AvbdReferenceEngine(ON);
    await eng.init({ ...sceneOf(bodies, { rule: 'max' }), inputs: [{ step: 120, kind: 'spawn', body: ball([0, 10.5 + 400 / (2 * G), 0], { e: 0.6, mass: 144 }) }] });
    let late = 0;
    for (let k = 1; k <= 1020; k++) {
      eng.step();
      if (k > 816) late = Math.max(late, maxSpeed(eng));
    }
    const moved = Math.max(...bodies.map((b, i) => Math.hypot(...[0, 1, 2].map((r) => eng.world!.bodies[i]!.pos[r]! - b.pos[r]!))));
    // Measured 7.7e-8 m and 2.7e-13 m/s.
    expect(moved).toBeLessThan(0.3);
    expect(late).toBeLessThan(1e-9);
  });

  it('a ball knocks a tower of e 0.3 down without NaNs or energy gain', async () => {
    const run = async (params: Partial<AvbdParams>) => {
      const s = withE(knock(15), 0.3), scene = { ...s, ground: { ...s.ground!, restitution: 0.3 } };
      const eng = new AvbdReferenceEngine(params);
      await eng.init(scene);
      eng.step();
      const E0 = shadowEnergy(eng, scene.gravity);
      let eMax = E0, bad = 0, bounced = eng.world!.stats.restitution.contacts;
      for (let k = 0; k < 180; k++) {
        eng.step();
        eMax = Math.max(eMax, shadowEnergy(eng, scene.gravity));
        bad += nonFinite(eng.snapshot());
        bounced += eng.world!.stats.restitution.contacts;
      }
      return { gain: (eMax - E0) / Math.abs(E0), bad, bounced };
    };
    // A single collapse is chaotic, so its deepest penetration is no measure here (over 9 ball speeds the median
    // was 1.36 x off's under average, 0.93 x under max).
    const on = await run(ON), off = await run({});
    // Measured: 486 points bounced, no non-finite value, a gain of 0 (off: 0).
    expect(on.bounced).toBeGreaterThan(100);
    expect(on.bad).toBe(0);
    expect(on.gain).toBeLessThan(Math.max(off.gain, 0) + 1e-9);
  });

  it('is deterministic', async () => {
    const run = async () => {
      const eng = new AvbdReferenceEngine(ON);
      await eng.init(withE(knock(13), 0.5));
      let bounced = 0;
      for (let k = 0; k < 90; k++) { eng.step(); bounced += eng.world!.stats.restitution.contacts; }
      return [bounced, ...state(eng)];
    };
    const a = await run();
    // Measured: 63 points bounced.
    expect(a[0]).toBeGreaterThan(20);
    expect(await run()).toEqual(a);
  });
});

describe('restitution on: supports', () => {
  // Every other loaded contact of a body in a bouncing manifold holds it during the pass (depth 1).
  it('a 510 kg ball (e 0.9, 10 m/s) bouncing off a 1 kg cube on the ground gains no energy, and both come to rest', async () => {
    const r = 0.25, mb = 510, v = 10, e = 0.9;
    const scene = sceneOf([cube([0, 0.5, 0], { e }), ball([0, 1 + r + 0.3, 0], { e, radius: r, mass: mb, linVel: [0, -v, 0] })], { groundE: e });
    const { gain, late } = await gainOf(scene, ON, 600, mb * (0.5 * v * v + G * 0.3));
    // Measured 0 and 1.2e-17 m/s. Without supports the pass drove the cube into the ground at 19 m/s, the two
    // then threw each other about: a gain of 8.17 x the impact's energy, and bodies at 81.8 m/s after 10 s.
    expect(gain).toBeLessThan(1e-9);
    expect(late).toBeLessThan(1e-9);
  });

  it('a 1 kg ball (e 0.9, 20 m/s) onto a 0.4 kg cube lying on the ground gains no energy', async () => {
    const v = 20, e = 0.9;
    const scene = sceneOf([cube([0, 0.5, 0], { e, density: 0.4 }), ball([0, 1.8, 0], { e, linVel: [0, -v, 0] })], { groundE: e });
    // Measured 0 (without supports 2.45 x the impact's energy).
    expect((await gainOf(scene, ON, 600, 0.5 * v * v + G * 0.3)).gain).toBeLessThan(1e-7);
  });

  /**
   * A ball of `mass` kg dropped at v onto a cube settled on the ground (e on all three): its first rebound over its
   * impact speed, at contact, and the cube's fastest speed down until then.
   */
  const offRestingCube = async (v: number, e: number, params: Partial<AvbdParams>, mass = 1) => {
    const yc = 1.5, spawn = 120;
    const eng = new AvbdReferenceEngine(params);
    await eng.init({ ...sceneOf([cube([0, 0.5, 0], { e })], { groundE: e }), inputs: [{ step: spawn, kind: 'spawn', body: ball([0, yc + v * v / (2 * G), 0], { e, mass }) }] });
    for (let k = 0; k <= spawn; k++) eng.step();
    const atContact = (y: number, vy: number) => Math.sqrt(Math.max(0, (vy - G * H / 2) ** 2 + 2 * G * (y - yc)));
    const b = () => eng.world!.bodies[1]!;
    let prev = { y: b().pos[1], vy: b().linVel[1] }, vIn = 0, down = 0;
    for (let k = 0; k < Math.ceil(3 * v / (G * H)) + 60; k++) {
      eng.step();
      down = Math.max(down, -eng.world!.bodies[0]!.linVel[1]);
      const cur = { y: b().pos[1], vy: b().linVel[1] }, free = Math.abs(cur.vy - prev.vy + G * H) < 1e-4;
      if (!vIn && !free) vIn = atContact(prev.y, prev.vy);
      else if (vIn && prev.vy > 0 && free) return { eV: atContact(prev.y, prev.vy) / vIn, down };
      prev = cur;
    }
    return { eV: 0, down };
  };

  it('the cost: a ball bounces softer off a body that rests on others, and more rounds give back more (default 8)', async () => {
    const at = async (rounds?: number) => (await offRestingCube(3, 0.9, rounds ? { ...ON, restitutionRounds: rounds } : ON)).eV;
    const four = await at(4), eight = await at(), sixteen = await at(16);
    // e 0.9 at 3 m/s: measured 0.154, 0.490 and 0.729 of the approach (Rapier: 0.45-0.49).
    expect(four).toBeLessThan(eight);
    expect(eight).toBeGreaterThan(0.45);
    expect(eight).toBeLessThan(sixteen);
    expect(sixteen).toBeLessThan(0.9);
  });

  // The supports converge at a rate set by the mass ratio (Jacobi), so the cost grows with the striker's mass.
  // This pins a known limit (see restitute()): a change that lifts it fails here, and the docs should follow.
  it('the cost grows with the striker\'s mass: a 5 kg ball bounces off the resting cube far softer than 1 kg, and drives it into the ground', async () => {
    const one = await offRestingCube(3, 0.9, ON), five = await offRestingCube(3, 0.9, ON, 5), off = await offRestingCube(3, 0.9, {}, 5);
    // e 0.9 at 3 m/s, 8 rounds: measured 0.490 of the approach at 1 kg and 0.187 at 5 kg; the cube is driven
    // down at 1.75 m/s, against 0.066 with the switch off.
    expect(five.eV).toBeLessThan(0.5 * one.eV);
    expect(five.eV).toBeGreaterThan(0.1);
    expect(five.down).toBeGreaterThan(1);
    expect(off.down).toBeLessThan(0.2);
  });
});

describe('restitution on: the force a bounced point keeps', () => {
  it('a resting 24-cube column (e 0.9) under restitutionThreshold 0 still rests, sagging as with restitution off', async () => {
    const s = withE({ ...buildScenario('S1', { F: 1, H: 24, gap: 0 }, 1), sleep: false }, 0.9), scene = { ...s, ground: { ...s.ground!, restitution: 0.9 } };
    const run = async (params: Partial<AvbdParams>) => {
      const eng = new AvbdReferenceEngine(params);
      await eng.init(scene);
      const top = scene.bodies.length - 1, y0 = scene.bodies[top]!.pos[1];
      let late = 0, minTop = Infinity;
      for (let k = 1; k <= 600; k++) {
        eng.step();
        minTop = Math.min(minTop, eng.world!.bodies[top]!.pos[1]);
        if (k > 400) late = Math.max(late, maxSpeed(eng));
      }
      return { late, sag: y0 - minTop };
    };
    const on = await run({ ...ON, restitutionThreshold: 0 }), off = await run({});
    // Measured: late speed 2.1e-16 m/s, sag 0.0539 m against off's 0.0550 (1.06e-3 less; both deepest before step
    // 600). Zeroing every bounced point's force dropped the load floor and cap: the column moved at 1.04 m/s and sank
    // 3.13 m.
    expect(on.late).toBeLessThan(1e-9);
    expect(Math.abs(on.sag - off.sag)).toBeLessThan(2e-3);
  });
});

describe('restitution stats (AvbdWorld.stats.restitution)', () => {
  const run = async (scene: SceneDesc, params: Partial<AvbdParams>, steps: number) => {
    const eng = new AvbdReferenceEngine(params);
    await eng.init(scene);
    let contacts = 0, impulse = 0, momentum = 0, ground = 0, offGround = 0;
    for (let k = 0; k < steps; k++) {
      eng.step();
      const r = eng.world!.stats.restitution;
      contacts += r.contacts;
      impulse += r.impulse;
      momentum = Math.max(momentum, Math.hypot(...r.momentum));
      ground = Math.max(ground, Math.hypot(...r.groundImpulse));
      offGround = Math.max(offGround, Math.hypot(r.momentum[0] - r.groundImpulse[0], r.momentum[1] - r.groundImpulse[1], r.momentum[2] - r.groundImpulse[2]));
    }
    return { contacts, impulse, momentum, ground, offGround };
  };

  it('count the bounced points and their impulse; between bodies the momentum change is 0, on the ground it is the ground\'s impulse', async () => {
    const pairs = await run(zeroG([ball([-0.75, 0, 0], { e: 0.6, linVel: [5, 0, 0] }), ball([0.75, 0, 0], { e: 0.6, mass: 5 })]), ON, 60);
    expect(pairs.contacts).toBe(1);
    // 1 kg at 5 m/s onto 5 kg, e 0.6: at most the whole impact's (1 + e) x the reduced mass x 5 m/s. Measured
    // 6.667, the whole: the contact caught them at the end of the step, so the bar is 0.95 x the whole.
    expect(pairs.impulse).toBeGreaterThan(0.95 * 1.6 * (5 / 6) * 5);
    expect(pairs.impulse).toBeLessThan(1.6 * (5 / 6) * 5 + 1e-9);
    // Measured 8.9e-16 N s (rounding).
    expect(pairs.momentum).toBeLessThan(1e-12);
    expect(pairs.ground).toBe(0);
    const s = withE(knock(15), 0.6), knocked = await run({ ...s, ground: { ...s.ground!, restitution: 0.6 } }, ON, 120);
    // Measured: 382 points bounced.
    expect(knocked.contacts).toBeGreaterThan(0);
    expect(knocked.ground).toBeGreaterThan(0);
    // Measured 7.2e-15 N s against a ground impulse of up to 22.8 N s in a step.
    expect(knocked.offGround).toBeLessThan(1e-12);
  });

  it('count only the points that bounced, not the supports that held their bodies (whose impulse counts)', async () => {
    // A ball (e 0.9) at 5 m/s onto a cube resting on the ground, run to just after its first bounce: its one
    // point bounces, and the cube's four ground points hold the cube.
    const scene: SceneDesc = { ...sceneOf([cube([0, 0.5, 0], { e: 0.9 })], { groundE: 0.9 }), inputs: [{ step: 120, kind: 'spawn', body: ball([0, 1.5 + 25 / (2 * G), 0], { e: 0.9 }) }] };
    const r = await run(scene, ON, 160);
    expect(r.contacts).toBe(1);
    // The supports passed the bounce on to the ground: measured 3.48 N s in a step. Counted with them, contacts was 5.
    expect(r.ground).toBeGreaterThan(1);
    // Measured 7.41 N s in all: 3.93 at the ball's point and 3.48 at the cube's ground points (without them 3.93).
    expect(r.impulse).toBeGreaterThan(r.ground + 1);
  });

  it('stay 0 with restitution off', async () => {
    const s = withE(knock(15), 0.6), off = await run({ ...s, ground: { ...s.ground!, restitution: 0.6 } }, {}, 60);
    expect(off).toEqual({ contacts: 0, impulse: 0, momentum: 0, ground: 0, offGround: 0 });
  });
});

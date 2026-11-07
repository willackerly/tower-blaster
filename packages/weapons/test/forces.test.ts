// Force actions (spec.ts thrust and vibrate, weapons plan step 6): the spec
// language checks and scales them, the budget counts the munitions they can
// force, and WeaponRuntime turns them into engine-api ForceEvents of accel x
// the munition's mass, never forcing more than MAX_FORCED bodies at once. On
// the f64 reference engine a rocket gains its motor's delta-v along its
// heading and replays bit for bit at every reader cadence.
import { describe, expect, it } from 'vitest';
import { type BodyDesc, checkInputQueue, type InputEvent, MAX_FORCED, queueInputs, type SceneDesc, type ShapeDesc, type Snapshot, type SpawnEvent, type Vec3, volumeOf } from '@tb/engine-api';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { BUILTIN_WEAPONS, checkWeapon, FIREWORK, type GrenadeWorld, ROCKET, scaleWeapon, validateWeapon, type WeaponSpec, weaponBudget, WeaponRuntime, writeWeapon } from '../src/index.ts';

const DT = 1 / 60;
const WORLD: GrenadeWorld = { dt: DT, substeps: 1, gravity: [0, -9.81, 0], groundY: 0 };
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const codes = (x: unknown, level: 'error' | 'warn' = 'error') => validateWeapon(x).issues.filter((i) => i.level === level).map((i) => i.code);

/** A ball that shakes sideways for 1 s, then is spent. */
const SHAKER: WeaponSpec = {
  version: 1, name: 'shaker',
  shell: { shape: { kind: 'sphere', radius: 0.25 }, density: 6, speed: [5, 20] },
  rules: [
    { when: { after: 0 }, do: [{ vibrate: { accel: [0, 0, 40], period: 0.2, phase: 0.25, for: 1 } }] },
    { when: { after: 1.5 }, do: [{ remove: true }] },
  ],
};

describe('force actions in the spec language', () => {
  it('thrust and vibrate validate, keep their keys in a canonical order, and leave defaults unfilled', () => {
    for (const spec of [ROCKET, SHAKER]) {
      expect(validateWeapon(spec).issues).toEqual([]);
      const text = writeWeapon(spec);
      const shuffled = JSON.parse(text, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
      expect(writeWeapon(checkWeapon(shuffled))).toBe(text);
    }
    expect(checkWeapon(ROCKET).rules[0]!.do[0]).toEqual({ thrust: { accel: [0, 25, 0], for: 1 } });
    expect(Object.keys((checkWeapon(SHAKER).rules[0]!.do[0] as { vibrate: object }).vibrate)).toEqual(['accel', 'period', 'phase', 'for']);
  });

  it('refuses bad axes, accelerations out of range, a whole-period phase, unknown keys, and a force after the munition is spent', () => {
    const t = (thrust: unknown) => ({ ...clone(ROCKET), rules: [{ when: { after: 0 }, do: [{ thrust }, { remove: true }] }] });
    expect(codes(t({ accel: [0, 1, 0], for: 1, axes: 'up' }))).toEqual(['range']);
    expect(codes(t({ accel: [0, 2000, 0], for: 1 }))).toEqual(['range']);
    expect(codes(t({ accel: [0, 1], for: 1 }))).toEqual(['type']);
    expect(codes(t({ accel: [0, 1, 0], for: 0 }))).toEqual(['range']);
    expect(codes(t({ accel: [0, 1, 0], for: 1, spin: 2 }))).toEqual(['key']);
    for (const axes of ['heading', 'body', 'world']) expect(codes(t({ accel: [0, 1, 0], for: 1, axes }))).toEqual([]);
    const v = (vibrate: unknown) => ({ ...clone(ROCKET), rules: [{ when: { after: 0 }, do: [{ vibrate }, { remove: true }] }] });
    expect(codes(v({ accel: [1, 0, 0], period: 0.1, phase: 1, for: 1 }))).toEqual(['range']);
    expect(codes(v({ accel: [1, 0, 0], period: 0, for: 1 }))).toEqual(['range']);
    expect(codes(v({ accel: [1, 0, 0], for: 1 }))).toEqual(['type']);
    const late = { ...clone(ROCKET), rules: [{ when: { after: 0 }, do: [{ remove: true }, { thrust: { accel: [0, 1, 0], for: 1 } }] }] };
    expect(codes(late)).toEqual(['order']);
    // A force is not a way to spend the munition.
    expect(codes({ ...clone(ROCKET), rules: [clone(ROCKET).rules[0]] }, 'warn')).toEqual(['never-spent']);
  });

  it('the budget counts the munitions a force can act on, and refuses more than MAX_FORCED', () => {
    expect(weaponBudget(ROCKET).forced).toBe(1);
    expect(weaponBudget(ROCKET).forces).toEqual([{ path: 'rules.0.do.0', action: (ROCKET.rules[0]!.do[0] as { thrust: object }).thrust, kind: 'thrust', count: 1 }]);
    for (const [name, spec] of Object.entries(BUILTIN_WEAPONS)) expect(weaponBudget(spec).forced, name).toBe(name === 'rocket' ? 1 : 0);
    // Firework stars that each light a motor: 12 forced; 64 of them fit, 65 do not.
    const stars = (n: number) => {
      const f = clone(FIREWORK);
      f.rules[0]!.do[0] = { split: { ...(f.rules[0]!.do[0] as { split: { into: number } }).split, into: n, at: 10 } } as never;
      f.children!.star!.rules.unshift({ when: { after: 0.1 }, do: [{ thrust: { accel: [0, 5, 0], for: 0.5 } }] });
      return f;
    };
    expect(weaponBudget(stars(12)).forced).toBe(12);
    expect(codes(stars(MAX_FORCED))).toEqual([]);
    // A second split adds up (an upper bound, as bodies do): 65.
    const over = stars(MAX_FORCED);
    over.rules.push({ when: { after: 3 }, do: [{ split: { into: 1, child: 'star' } }] });
    expect(weaponBudget(over).forced).toBe(MAX_FORCED + 1);
    expect(codes(over)).toEqual(['budget']);
  });

  it('scaleWeapon takes accelerations as speed^2 / length (as gravity scales), and leaves times', () => {
    const s = scaleWeapon(SHAKER, { length: 0.5, speed: Math.sqrt(0.5) });
    const v = (s.rules[0]!.do[0] as { vibrate: { accel: Vec3; period: number; for: number } }).vibrate;
    expect(v.accel[2]).toBeCloseTo(40, 12);
    expect([v.period, v.for]).toEqual([0.2, 1]);
    const r = scaleWeapon(ROCKET, { length: 2, speed: 1 });
    expect((r.rules[0]!.do[0] as { thrust: { accel: Vec3 } }).thrust.accel).toEqual([0, 12.5, 0]);
  });
});

describe('WeaponRuntime: force actions', () => {
  const SHELL: ShapeDesc = ROCKET.shell.shape, MASS = ROCKET.shell.density * volumeOf(ROCKET.shell.shape);

  it('a rocket pushes a heading thrust of accel x its mass when its motor lights, for its burn in steps, once its contact fuse cannot come first', async () => {
    // At launch its fuse (which removes it) is open, so the motor waits to be released (a force on a removed body is refused).
    expect(new WeaponRuntime(WORLD, 1).launch(0, 0, ROCKET, SHELL)).toEqual([]);
    const { events } = await fly(1, 10, { pos: [0, 2, 0], vel: [10, 6, 0] });
    expect(events.filter((e) => e.kind === 'force')).toEqual([{ step: 6, kind: 'force', id: 0, force: { steps: 60, thrust: [0, 25 * MASS, 0], axes: 'heading' } }]);
  });

  it('a shaker pushes a world vibration with its period and phase; a burn under a step is one step', () => {
    const rt = new WeaponRuntime(WORLD, 1), m = SHAKER.shell.density * volumeOf(SHAKER.shell.shape);
    expect(rt.launch(0, 0, SHAKER, SHAKER.shell.shape)).toEqual([
      { step: 0, kind: 'force', id: 0, force: { steps: 60, vibrate: [0, 0, 40 * m], period: 0.2, phase: 0.25 } },
      { step: 90, kind: 'remove', id: 0 },
    ]);
    const blip = { ...clone(SHAKER), rules: [{ when: { after: 0 }, do: [{ thrust: { accel: [1, 0, 0], axes: 'world', for: 0.001 } }, { remove: true }] }] } as WeaponSpec;
    expect(new WeaponRuntime(WORLD, 1).launch(0, 0, blip, SHAKER.shell.shape)[0]).toMatchObject({ force: { steps: 1 } });
  });

  it('never forces more than MAX_FORCED bodies at once: the next is dropped, and fits again once one is spent', () => {
    const rt = new WeaponRuntime(WORLD, 1), out: InputEvent[] = [];
    const bodies: BodyDesc[] = [];
    for (let i = 0; i <= MAX_FORCED; i++) {
      bodies.push({ shape: SHAKER.shell.shape, pos: [2 * i, 5, 0], rot: [0, 0, 0, 1], linVel: [0, 0, 0], angVel: [0, 0, 0], density: 6, friction: 0.5, restitution: 0, tag: 0 });
      out.push(...rt.launch(i, 0, SHAKER, SHAKER.shell.shape));
    }
    expect(out.filter((e) => e.kind === 'force')).toHaveLength(MAX_FORCED);
    expect(rt.forcesDropped).toBe(1);
    // An engine takes the queue (checkInputQueue refuses MAX_FORCED + 1 at a step).
    expect(() => checkInputQueue(bodies.length, queueInputs([], out))).not.toThrow();
    // Shakers are spent at 1.5 s; their forces ended at 1 s, so one launched at 1.2 s fits.
    expect(rt.launch(MAX_FORCED, 72, SHAKER, SHAKER.shell.shape).filter((e) => e.kind === 'force')).toHaveLength(1);
  });
});

/** A ROCKET fired at step 0 on the reference engine, read every `cadence` steps with that lookahead. */
async function fly(cadence: number, steps: number, launch: { pos: Vec3; vel: Vec3 }, spec: WeaponSpec = ROCKET) {
  const sc: SceneDesc = { id: 'rocket', params: {}, seed: 0, gravity: WORLD.gravity, dt: DT, sleep: false, inputs: [], ground: { y: 0, friction: 0.5 }, bodies: [] };
  const e = new AvbdReferenceEngine();
  await e.init(sc);
  const shell: BodyDesc = { shape: spec.shell.shape, pos: launch.pos, rot: [0, 0, 0, 1], linVel: launch.vel, angVel: [0, 0, 0], density: spec.shell.density, friction: 0.5, restitution: 0, tag: 0 };
  const rt = new WeaponRuntime(WORLD, cadence), events: InputEvent[] = [];
  let queue: InputEvent[] = [];
  const push = (evs: InputEvent[]) => { e.push(evs); queue = queueInputs(queue, evs); events.push(...evs); };
  push([{ step: 0, kind: 'spawn', body: shell }]);
  push(rt.launch(0, 0, spec, shell.shape));
  const spawns = () => queue.filter((x): x is SpawnEvent => x.kind === 'spawn');
  const snaps: Snapshot[] = [e.snapshot()];
  for (let k = 1; k <= steps; k++) {
    e.step();
    snaps.push(e.snapshot());
    if (k % cadence === 0) push(rt.observe(snaps[k]!, k, spawns().map((x) => x.body), (ev) => spawns().indexOf(ev)));
  }
  return { snaps, events };
}

describe('WeaponRuntime: a rocket on the reference engine', () => {
  it('gains its motor\'s delta-v (25 units/s^2 for 1 s) along its heading over a ballistic shell, then blows on the ground and is spent', { timeout: 60_000 }, async () => {
    // Fired straight up, the heading never turns: the motor adds exactly 25 units/s over gravity alone.
    const up = await fly(1, 120, { pos: [0, 1, 0], vel: [0, 10, 0] });
    const vy = (k: number) => up.snaps[k]!.linVel[1]!;
    expect(vy(80) - (10 - 9.81 * 80 * DT)).toBeCloseTo(25, 9);
    // Fired at 30 degrees, it climbs higher and goes further than the shell without its motor.
    const coast = { ...clone(ROCKET), rules: [ROCKET.rules[1]!] };
    const a = await fly(1, 400, { pos: [0, 1, 0], vel: [10, 6, 0] }), b = await fly(1, 400, { pos: [0, 1, 0], vel: [10, 6, 0] }, coast);
    const blastAt = (r: typeof a) => r.events.find((x) => x.kind === 'blast')!;
    const x = (r: typeof a) => r.snaps[blastAt(r).step]!.pos[0]!;
    expect(x(a)).toBeGreaterThan(3 * x(b));
    expect(a.events.filter((x) => x.kind === 'remove')).toHaveLength(1);
  });

  it('replays bit for bit at every reader cadence (the motor is on a timer)', { timeout: 60_000 }, async () => {
    const runs = await Promise.all([1, 4].map((c) => fly(c, 200, { pos: [0, 1, 0], vel: [10, 6, 0] })));
    const strip = (evs: InputEvent[]) => evs.map((x) => JSON.stringify(x));
    expect(strip(runs[1]!.events).sort()).toEqual(strip(runs[0]!.events).sort());
    expect(runs[1]!.snaps.at(-1)).toEqual(runs[0]!.snaps.at(-1));
  });
});

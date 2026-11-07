// Ice played (ice.ts, Driver): L1 built of ice under its par cannonball, on Rapier. Blocks crack in
// levels and some shatter into pieces that are bodies like any other; the shatters are input events
// like a weapon's, so a session replays bit for bit, serial and pipelined alike, from the recorded
// inputs on a plain engine, and from an undo checkpoint taken mid-shot. The rules on hand-made
// states are keystone ice.test.ts.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { type InputEvent, massOf, TIER_FREE } from '@tb/engine-api';
import { compileLevel, Driver, type Feedback, IceBreaker, L1, type LevelDef, runSession, type SessionResult, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';

const def: LevelDef = {
  ...L1, id: 'L1-ice',
  parts: [{ kind: 'block', at: [-1, 0, -1], size: [2, 10, 2], material: 'ice', courses: [{ k: 9, role: 'crown' }] }],
};
const c = compileLevel(def);
const n = c.meta.n;
const par = L1.solutions!.par![0]! as Shot;

async function play(pipelined: boolean): Promise<{ r: SessionResult; pushed: InputEvent[] }> {
  let pushed: InputEvent[] = [];
  const r = await runSession(new RapierEngine(), c, [par], { pipelined, perStep: (d) => { pushed = d.pushed; return []; } });
  return { r, pushed: [...pushed] };
}
const inputsOf = (r: SessionResult, pushed: InputEvent[]): InputEvent[] => [...r.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step)), ...pushed];
const of = <T extends Feedback['t']>(fb: Feedback[], t: T) => fb.filter((f): f is Extract<Feedback, { t: T }> => f.t === t);

describe('an ice tower under a cannonball', () => {
  it('cracks in levels, shatters blocks into pieces that keep their mass, and replays bit for bit: serial = pipelined = the recorded inputs', async () => {
    const serial = await play(false);
    const fb = serial.r.feedback, s = serial.r.snapshot;
    const cracks = of(fb, 'iceCrack'), shatters = of(fb, 'shatter');
    expect(cracks.length).toBeGreaterThan(10);
    expect(shatters.length).toBeGreaterThan(0);
    // A block's crack only grows, and its origin never moves.
    const last = new Map<number, Extract<Feedback, { t: 'iceCrack' }>>();
    for (const k of cracks) {
      const p = last.get(k.body);
      if (p) { expect(k.level).toBeGreaterThan(p.level); expect(k.at).toEqual(p.at); expect(k.seed).toBe(p.seed); }
      expect(k.level).toBeGreaterThanOrEqual(1);
      expect(k.level).toBeLessThanOrEqual(7);
      last.set(k.body, k);
    }
    // Each shatter: one structure block removed (a tombstone), 8 pieces at consecutive engine ids after the ammo
    // and the pieces before; at most one a step; the session counts it.
    let next = n + 1;
    const steps = new Set<number>();
    for (const sh of shatters) {
      expect(sh.body).toBeLessThan(n);
      expect(s.tier![sh.body]).toBe(TIER_FREE);
      expect(sh.pieces).toEqual(Array.from({ length: 8 }, (_, k) => next + k));
      expect(steps.has(sh.step)).toBe(false);
      steps.add(sh.step);
      next += 8;
    }
    expect(s.count).toBe(n + 1 + 8 * shatters.length);
    expect(serial.r.session.shattered).toEqual(shatters.map((x) => x.body));
    expect(8 * shatters.length).toBeLessThanOrEqual(IceBreaker.budget(c));
    const events = serial.pushed;
    expect(events.filter((e) => e.kind === 'remove')).toHaveLength(shatters.length);
    expect(events.filter((e) => e.kind === 'spawn')).toHaveLength(8 * shatters.length);
    // Mass kept: each shatter's pieces weigh what its block did.
    for (const sh of shatters) {
      const spawns = events.filter((e) => e.kind === 'spawn' && e.step === sh.step);
      expect(spawns.reduce((a, e) => a + (e.kind === 'spawn' ? massOf(e.body) : 0), 0)).toBeCloseTo(c.meta.mass[sh.body]!, 9);
    }

    // Pipelined: the same events at the same steps; the world is the serial one, stepped on as far.
    const piped = await play(true);
    expect(piped.pushed).toEqual(serial.pushed);
    expect(of(piped.r.feedback, 'iceCrack')).toEqual(cracks);
    expect(piped.r.steps).toBeGreaterThanOrEqual(serial.r.steps);
    const ahead = new RapierEngine();
    await ahead.init({ ...c.scene, inputs: inputsOf(serial.r, serial.pushed) });
    while (ahead.stepIndex < piped.r.steps) ahead.step();
    expect(snapshotHash(piped.r.snapshot)).toBe(snapshotHash(ahead.snapshot()));
    ahead.dispose();
    // Again, and from the recorded inputs on a plain engine.
    const again = await play(false);
    expect(snapshotHash(again.r.snapshot)).toBe(snapshotHash(s));
    const e = new RapierEngine();
    await e.init({ ...c.scene, inputs: inputsOf(serial.r, serial.pushed) });
    while (e.stepIndex < serial.r.steps) e.step();
    expect(snapshotHash(e.snapshot())).toBe(snapshotHash(s));
    e.dispose();
  }, 240_000);

  it('an undo checkpoint taken after the first shatter, restored, plays out to the same end', async () => {
    const d = new Driver(new RapierEngine(), c);
    await d.reset();
    d.fire(par);
    let fb: Feedback[] = [];
    while (d.session.phase === 'running' && !fb.some((f) => f.t === 'shatter')) fb = await d.step();
    expect(fb.some((f) => f.t === 'shatter')).toBe(true);
    const cp = d.checkpoint()!;
    const end = async () => {
      const out: Feedback[] = [];
      while (d.session.phase === 'running') out.push(...(await d.step()));
      await d.drain();
      return { hash: snapshotHash(d.snapshot), count: d.snapshot.count, shattered: [...d.session.shattered], fb: JSON.stringify(out), pushed: d.pushed.length };
    };
    const first = await end();
    cp.restore();
    expect(await end()).toEqual(first);
    cp.dispose();
    d.engine.dispose();
  }, 240_000);

  it('a level that turns shattering off only cracks; a tower of plaster has no ice at all', async () => {
    const r = await runSession(new RapierEngine(), compileLevel({ ...def, physics: { ice: { shatter: false } } }), [par]);
    expect(of(r.feedback, 'shatter')).toHaveLength(0);
    expect(of(r.feedback, 'iceCrack').length).toBeGreaterThan(10);
    expect(r.snapshot.count).toBe(n + 1);
    const plain = await runSession(new RapierEngine(), compileLevel(L1), [par]);
    expect(of(plain.feedback, 'iceCrack')).toHaveLength(0);
  }, 240_000);

  it('fragments (the default) stop near where they broke; even cubes on ice\'s own friction skate (PT15)', async () => {
    // Each piece's horizontal distance from where it spawned to where the session settles it.
    const travel = async (fragments: boolean) => {
      let pushed: InputEvent[] = [];
      const r = await runSession(new RapierEngine(), compileLevel({ ...def, physics: { ice: { fragments } } }), [par], { perStep: (d) => { pushed = d.pushed; return []; } });
      const spawns = pushed.filter((e) => e.kind === 'spawn');
      const d = spawns.map((e, k) => { const id = n + 1 + k, p = e.body.pos; return Math.hypot(r.snapshot.pos[3 * id]! - p[0], r.snapshot.pos[3 * id + 2]! - p[2]) * c.frame.unit; });
      d.sort((a, b) => a - b);
      return { pieces: d.length, median: d[d.length >> 1]!, p90: d[Math.floor(0.9 * (d.length - 1))]!, max: d[d.length - 1]! };
    };
    const rough = await travel(true), even = await travel(false);
    console.log('ice pieces travel (m)', JSON.stringify({ rough, even }));
    expect(rough.pieces).toBeGreaterThan(0);
    expect(even.pieces).toBeGreaterThan(0);
    expect(rough.median).toBeLessThan(0.5 * even.median);
    expect(rough.p90).toBeLessThan(0.5 * even.p90);
    // Measured: median 1.1 m, p90 3.8 m, max 6.1 m, against 6.1, 23.6 and 39 m for even cubes on ice's 0.05.
    expect(rough.p90).toBeLessThan(5);
  }, 240_000);
});

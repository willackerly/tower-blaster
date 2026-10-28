// PlayOptions.perStep: input a hook decides from the observed state (the
// weapons runtime's), pushed through Driver.push. It must play the same on a
// serial and a pipelined driver, replay from the recorded inputs, and leave
// the session tracking the right ammo when it spawns bodies of its own.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { BodyDesc, InputEvent } from '@tb/engine-api';
import { compileLevel, Driver, L1, type PerStep, runSession, type SessionResult, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';

const c = compileLevel(L1), n = c.meta.n;
const par = L1.solutions!.par as Shot[];
const block = (x: number): BodyDesc => ({ ...c.scene.bodies[0]!, pos: [x, 6, 3], linVel: [0, 0, 0], angVel: [0, 0, 0] });

/** A hook that drops a block on the 10th observed step of every shot (stamped as Driver.push asks), keeping its own count. */
function dropper(): PerStep {
  let seen = 0, shot = 0, x = 3;
  return (d) => {
    if (d.session.strokes !== shot) { shot = d.session.strokes; seen = 0; }
    return ++seen === 10 ? [{ step: d.snapshotStep + 1, kind: 'spawn', body: block((x += 1.5)) }] : [];
  };
}

/** Every input the session pushed, shots and hook alike, as scene inputs for a plain engine. */
const inputsOf = (r: SessionResult, pushed: InputEvent[]): InputEvent[] => [...r.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step)), ...pushed];

async function plain(inputs: InputEvent[], steps: number) {
  const e = new RapierEngine();
  await e.init({ ...c.scene, inputs });
  while (e.stepIndex < steps) e.step();
  const h = snapshotHash(e.snapshot());
  e.dispose();
  return h;
}

/** runSession, keeping the driver's pushed events. */
async function play(shots: Shot[], pipelined: boolean) {
  let pushed: InputEvent[] = [];
  const hook = dropper();
  const r = await runSession(new RapierEngine(), c, shots, { pipelined, perStep: (d) => { pushed = d.pushed; return hook(d); } });
  return { r, pushed: [...pushed] };
}

describe('PlayOptions.perStep', () => {
  it('pushes the same input at the same steps serial and pipelined, and the session replays from its inputs', async () => {
    const serial = await play(par, false), piped = await play(par, true);
    expect(serial.pushed.length).toBe(1);
    expect(piped.pushed).toEqual(serial.pushed);
    expect(serial.r.session.phase).toBe('cleared');
    expect(piped.r.session.score).toEqual(serial.r.session.score);
    expect(piped.r.steps).toBe(serial.r.steps + 1);
    expect(await plain(inputsOf(serial.r, serial.pushed), serial.r.steps)).toBe(snapshotHash(serial.r.snapshot));
    expect(await plain(inputsOf(piped.r, piped.pushed), piped.r.steps)).toBe(snapshotHash(piped.r.snapshot));
  });

  it('numbers a later shot\'s ammo past the bodies the hook spawned, so the rules watch the right body', async () => {
    // A marble fired wide of the tower settles without a crown down; the par shot then clears.
    const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
    const { r, pushed } = await play([miss, ...par], false);
    expect(r.session.strokes).toBe(2);
    expect(r.session.phase).toBe('cleared');
    // Ammo 1 is body n, the hook's block n + 1, ammo 2 n + 2 (and its block n + 3).
    expect(r.feedback.filter((f) => f.t === 'fired').map((f) => (f as { body: number }).body)).toEqual([n, n + 2]);
    expect(pushed.length).toBe(2);
    expect(r.snapshot.count).toBe(n + 4);
    expect(await plain(inputsOf(r, pushed), r.steps)).toBe(snapshotHash(r.snapshot));
  });

  it('refuses input for a step already observed, which a pipelined driver could not apply in time', async () => {
    const d = new Driver(new RapierEngine(), c, { pipelined: true });
    await d.reset();
    d.fire(par[0]!);
    await d.step();
    expect(() => d.push([{ step: d.snapshotStep, kind: 'spawn', body: block(3) }])).toThrow(/not after the observed step/);
    d.push([{ step: d.snapshotStep + 1, kind: 'spawn', body: block(3) }]);
    expect(d.pushed.length).toBe(1);
    d.engine.dispose();
  });
});

// Rapid fire on a real engine: a shot with `after` goes in that many steps
// after the one before, cutting it, on a serial and a pipelined driver alike.
// The recorded line replays to the same state, and a line without `after`
// plays exactly as before.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, type Feedback, L1, type LaunchShot, PRESETTLE_STEPS, readShots, runSession, type SessionResult, type Shot, shotToSpawn, snapshotHash, writeShots } from '@tb/keystone';

const c = compileLevel(L1);
const par = L1.solutions!.par![0]! as Shot;
/** The par shot, then a second cannonball down the same line 20 steps later, into the falling tower. */
const volley: Shot[] = [par, { ...par, after: 20 }];

const play = (shots: Shot[], pipelined = false) => runSession(new RapierEngine(), c, shots, { pipelined });
const kinds = (fb: Feedback[]) => fb.map((f) => f.t).filter((t) => t === 'fired' || t === 'cut' || t === 'settled' || t === 'levelEnd');

/** A plain engine fed the session's shots at the steps they went in, stepped as far: the same state. */
async function plainHash(r: SessionResult) {
  const e = new RapierEngine();
  await e.init({ ...c.scene, inputs: r.session.inputs.map(({ step, shot }) => shotToSpawn(c.frame, shot, step)) });
  while (e.stepIndex < r.steps) e.step();
  const h = snapshotHash(e.snapshot());
  e.dispose();
  return h;
}

describe('rapid fire (Shot.after)', () => {
  it('fires `after` steps after the shot before, cutting it; per-shot dPE telescopes exactly', async () => {
    const r = await play(volley);
    expect(r.session.inputs.map((i) => i.step)).toEqual([PRESETTLE_STEPS, PRESETTLE_STEPS + 20]);
    expect(r.session.inputs[1]!.shot.after).toBe(20);
    expect(kinds(r.feedback)).toEqual(['fired', 'cut', 'fired', 'settled', 'levelEnd']);
    const [a, b] = r.session.outcomes;
    expect(a).toMatchObject({ cut: true, spawnStep: PRESETTLE_STEPS, settleStep: PRESETTLE_STEPS + 20 });
    expect(b!.cut).toBeUndefined();
    // The second shot's baseline is the state the first was cut on (potentials are whole mJ: exact).
    expect(b!.dPE_mJ).toBe(a!.pe_mJ - b!.pe_mJ);
    expect(r.session.phase).toBe('cleared');
    expect(r.session.strokes).toBe(2);
    expect(snapshotHash(r.snapshot)).toBe(await plainHash(r));
  });

  it('a pipelined driver fires the rapid shot at the same engine step and matches a plain engine', async () => {
    const serial = await play(volley), piped = await play(volley, true);
    expect(piped.session.inputs).toEqual(serial.session.inputs);
    expect(snapshotHash(piped.snapshot)).toBe(await plainHash(piped));
    // Cut on the state one step behind the engine (what the rules had seen), so it reports the step before.
    expect(piped.session.outcomes[0]!.settleStep).toBe(PRESETTLE_STEPS + 19);
  });

  it('the recorded line, as text, replays to the same state, steps and score', async () => {
    const r = await play(volley);
    const text = writeShots(r.session.inputs.map((i) => i.shot));
    expect(text).toMatch(/@20$/);
    const again = await play(readShots(text));
    expect(again.steps).toBe(r.steps);
    expect(snapshotHash(again.snapshot)).toBe(snapshotHash(r.snapshot));
    expect(again.session.outcomes).toEqual(r.session.outcomes);
    expect(again.session.score).toEqual(r.session.score);
  });

  it('a rapid shot whose `after` outlasts the shot before fires when it settles, as a line without `after`', async () => {
    // L1 clears on the par shot, so add a level end that needs both: the marble line from aiming.
    const late: Shot[] = [{ ...(par as LaunchShot), ammo: 'marble', power: 0 }, { ...par, after: 100_000 }];
    const waited = await play(late), plain = await play(late.map(({ after: _, ...s }) => s as Shot));
    expect(waited.session.inputs).toEqual(plain.session.inputs);
    expect(waited.session.inputs[1]!.shot.after).toBeUndefined();
    expect(waited.session.outcomes.some((o) => o.cut)).toBe(false);
    expect(snapshotHash(waited.snapshot)).toBe(snapshotHash(plain.snapshot));
  });
});

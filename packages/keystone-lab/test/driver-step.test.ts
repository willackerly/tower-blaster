// Driver.snapshotStep: the step each observed snapshot is of, which a per-step
// hook (the viewer's dev panels, the weapons runtime) needs to schedule input
// on a serial and a pipelined driver alike.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { BodyDesc, InputEvent } from '@tb/engine-api';
import { compileLevel, Driver, L1, PRESETTLE_STEPS, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';

const c = compileLevel(L1), shot = L1.solutions!.par![0]! as Shot;
/** A block dropped beside the tower: input a hook might push after seeing a snapshot. */
const block: BodyDesc = { ...c.scene.bodies[0]!, pos: [3, 6, 3], linVel: [0, 0, 0], angVel: [0, 0, 0] };

/**
 * Fire L1's par shot and play it out, after `pushAt` observed steps pushing the block for step snapshotStep + 1
 * (or never); every observed snapshot's step and hash, checked as they come.
 */
async function play(pipelined: boolean, pushAt = -1) {
  const d = new Driver(new RapierEngine(), c, { pipelined });
  await d.reset();
  expect(d.snapshotStep).toBe(PRESETTLE_STEPS);
  d.fire(shot);
  const seen: Array<[number, string]> = [];
  let pushed: InputEvent | null = null;
  while (d.session.phase === 'running') {
    await d.step();
    // Pipelined, the engine is one step ahead of what the rules saw, until the drain at the end.
    expect(d.snapshotStep, `pipelined ${pipelined}`).toBe(pipelined && d.session.phase === 'running' ? d.engine.stepIndex - 1 : d.engine.stepIndex);
    seen.push([d.snapshotStep, snapshotHash(d.snapshot)]);
    if (seen.length === pushAt) d.engine.push([pushed = { step: d.snapshotStep + 1, kind: 'spawn', body: block }]);
  }
  d.engine.dispose();
  return { seen, pushed, phase: d.session.phase };
}

/** Each observed snapshot equals a plain engine's, fed the same inputs, at that step. */
async function expectPlain(seen: Array<[number, string]>, inputs: InputEvent[], label: string) {
  const e = new RapierEngine();
  await e.init({ ...c.scene, inputs });
  for (const [step, hash] of seen) {
    while (e.stepIndex < step) e.step();
    expect(snapshotHash(e.snapshot()), `${label}, step ${step}`).toBe(hash);
  }
  e.dispose();
}

describe('Driver.snapshotStep', () => {
  it('names the step every snapshot holds, serial and pipelined, checked against a plain engine at that step', async () => {
    for (const pipelined of [false, true]) {
      const { seen, phase } = await play(pipelined);
      expect(phase).toBe('cleared');
      expect(seen[0]![0]).toBe(PRESETTLE_STEPS + 1);
      await expectPlain(seen, [shotToSpawn(c.frame, shot, PRESETTLE_STEPS)], `pipelined ${pipelined}`);
    }
  });

  it('input pushed for snapshotStep + 1 after a snapshot is seen lands at the same engine step serial and pipelined', async () => {
    const serial = await play(false, 10), piped = await play(true, 10);
    expect(serial.pushed).toEqual(piped.pushed);
    expect(serial.pushed!.step).toBe(PRESETTLE_STEPS + 11);
    // Both match one plain engine with the block in its inputs at that step, so they agree step for step.
    const inputs = [shotToSpawn(c.frame, shot, PRESETTLE_STEPS), serial.pushed!];
    await expectPlain(serial.seen, inputs, 'serial');
    await expectPlain(piped.seen, inputs, 'pipelined');
    const bySerial = new Map(serial.seen);
    for (const [step, hash] of piped.seen) if (bySerial.has(step)) expect(hash, `step ${step}`).toBe(bySerial.get(step));
  });
});

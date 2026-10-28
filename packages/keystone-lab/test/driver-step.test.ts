// Driver.snapshotStep: the step each observed snapshot is of, which a per-step
// hook (the viewer's dev panels, the weapons runtime) needs to schedule input
// at the same engine step on a serial and a pipelined driver.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, Driver, L1, PRESETTLE_STEPS, type Shot, shotToSpawn, snapshotHash } from '@tb/keystone';

describe('Driver.snapshotStep', () => {
  it('names the step every snapshot holds, serial and pipelined, checked against a plain engine at that step', async () => {
    const c = compileLevel(L1), shot = L1.solutions!.par![0]! as Shot;
    for (const pipelined of [false, true]) {
      const d = new Driver(new RapierEngine(), c, { pipelined });
      await d.reset();
      expect(d.snapshotStep).toBe(PRESETTLE_STEPS);
      d.fire(shot);
      const seen: Array<[number, string]> = [];
      while (d.session.phase === 'running') {
        await d.step();
        // Pipelined, the engine is one step ahead of what the rules saw, until the drain at the end.
        expect(d.snapshotStep, `pipelined ${pipelined}`).toBe(pipelined && d.session.phase === 'running' ? d.engine.stepIndex - 1 : d.engine.stepIndex);
        seen.push([d.snapshotStep, snapshotHash(d.snapshot)]);
      }
      expect(d.session.phase).toBe('cleared');
      expect(seen[0]![0]).toBe(PRESETTLE_STEPS + 1);
      // The world on a plain engine fed the same spawn, at each of those steps.
      const e = new RapierEngine();
      await e.init({ ...c.scene, inputs: [shotToSpawn(c.frame, shot, PRESETTLE_STEPS)] });
      for (const [step, hash] of seen) {
        while (e.stepIndex < step) e.step();
        expect(snapshotHash(e.snapshot()), `pipelined ${pipelined}, step ${step}`).toBe(hash);
      }
      e.dispose();
      d.engine.dispose();
    }
  });
});

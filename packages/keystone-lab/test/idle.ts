// Shared by the keystone sim tests (sim.test.ts, sim-lean.test.ts): the two
// engines the levels are checked on, the pre-settle, and an idle run after it.
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { engineLabel, makeEngine } from '@tb/keystone-lab';
import { compileLevel, type LevelDef, PRESETTLE_STEPS, QUIET_SPEED, QUIET_SPIN } from '@tb/keystone';

export const ENGINES = [
  ['Rapier', () => new RapierEngine()],
  [`AVBD (reference, ${engineLabel({ kind: 'ref' })})`, () => makeEngine({ kind: 'ref' })],
] as const;

/** Init and run the pre-settle, counting the quiet steps (as the rules define quiet) at its end. */
export async function presettle(e: PhysicsEngine, def: LevelDef) {
  const c = compileLevel(def);
  await e.init(c.scene);
  let run = 0;
  for (let t = 0; t < PRESETTLE_STEPS; t++) {
    await e.step();
    const s = await e.snapshot();
    let v = 0, w = 0;
    for (let i = 0; i < c.meta.n; i++) if (s.awake[i]) {
      v = Math.max(v, Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!));
      w = Math.max(w, Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!));
    }
    run = v < QUIET_SPEED && w < QUIET_SPIN ? run + 1 : 0;
  }
  return { c, run, settled: await e.snapshot() };
}

/** Run the pre-settle, then `steps` more; the worst vertical and sideways move of any body since the pre-settle. */
export async function idle(make: () => PhysicsEngine, def: LevelDef, steps: number) {
  const e = make();
  const { c, settled } = await presettle(e, def);
  let up = 0, side = 0;
  for (let t = 0; t < steps; t++) {
    await e.step();
    const p = (await e.snapshot()).pos, q = settled.pos;
    for (let i = 0; i < c.meta.n; i++) {
      up = Math.max(up, Math.abs(p[3 * i + 1]! - q[3 * i + 1]!));
      side = Math.max(side, Math.hypot(p[3 * i]! - q[3 * i]!, p[3 * i + 2]! - q[3 * i + 2]!));
    }
  }
  e.dispose();
  return { up, side };
}

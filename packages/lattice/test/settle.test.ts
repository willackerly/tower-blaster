import { describe, expect, it } from 'vitest';
import type { SceneDesc } from '@tb/engine-api';
import { RapierHost } from '@tb/adapter-rapier';
import { quatFromAxisAngle } from '@tb/geom';
import { buildScenario } from '@tb/scenarios';
import { checkTiers, TIER_LATTICE, TieredEngine } from '../src/index.ts';

async function steps(e: TieredEngine, n: number, penTol?: number) {
  for (let s = 0; s < n; s++) { await e.step(); const p = await checkTiers(e, penTol); if (p.length) throw new Error(`step ${e.stepIndex}: ${p.join('; ')}`); }
}

describe('settling back into the lattice', () => {
  it('cubes woken without being disturbed go back, bottom-up, at their exact poses', async () => {
    const scene = buildScenario('S1', { F: 2, H: 6 }, 1);
    const e = new TieredEngine(new RapierHost(), { settle: true });
    await e.init(scene);
    e.wakeSphere([0, 3, 0], 1.5); // a band and everything above it
    await steps(e, 1);
    const woken = e.stats.active;
    expect(woken).toBeGreaterThan(8);
    await steps(e, 59); // minActiveSteps
    expect(e.stats.active).toBe(woken); // hysteresis: not before 60 steps active
    await steps(e, 40);
    expect(e.stats.active).toBe(0);
    expect(e.stats.total.settled).toBe(woken);
    const s = await e.snapshot();
    scene.bodies.forEach((b, id) => expect(Math.hypot(s.pos[3 * id]! - b.pos[0], s.pos[3 * id + 1]! - b.pos[1], s.pos[3 * id + 2]! - b.pos[2])).toBeLessThan(1e-9));
    e.dispose();
  });

  it('by default does not settle into Rapier voxels (any voxel change jolts all their contacts); woken cubes freeze in place instead', async () => {
    const scene = buildScenario('S1', { F: 2, H: 6 }, 1);
    const e = new TieredEngine(new RapierHost());
    await e.init(scene);
    e.wakeSphere([0, 3, 0], 1.5);
    await steps(e, 100);
    expect(e.stats.total.settled).toBe(0);
    expect(e.stats.active).toBe(0);
    expect(e.stats.rubble).toBeGreaterThan(8);
    e.dispose();
  });

  it('a cube dropped square onto a column joins it; a tilted one comes to rest as rubble', async () => {
    for (const tilt of [0, 0.2]) {
      const scene: SceneDesc = buildScenario('S1', { F: 1, H: 3 }, 1);
      scene.bodies.push({ ...scene.bodies[0]!, pos: [0, 5.5, 0], rot: quatFromAxisAngle([0, 0, 1], tilt) });
      // Tilted, it bounces off sideways and wakes the column (Rapier settles nothing by default, see TierParams.settle).
      const e = new TieredEngine(new RapierHost(), tilt === 0 ? { settle: true } : {});
      await e.init(scene);
      await steps(e, 240, 0.1); // a 2 m drop onto a cube penetrates about 0.07 for a step in Rapier
      if (tilt === 0) expect(e.tier[3]).toBe(TIER_LATTICE);
      else {
        expect(e.stats.active).toBe(0);
        expect(e.supporters.get(3)).toEqual([2]); // the cube under it, frozen too
        expect(e.supporters.get(0)).toEqual([]); // on the ground
      }
      e.dispose();
    }
  });

  it('after a ball shot re-settling backs off geometrically, so no cube thrashes between tiers', async () => {
    // Rubble keeps landing on and leaning against settled ground cubes, so
    // some do wake again. Each settle doubles the steps a cube must stay active
    // before the next (minActiveSteps * 2^settles), which bounds transitions
    // per cube to O(log steps): at most 3 settles, 7 transitions in 600 steps.
    const scene = buildScenario('S5', { N: 1024, F: 4, H: 16, radius: 1, speed: 20, fireStep: 2 }, 1);
    const e = new TieredEngine(new RapierHost(), { settle: true, rubble: false }); // rubble churn is bounded separately
    const log: Array<Array<{ step: number; cause: string }>> = scene.bodies.map(() => []);
    e.onTransition = (id, _to, cause, step) => log[id]?.push({ step, cause });
    await e.init(scene);
    const T = 600, { minActiveSteps } = e.p;
    for (let s = 0; s < T; s++) {
      await e.step();
      if (s % 20 === 0) expect(await checkTiers(e)).toEqual([]);
    }
    let maxSettles = 0;
    while (minActiveSteps * (2 ** (maxSettles + 1) - 1) <= T) maxSettles++;
    let settled = 0;
    for (const events of log) {
      let since = -1, k = 0;
      for (const ev of events) {
        if (ev.cause !== 'settle') { since = ev.step; continue; }
        expect(ev.step - since).toBeGreaterThanOrEqual(minActiveSteps * 2 ** k++);
        settled++;
      }
      expect(k).toBeLessThanOrEqual(maxSettles);
      expect(events.length).toBeLessThanOrEqual(2 * maxSettles + 1);
    }
    expect(maxSettles).toBe(3);
    expect(settled).toBe(e.stats.total.settled);
    expect(settled).toBeGreaterThan(50);
    e.dispose();
  });
});

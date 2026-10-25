import { describe, expect, it } from 'vitest';
import type { BodyDesc, Vec3 } from '@tb/engine-api';
import { buildScenario } from '@tb/scenarios';
import { checkTiers, TieredEngine } from '../src/index.ts';
import { ScriptedHost } from './scripted-host.ts';

describe('checkTiers overlap invariant (d)', () => {
  it('reports a body inside a dormant cell, beyond penTol plus one step of its travel toward it', async () => {
    // A ball of radius 0.5 at x = 0.7 overlaps the cube at the origin by 0.3 edges.
    for (const [vx, ok] of [[0, false], [-10, false], [-30, true], [30, false]] as const) {
      const s = buildScenario('S1', { F: 1, H: 1 }, 1);
      s.bodies.push({ ...s.bodies[0]!, shape: { kind: 'sphere', radius: 0.5 }, pos: [0.7, 0.5, 0] } satisfies BodyDesc);
      const host = new ScriptedHost();
      const e = new TieredEngine(host, { rubble: false });
      await e.init(s);
      host.vel.set(1, [vx, 0, 0] as Vec3);
      const p = await checkTiers(e);
      // 30 m/s toward the cell travels 0.5 in a step: 0.3 is within it; 10 m/s (0.17) or moving away is not.
      expect(p.some((m) => m.includes('overlaps dormant cell')), `${vx} m/s`).toBe(!ok);
    }
  });
});

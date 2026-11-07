// Mason's Trial's engine (M8, docs/game/masons-trial.md): every Mason level plays at 40
// iterations whatever asks otherwise (a URL override, a level's physics block, a quality
// tier), and the judge's engine holds every world's structure and probes with one world's
// pair room (islands never touch).
import { describe, expect, it } from 'vitest';
import { compileLevel, MASON_ITERATIONS, MASON_LEVELS, masonCapacity, MT1 } from '@tb/keystone';
import { everyPairPerBody } from '@tb/physics-gpu';
import { gpuParams, makeEngine, makeMasonEngine, masonGpuOptions } from '../src/engines.ts';
import { levelRules, withRules } from '../src/params.ts';
import { QUALITY_TIERS, TIER_KNOBS } from '../src/quality.ts';

describe("Mason's Trial's engine", () => {
  it('plays at 40 iterations under any ?keystone.iterations, on the level engine and the judge engine', () => {
    for (const def of MASON_LEVELS) {
      for (const q of ['', 'keystone.iterations=1', 'keystone.iterations=12', 'keystone.iterations=200']) {
        const played = withRules(def, levelRules(new URLSearchParams(q))), c = compileLevel(played);
        expect(gpuParams(c).iterations, `${def.id} ${q}`).toBe(MASON_ITERATIONS);
        expect(makeEngine('gpu', c).info.variant).toMatchObject({ iterations: 40 });
        expect(makeMasonEngine('gpu', c, 64).info.variant).toMatchObject({ iterations: 40 });
      }
    }
  });

  it('a quality tier holds no physics knob, so no tier can lower the iterations', () => {
    // Every tier's knobs are drawing knobs only. A physics knob added here must keep Mason levels at 40 (and this list changes).
    for (const t of QUALITY_TIERS) expect(Object.keys(TIER_KNOBS[t]).sort(), t).toEqual(['ao', 'frames', 'maxDpr', 'shadow', 'sparks']);
  });

  it("the judge's engine: room for every world's bodies and probes, the probes' reach, one world's pairs", () => {
    const c = compileLevel(MT1), o = masonGpuOptions(c, 64);
    expect(o.capacity).toBe(masonCapacity(c, 64));
    expect(o.capacity).toBe(64 * (c.scene.bodies.length + MT1.mason!.probes.length));
    expect(o.maxRadius).toBeCloseTo(0.45 * c.frame.unit, 12);
    expect(o.pairsPerBody).toBe(everyPairPerBody(masonCapacity(c, 1)));
    expect(makeMasonEngine('rapier', c, 64).info.name).toBe('rapier');
  });
});

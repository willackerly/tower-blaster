// Every level stands at load on the GPU solver, the game's engine (the agent playtest's PT11; the suite and its
// rule are level-stability-gpu.ts). Every level runs on a real GPU (TB_CHANNEL=chrome on Metal) or with
// PHYSICS_GPU_SLOW=1; CI runs the doorway here (T-X4: the playtest found the old arch breaking on the GPU solver
// and not on Rapier) and the promoted trial over the reference test's 160 bodies in level-stability-gpu-X3B.test.ts.
// The reference's check is level-stability.test.ts and Rapier's level-stability-rapier.test.ts; the big levels'
// longer rest (600 steps, top drop) is big-levels-gpu.test.ts.
import { expect, it } from 'vitest';
import { ALL, gpuStabilitySuite, LEVELS_ALL } from './level-stability-gpu.ts';

/** The levels CI runs on SwiftShader, one to a file. */
const CI_LEVELS = ['T-X4', 'T-X3B'];

gpuStabilitySuite(ALL ? null : ['T-X4'], () => {
  it('names the levels left to a real GPU here', () => {
    const left = ALL ? [] : LEVELS_ALL.filter((l) => !CI_LEVELS.includes(l.def.id)).map((l) => `${l.def.id} (${l.c.meta.n})`);
    if (left.length) console.log(`at load on the GPU solver with TB_CHANNEL=chrome or PHYSICS_GPU_SLOW=1 only: ${left.join(', ')}`);
    expect(LEVELS_ALL.length - left.length).toBe(ALL ? LEVELS_ALL.length : CI_LEVELS.length);
    expect(LEVELS_ALL.filter((l) => CI_LEVELS.includes(l.def.id))).toHaveLength(CI_LEVELS.length);
  });
});

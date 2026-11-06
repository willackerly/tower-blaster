// Every level stands at load on the GPU solver, the game's engine (the agent playtest's PT11): on the game's cast
// page exactly as the game builds it, its pre-settle moves no body half a cell from where the level put it, and
// the 300 steps after move none 0.1 m, with no engine limit hit. SwiftShader takes about 70 ms a step on a small
// level (14 levels of up to 200 bodies took 560 s here; T-X2 92 s, T-X3B 68 s, T-X4 108 s), so CI runs CI_LEVELS:
// the doorway (T-X4; the playtest found the old arch breaking on the GPU solver and not on Rapier) and the
// promoted trial over the reference test's 160 bodies (T-X3B). Every level runs on a real GPU (TB_CHANNEL=chrome on Metal)
// or with PHYSICS_GPU_SLOW=1. The reference's check is level-stability.test.ts and Rapier's
// level-stability-rapier.test.ts; the big levels' longer rest (600 steps, top drop) is big-levels-gpu.test.ts.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, SERIES } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';
import { REST_BOUND_M } from '../src/index.ts';

const MINUTES = 60_000;
const channel = process.env.TB_CHANNEL;
const ALL = Boolean(channel) || process.env.PHYSICS_GPU_SLOW === '1';
/** The levels CI runs on SwiftShader (above). */
const CI_LEVELS = ['T-X3B', 'T-X4'];
const STEPS = 300;
const levels = SERIES.flat().map((def) => ({ def, c: compileLevel(def) }));

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(channel ? { channel } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('every level stands at load on the GPU solver', () => {
  for (const { def, c } of levels.filter((l) => ALL || CI_LEVELS.includes(l.def.id))) it(`${def.id} (${c.meta.n} bodies)`, async (ctx) => {
    if (!player) return ctx.skip();
    const r = await player.rest(def, STEPS), h = c.frame.unit;
    console.log(`${def.id} at load on ${player.adapter}: pre-settle max ${(r.settle.maxMove * h).toFixed(3)} m (${r.settle.fell} fell), then ${(r.maxMove * h).toFixed(4)} m over ${STEPS} steps, ${(r.ms / 1000).toFixed(0)} s`);
    expect(r.limits).toEqual([]);
    expect(r.settle.fell, `bodies that fell in the pre-settle (most moved ${(r.settle.maxMove * h).toFixed(3)} m)`).toBe(0);
    expect(r.maxMove * h).toBeLessThan(REST_BOUND_M);
  }, 30 * MINUTES);
  it('names the levels left to a real GPU here', () => {
    const left = ALL ? [] : levels.filter((l) => !CI_LEVELS.includes(l.def.id)).map((l) => `${l.def.id} (${l.c.meta.n})`);
    if (left.length) console.log(`at load on the GPU solver with TB_CHANNEL=chrome or PHYSICS_GPU_SLOW=1 only: ${left.join(', ')}`);
    expect(levels.length - left.length).toBe(ALL ? levels.length : CI_LEVELS.length);
  });
});

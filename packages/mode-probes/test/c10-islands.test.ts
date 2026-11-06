// C10, many worlds in one solve, through the primitive (engine-api islands.ts):
// the packed scene is exactly the solo worlds translated, with every shot
// released under its global id (CPU), and on the GPU engine at game settings
// (SwiftShader, CI size: 8 worlds) the islands' outcomes match the solo runs',
// no body leaves its cell, and the per-island observer counts equal each
// world's own snapshot counts. The full verify (64 worlds of 150 bodies, and
// the cost per body against the 9.6k block on Metal) runs with
// pnpm probe:modes C10.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_ISLAND_REACH } from '@tb/engine-api';
import { requireWebGPU } from '@tb/testkit';
import { probeById } from '../src/index.ts';
import { C10, type C10Case, c10Islands, c10Spec, c10World, type C10Result } from '../src/c10-islands.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const full = (arm: C10Case['arm'], world = -1): C10Case => ({ arm, level: { W: 5, D: 5, H: 6 }, K: 64, world, presettle: 300, readAfter: 240 });

describe('C10 scenes', () => {
  it('the islands scene is the 64 solo worlds at their offsets, island 0 at the origin, each shot under its own global id', () => {
    const c = full('islands'), isl = c10Islands(c), scene = c10Spec(c).scene;
    expect({ ...isl.pack(), id: scene.id }).toEqual(scene);
    expect(scene.bodies).toHaveLength(64 * 150);
    expect(scene.inputs).toHaveLength(64);
    // X8's world reaches 3 m in front of the block plus the ball: the gap is 2 (extent + reach), whole metres,
    // and its cell holds the 21 m X8 measured for the wrecking ball's debris.
    expect(isl.gap).toBe(Math.ceil(2 * (isl.extent + DEFAULT_ISLAND_REACH)));
    expect(isl.half).toBeGreaterThan(25);
    expect(isl.offsets[0]).toEqual([0, 0, 0]);
    for (const k of [0, 1, 37, 63]) {
      const solo = c10World(c, k), o = isl.offsets[k]!;
      const mine = scene.bodies.slice(150 * k, 150 * k + 150);
      mine.forEach((b, i) => {
        expect(b.pos).toEqual([solo.bodies[i]!.pos[0] + o[0], solo.bodies[i]!.pos[1] + o[1], solo.bodies[i]!.pos[2] + o[2]]);
        expect(b.rot).toEqual(solo.bodies[i]!.rot);
      });
      // Every shot is released at the same step, island by island, so world k's ball is body 9600 + k.
      const shot = scene.inputs[k]!, local = solo.inputs[0]!;
      expect(shot.step).toBe(local.step);
      expect(isl.idOf(k, 150)).toBe(9600 + k);
      if (shot.kind !== 'spawn' || local.kind !== 'spawn') throw new Error('shots are spawns');
      expect(shot.body.pos).toEqual([local.body.pos[0] + o[0], local.body.pos[1], local.body.pos[2] + o[2]]);
    }
    // Island 0's bodies are solo world 0's, at the same coordinates.
    expect(scene.bodies.slice(0, 150)).toEqual(c10World(c, 0).bodies);
    expect(probeById('C10')).toBe(C10);
    expect(C10.cases('full')).toHaveLength(1 + 64 + 1);
    expect(C10.cases('ci')).toHaveLength(1 + 8);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('C10 on the GPU engine at game settings (CI size)', () => {
  it('8 packed worlds match 8 solo runs, stay in their cells, and the per-island counts equal the snapshot\'s', { timeout: 300_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, C10, 'ci', { log: (l) => console.log(l) });
    console.log([...run.verdict.table, ...run.verdict.checks.map((c) => `${c.pass ? 'pass' : 'FAIL'}: ${c.name} (${c.detail})`)].join('\n'));
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    expect(run.verdict.checks.filter((c) => !c.pass)).toEqual([]);
    const isl = run.runs.find((r) => (r.c as C10Case).arm === 'islands')!.result as C10Result;
    expect(isl.worlds).toHaveLength(8);
    // The shot did something in every world, and the observer read exactly the 8 balls as having no pre-shot pose.
    for (const w of isl.worlds) expect(w.moved, `world ${w.world}`).toBeGreaterThan(0);
    expect(isl.invalid).toBe(8);
  });
});

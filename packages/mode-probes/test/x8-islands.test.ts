// X8, islands behave like solo worlds: the islands scene is exactly the solo
// worlds placed on a grid (CPU: same bodies and shots, translated; islands far
// enough apart that a world's debris cannot reach the next), and at CI size on
// the GPU engine (SwiftShader) the islands' outcomes match the solo runs'.
// Not bit for bit: the islands share the colouring, so each ends a little
// apart from the same world run alone (reported in the table).
// The full probe (64 islands of 150 bodies, and the 9.6k-block timing on
// Metal) runs with pnpm probe:modes X8.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireWebGPU } from '@tb/testkit';
import { probeById } from '../src/index.ts';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { ISLAND_GAP, islandOffset, SHOT_NAME, X8, type X8Case, type X8Result, x8World } from '../src/x8-islands.ts';
import { openProbePage, type ProbePage, runProbe } from '../src/session.ts';

const level = { W: 5, D: 5, H: 6 };
const at = (arm: X8Case['arm'], world = -1): X8Case => ({ arm, level, K: 64, world, presettle: 300, readAfter: 240 });

describe('X8 worlds', () => {
  it('64 island offsets: an 8 x 8 grid ISLAND_GAP apart, centred on the origin', () => {
    const offs = Array.from({ length: 64 }, (_, k) => islandOffset(k, 64));
    expect(new Set(offs.map((o) => o.join())).size).toBe(64);
    expect(offs.reduce((a, o) => a + o[0], 0)).toBeCloseTo(0, 9);
    expect(offs.reduce((a, o) => a + o[2], 0)).toBeCloseTo(0, 9);
    expect(Math.max(...offs.map((o) => Math.abs(o[0])))).toBeCloseTo(3.5 * ISLAND_GAP, 9);
  });

  it('the islands scene is the solo-far worlds concatenated, and each solo world is its island moved to the origin', () => {
    const isl = x8World(at('islands'));
    expect(isl.bodies).toHaveLength(64 * 150);
    expect(isl.inputs).toHaveLength(64);
    for (const k of [0, 17, 63]) {
      const far = x8World(at('solo-far', k)), solo = x8World(at('solo', k)), o = islandOffset(k, 64), first = isl.firsts[k]!;
      expect(isl.bodies.slice(first, first + 150)).toEqual(far.bodies);
      expect(isl.inputs[k]).toEqual(far.inputs[0]);
      solo.bodies.forEach((b, i) => {
        const f = far.bodies[i]!;
        expect(b.pos[0] + o[0]).toBeCloseTo(f.pos[0], 9); expect(b.pos[1]).toBe(f.pos[1]); expect(b.pos[2] + o[2]).toBeCloseTo(f.pos[2], 9);
        expect(b.rot).toEqual(f.rot);
      });
    }
    // A world spans about 3 m; the wrecking ball starts 3 m out, and its debris ends within 21 m (SwiftShader, 16 worlds),
    // inside half the gap (the verdict checks it per world).
    const xs = x8World(at('solo', 0)).bodies.map((b) => b.pos[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(3);
    expect(ISLAND_GAP / 2).toBeGreaterThan(21 + 3);
    const shot = x8World(at('solo', 0)).inputs[0]!;
    expect(shot.kind === 'spawn' && (shot.body.shape as { radius: number }).radius).toBe(PROJECTILE_PRESETS[SHOT_NAME].diameter / 2);
    expect(probeById('X8')).toBe(X8);
    expect(X8.cases('full')).toHaveLength(1 + 2 * 64 + 1);
  });
});

let page: ProbePage | null = null;
beforeAll(async () => {
  try { page = await openProbePage(); } catch (e) { if (requireWebGPU()) throw e; }
  if (!page && requireWebGPU()) throw new Error('no WebGPU adapter');
}, 120_000);
afterAll(async () => { await page?.close(); });

describe('X8 on the GPU engine at game settings (CI size)', () => {
  // About 265 s on a CI runner (median of three main runs), 300 s and over on a slow one (main 2bbff1c), so the case
  // gets twice that; the file stays under the 300 s CI budget on its recorded time.
  it('the islands\' outcome distributions match the solo runs\', and the shot moves every world', { timeout: 600_000 }, async (ctx) => {
    if (!page) return ctx.skip();
    const run = await runProbe(page, X8, 'ci', { log: (l) => console.log(l) });
    console.log(run.verdict.table.join('\n'));
    for (const r of run.runs) expect(r.error, r.label).toBeNull();
    expect(run.verdict.checks.filter((c) => !c.pass)).toEqual([]);
    const isl = run.runs.find((r) => (r.c as X8Case).arm === 'islands')!.result as X8Result;
    // The shot did something in every world.
    for (const o of isl.outcomes) expect(o.moved, `world ${o.world}`).toBeGreaterThan(0);
  });
});

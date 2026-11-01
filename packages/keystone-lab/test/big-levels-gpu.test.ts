// The big levels at rest on the GPU solver (roadmap G5): each loads on the
// game's cast page exactly as the game builds it, pre-settles, then stands
// with nothing fired: no structure body moves 0.05 h, the top does not sink
// 0.05 h, and no engine limit is hit. CI runs the levels SwiftShader can load
// in a test file's budget (BIG_REST_MAX bodies: B1's 1,000 at about 0.35 to
// 0.47 s a step: 300 pre-settle plus 150 steps took 198 s here) for
// REST_STEPS (default 100 on SwiftShader; the spec's 600 with TB_CHANNEL=chrome on Metal,
// where every big level runs). A cast level's showcase line (solutions.ace, its
// cast's best line) replays and meets the objective with no limit hit, on a real
// GPU or with PHYSICS_GPU_SLOW=1 only: a 3-shot line on B1 is about 1,800 steps,
// some 12 min on SwiftShader (spectacle-mode.md section 11, G5.2).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BIG_LEVELS, castStars, compileLevel, writeShots } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
const channel = process.env.TB_CHANNEL;
/** Largest level loaded on SwiftShader; every level on a real GPU (TB_CHANNEL) or with PHYSICS_GPU_SLOW=1. */
const BIG_REST_MAX = channel || process.env.PHYSICS_GPU_SLOW === '1' ? Infinity : 1000;
/** Showcase lines replay on a real GPU or with PHYSICS_GPU_SLOW=1. */
const SHOWCASE = Boolean(channel) || process.env.PHYSICS_GPU_SLOW === '1';
const REST_STEPS = Number(process.env.REST_STEPS ?? (channel ? 600 : 100));
/** The rest bound in cells (h): the spec's for the big levels. */
const BOUND = 0.05;

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(channel ? { channel } : {}) });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('big levels at rest on the GPU solver', () => {
  const sized = BIG_LEVELS.map((def) => ({ def, n: compileLevel(def).meta.n }));
  for (const { def, n } of sized.filter((l) => l.n <= BIG_REST_MAX)) it(`${def.id} (${n} bodies) stands after its pre-settle with no limit hit`, async (ctx) => {
    if (!player) return ctx.skip();
    const id = def.id;
    const r = await player.rest(def, REST_STEPS);
    console.log(`${id} at rest on ${player.adapter}: ${r.presettle} + ${r.steps} steps, max move ${r.maxMove.toFixed(4)} h, top drop ${r.topDrop.toFixed(4)} h, ${(r.ms / 1000).toFixed(0)} s${player.software ? ' (software adapter: not a performance result)' : ''}`);
    expect(r.limits).toEqual([]);
    expect(r.maxMove).toBeLessThan(BOUND);
    expect(Math.abs(r.topDrop)).toBeLessThan(BOUND);
  }, 30 * MINUTES);
  for (const { def } of sized.filter((l) => l.def.solutions?.ace && castStars(compileLevel(l.def)))) it.runIf(SHOWCASE)(`${def.id}'s showcase line meets the objective with no limit hit`, async (ctx) => {
    if (!player) return ctx.skip();
    const line = def.solutions!.ace!, [p] = await player.play(def, [line]);
    const end = p!.samples.at(-1)!, stars = def.stars!;
    console.log(`${def.id} showcase ${writeShots(line)} on ${player.adapter}: collapse ${end.collapse.toFixed(4)} after ${p!.samples.length} settles, ${p!.steps} steps (stars ${stars.t2} / ${stars.t3}, cast on ${stars.castOn})`);
    expect(p!.limits).toEqual([]);
    expect(p!.complete).toBe(true);
    expect(p!.samples.length).toBe(line.length);
    expect(end.met).toBe(true);
  }, 30 * MINUTES);
  it('every big level is either checked here or named as too big for this adapter', () => {
    const skipped = sized.filter((l) => l.n > BIG_REST_MAX).map((l) => `${l.def.id} (${l.n})`);
    if (skipped.length) console.log(`at rest on a real GPU only (TB_CHANNEL=chrome or PHYSICS_GPU_SLOW=1): ${skipped.join(', ')}`);
    expect(sized.length).toBe(BIG_LEVELS.length);
  });
});

// B5 Kapla Spire's drafts at rest on the GPU solver (roadmap G5, B5): each loads on the game's cast page as
// the game builds it (GPU sleep on, E2b's stabiliser), pre-settles, then stands with nothing fired: no plank
// moves 0.05 h (1.5 cm at h 0.3 m), the top does not sink 0.05 h, no engine limit is hit. B5c is the spire
// without sleep: whether it stands is the question, so it is reported, not asserted. 3,000 planks are past
// SwiftShader's budget for a CI file (B1's 1,000 cubes run about 0.4 s a step there), so this runs only with
// B5_REST=1, on Metal (TB_CHANNEL=chrome, REST_STEPS default 600; g5/explore-b5.sh) or SwiftShader (default 100).
import { appendFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compileLevel, DRAFTS } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
const channel = process.env.TB_CHANNEL;
const RUN = process.env.B5_REST === '1';
const REST_STEPS = Number(process.env.REST_STEPS ?? (channel ? 600 : 100));
const BOUND = 0.05;
/** B5_LOG=<file> appends each draft's line there too (the Mac script uploads it). */
const LOG = process.env.B5_LOG;
/** Drafts whose rest is asserted; the rest are reported. */
const ASSERTED = new Set(['B5a', 'B5b']);

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  if (!RUN) return;
  try {
    player = await openBrowserCastPlayer({ ...(channel ? { channel } : {}), batchTimeoutMs: 0 });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

describe('B5 Kapla Spire drafts at rest on the GPU solver', () => {
  for (const id of ['B5a', 'B5b', 'B5c']) it.runIf(RUN)(`${id} (${compileLevel(DRAFTS[id]!).meta.n} planks) after its pre-settle`, async (ctx) => {
    if (!player) return ctx.skip();
    const r = await player.rest(DRAFTS[id]!, REST_STEPS);
    const line = `${id} at rest on ${player.adapter}: ${JSON.stringify(r)}${player.software ? ' (software adapter: not a performance result)' : ''}`;
    console.log(line);
    if (LOG) appendFileSync(LOG, `${line}\n`);
    if (!ASSERTED.has(id)) return;
    expect(r.limits).toEqual([]);
    expect(r.maxMove).toBeLessThan(BOUND);
    expect(Math.abs(r.topDrop)).toBeLessThan(BOUND);
  }, 90 * MINUTES);
});

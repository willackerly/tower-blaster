// Chorus (M9) on the GPU solver, through the game's cast page (the Driver, as the game plays it).
// CI: CH1 at 4 worlds plays its obvious shot with no limit hit and no leak, every world judged, and world 0
// plays alone (the verify's solo arm). With PHYSICS_GPU_SLOW=1 or a real GPU (TB_CHANNEL): the node's verify on the GPU, islands against
// the same worlds played one at a time, as chorus-verify.test.ts does on Rapier (16 worlds on SwiftShader,
// about 20 min; 64 on a real GPU). SwiftShader times are never performance results.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CH1, CHORUS_LEVELS, chorusLine, type ChorusJudgement, type LevelDef } from '@tb/keystone';
import { fisherExact, ks2 } from '@tb/metrics';
import { requireWebGPU } from '@tb/testkit';
import { type BrowserCastPlayer, openBrowserCastPlayer } from '../src/cast-browser.ts';

const MINUTES = 60_000;
const channel = process.env.TB_CHANNEL;
const SLOW = Boolean(channel) || process.env.PHYSICS_GPU_SLOW === '1';
const VERIFY_K = channel ? 64 : 16;

let player: BrowserCastPlayer | null = null;
beforeAll(async () => {
  try {
    player = await openBrowserCastPlayer({ ...(channel ? { channel } : {}), batch: 1 });
  } catch (e) {
    if (requireWebGPU()) throw e;
  }
}, 3 * MINUTES);
afterAll(async () => { await player?.close(); });

const withWorlds = (d: LevelDef, worlds: number): LevelDef => ({ ...d, chorus: { ...d.chorus, worlds } });

describe('Chorus on the GPU solver', () => {
  it('CH1 at 4 worlds: the shot plays into every world with no limit hit and no leak; world 0 plays alone too', async (ctx) => {
    if (!player) return ctx.skip();
    const def = withWorlds(CH1, 4), line = chorusLine('CH1', 'obvious');
    const [r] = await player.play(def, [line]);
    const j = r!.chorus!;
    console.log(`CH1 x4 on ${player.adapter}: ${j.clears}/4 clear, crowns down ${j.crownsDown.join(',')}, ${r!.steps} steps`);
    expect(r!.limits).toEqual([]);
    expect(r!.complete).toBe(true);
    expect(j.worlds).toBe(4);
    expect(j.leaks).toBe(0);
    const [solo] = await player.playOnly(def, [line], 0);
    expect(solo!.chorus!.worlds).toBe(1);
    expect(solo!.limits).toEqual([]);
    console.log(`CH1 world 0 alone: crowns down ${solo!.chorus!.crownsDown[0]} (in the islands run ${j.crownsDown[0]}: a shared solve, so not bit for bit)`);
  }, 12 * MINUTES);

  for (const level of CHORUS_LEVELS) it.runIf(SLOW)(`${level.id}: ${VERIFY_K} islands against ${VERIFY_K} solo runs agree (KS and Fisher p > 0.05)`, async (ctx) => {
    if (!player) return ctx.skip();
    const def = withWorlds(level, VERIFY_K), line = chorusLine(level.id, 'obvious');
    const [isl] = await player.play(def, [line]);
    const a = isl!.chorus!, solo: ChorusJudgement[] = [];
    for (let k = 0; k < VERIFY_K; k++) solo.push((await player.playOnly(def, [line], k))[0]!.chorus!);
    const b = { moved: solo.map((s) => s.moved[0]!), crowns: solo.map((s) => s.crownsDown[0]!), clears: solo.filter((s) => s.cleared[0]).length };
    const moved = ks2(a.moved, b.moved), crowns = ks2(a.crownsDown, b.crowns), clears = fisherExact(a.clears, VERIFY_K, b.clears, VERIFY_K);
    const same = solo.filter((s, k) => s.crownsDown[0] === a.crownsDown[k]).length;
    console.log(`chorus verify (${player.adapter}, ${level.id}, ${VERIFY_K} worlds): clears islands ${a.clears}, solo ${b.clears} (Fisher p ${clears.toFixed(3)}); moved KS D ${moved.D.toFixed(3)} p ${moved.p.toFixed(3)}; crowns KS D ${crowns.D.toFixed(3)} p ${crowns.p.toFixed(3)}; same crowns world by world ${same}/${VERIFY_K}; leaks ${a.leaks}`);
    expect(a.leaks).toBe(0);
    expect(moved.p).toBeGreaterThan(0.05);
    expect(crowns.p).toBeGreaterThan(0.05);
    expect(clears).toBeGreaterThan(0.05);
  }, 120 * MINUTES);
});

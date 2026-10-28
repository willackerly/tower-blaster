// The viewer's input hook (window.__viewer.inputHook), where the weapons
// runtime plugs in: input decided from each observed snapshot, pushed due
// after the step it saw. Under Keystone's rules it runs every step and a
// session with it still equals runSession with the same hook as perStep; in
// the sandbox it runs on each snapshot the page reads. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import type { BodyDesc } from '@tb/engine-api';
import { driverOptions } from '@tb/game';
import { compileLevel, L1, runSession, type Shot, snapshotHash } from '@tb/keystone';
import { browser, open, useViewer } from './e2e-harness.ts';
import { openRules, play, ready } from './keystone-page.ts';

useViewer();

const c = compileLevel(L1);
/** A cube dropped beside L1's tower. */
const block: BodyDesc = { ...c.scene.bodies[0]!, pos: [3, 6, 3], linVel: [0, 0, 0], angVel: [0, 0, 0] };

describe('the viewer\'s input hook', () => {
  it('under Keystone\'s rules runs every step, live and in the replay, and the session equals runSession with it', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await openRules('/?level=L1&rules=keystone&engine=rapier&offscreen=1');
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    // Drops the block once, on the 10th snapshot it sees; a new hook each load and each replay.
    await page.evaluate((body) => {
      window.__viewer.inputHook = () => { let calls = 0; return (_s, step) => (++calls === 10 ? [{ step: step + 1, kind: 'spawn', body }] : []); };
    }, block);
    await page.evaluate(() => window.__viewer.game!.retry());
    const shots = L1.solutions!.par as Shot[];
    const live = await play(page, shots);
    expect(live.state.phase).toBe('cleared');

    let calls = 0;
    const r = await runSession(new RapierEngine(), c, shots, { ...driverOptions('rapier'), perStep: (d) => (++calls === 10 ? [{ step: d.snapshotStep + 1, kind: 'spawn', body: block }] : []) });
    expect(r.snapshot.count).toBe(c.meta.n + 2);
    expect(live.state).toEqual({ step: r.steps, phase: r.session.phase, strokes: 1, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(await page.evaluate((s) => window.__viewer.game!.replay(s), shots)).toEqual(live.state);
    // The page draws the block too: the source has a shape for every body.
    expect(await page.evaluate(() => window.__viewer.game!.bodies)).toBe(c.meta.n + 2);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('in the sandbox runs on each snapshot read, pushing what it returns, and refuses input for a step already seen', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=2&param.H=3&engine=rapier&offscreen=1');
    if (await page.evaluate(() => window.__viewer.status) !== 'running') return ctx.skip();
    const n = await page.evaluate(() => window.__viewer.bodies);
    await page.evaluate((body) => {
      const w = window as unknown as { seen: number[] };
      w.seen = [];
      window.__viewer.inputHook = () => { let done = false; return (_s, step) => { w.seen.push(step); if (done) return []; done = true; return [{ step: step + 1, kind: 'spawn', body }]; }; };
    }, block);
    await page.keyboard.press('r');
    await page.waitForFunction((m) => window.__viewer.bodies === m + 1, n, { timeout: 60_000 });
    const got = await page.evaluate(() => ({ inputs: window.__viewer.inputs, seen: (window as unknown as { seen: number[] }).seen }));
    // The first call is the load's own snapshot, at step 0; the block is due at step 1.
    expect(got.seen[0]).toBe(0);
    expect(got.inputs).toEqual([{ step: 1, kind: 'spawn', body: block }]);
    // Seen steps only go forward.
    expect(got.seen).toEqual([...got.seen].sort((a, b) => a - b));

    // A hook that stamps the step it saw is an error, not input applied a step late.
    await page.evaluate((body) => { window.__viewer.inputHook = () => (_s, step) => [{ step, kind: 'spawn', body }]; }, block);
    await page.keyboard.press('r');
    await page.waitForFunction(() => window.__viewer.status === 'error', undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.error)).toMatch(/input hook: an event for step 0 is not after the observed step 0/);
    expect(errors).toEqual([]);
    await page.close();
  });
});

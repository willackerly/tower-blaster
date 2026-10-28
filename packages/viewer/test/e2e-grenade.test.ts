// The grenade in the viewer's sandbox (proj.weapon=grenade): a timer fuse's
// blast goes in with the spawn, a proximity fuse's when the page sees the
// grenade near the tower; either is centred on the grenade, which it does not
// push, and throws the tower about. Rapier, then the GPU engine, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { BlastEvent, InputEvent, SpawnEvent } from '@tb/engine-api';
import { DEFAULT_GRENADE } from '@tb/weapons';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

const SCENE = '/?scenario=S1&param.F=2&param.H=3&engine=rapier&offscreen=1&proj.weapon=grenade';

async function fire(search: string) {
  const { page, errors } = await open(search);
  if (await page.evaluate(() => window.__viewer.status) !== 'running') return null;
  const n = await page.evaluate(() => window.__viewer.bodies);
  await page.evaluate(() => window.__viewer.fire(0, 0));
  return { page, errors, n };
}

describe('the grenade in the viewer', () => {
  it('a timer fuse: its blast goes in with the spawn, due delay s later, centred on the grenade', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await fire(`${SCENE}&grenade.fuse=timer&grenade.delay=0.5`);
    if (!o) return ctx.skip();
    const { page, errors, n } = o;
    const inputs = await page.evaluate(() => window.__viewer.inputs) as InputEvent[];
    expect(inputs.map((e) => e.kind)).toEqual(['spawn', 'blast']);
    const [spawn, blast] = inputs as [SpawnEvent, BlastEvent];
    expect(blast).toEqual({ step: spawn.step + 30, kind: 'blast', blast: { centre: { body: n }, exclude: [n], ...DEFAULT_GRENADE.blast } });
    await page.waitForFunction((s) => window.__viewer.stepIndex > s + 5, blast.step, { timeout: 60_000 });
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => window.__viewer.status)).toBe('running');
    await page.close();
  });

  it('a proximity fuse goes off near the tower, after the grenade was seen flying, and throws the tower about', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await fire(SCENE);
    if (!o) return ctx.skip();
    const { page, errors, n } = o;
    await page.waitForFunction(() => window.__viewer.inputs.some((e) => e.kind === 'blast'), undefined, { timeout: 60_000 });
    const [spawn, blast] = await page.evaluate(() => window.__viewer.inputs) as [SpawnEvent, BlastEvent];
    expect(blast.blast).toEqual({ centre: { body: n }, exclude: [n], ...DEFAULT_GRENADE.blast });
    // The grenade flew a while (the camera frames the tower from metres away), then went off.
    expect(blast.step).toBeGreaterThan(spawn.step + 3);
    await page.waitForFunction((s) => window.__viewer.stepIndex > s + 10, blast.step, { timeout: 60_000 });
    // Thrown: most of the tower's cubes are awake and moving.
    expect(await page.evaluate(() => window.__viewer.awake)).toBeGreaterThan(n / 2);
    expect(await page.evaluate(() => window.__viewer.inputs.length)).toBe(2);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('on the GPU engine too (the viewer\'s default)', async (ctx) => {
    if (!browser) return ctx.skip();
    const o = await fire(SCENE.replace('&engine=rapier', ''));
    if (!o) return ctx.skip();
    const { page, errors, n } = o;
    await page.waitForFunction(() => window.__viewer.inputs.some((e) => e.kind === 'blast'), undefined, { timeout: 120_000 });
    const blast = (await page.evaluate(() => window.__viewer.inputs))[1] as BlastEvent;
    expect(blast.blast.centre).toEqual({ body: n });
    await page.waitForFunction((s) => window.__viewer.stepIndex > s + 10, blast.step, { timeout: 120_000 });
    expect(await page.evaluate(() => window.__viewer.status)).toBe('running');
    expect(errors).toEqual([]);
    await page.close();
  });
});

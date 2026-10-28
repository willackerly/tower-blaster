// Real things to throw in the viewer (proj=<name>): a click fires the thing at its real size,
// speed and mass ratio to the blocks, painted its candy skin, its natural colour in the real look;
// on the GPU engine the Raiders boulder (radius 3.35 cubes) runs on a grid sized for it.
// Rapier, then the GPU engine, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { SpawnEvent } from '@tb/engine-api';
import { requireWebGPU } from '@tb/testkit';
import { PROJECTILE_PRESETS, STONE_DENSITY } from '@tb/weapons';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

const SCENE = '/?scenario=S1&param.F=2&param.H=3&offscreen=1';

describe('real things in the viewer', () => {
  it('a bowling ball goes out at its size, speed and density, painted its candy skin, then its colour in the real look', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(`${SCENE}&engine=rapier&proj=bowlingball`);
    if (await page.evaluate(() => window.__viewer.status) !== 'running') return ctx.skip();
    const n = await page.evaluate(() => window.__viewer.bodies);
    await page.evaluate(() => window.__viewer.fire(0, 0));
    const [spawn] = await page.evaluate(() => window.__viewer.inputs) as SpawnEvent[];
    const r = PROJECTILE_PRESETS.bowlingball;
    expect(spawn!.body).toMatchObject({ shape: { kind: 'sphere', radius: r.diameter / 2 }, restitution: r.restitution, friction: r.friction });
    expect(spawn!.body.density).toBeCloseTo(r.density / STONE_DENSITY, 12);
    expect(Math.hypot(...spawn!.body.linVel)).toBeCloseTo(r.speed, 9);
    expect(await page.evaluate(() => window.__viewer.painted)).toEqual([{ id: n, colour: r.candy }]);
    await page.locator('#controls summary').click();
    await page.locator('#look-form select[name=look]').selectOption('real');
    await page.waitForFunction((c) => window.__viewer.painted[0]?.colour === c, r.colour, { timeout: 30_000 });
    // The panel says what it weighs against a block.
    const proj = page.locator('#proj-form');
    expect(await proj.locator('.out').textContent()).toMatch(/^7\.27 kg, 1\/330 of a 1 m cube of block \(2\.40 t\)/);
    // Picking another thing fills in its own size, speed, bounce and friction, and the URL says which.
    await proj.locator('select[name=shape]').selectOption('beachball');
    expect(await Promise.all(['size', 'speed', 'mass', 'restitution', 'friction'].map((k) => proj.locator(`input[name=${k}]`).inputValue()))).toEqual(['0.5', '15', '', '0.75', '0.6']);
    await page.waitForFunction(() => new URL(location.href).searchParams.get('proj') === 'beachball', undefined, { timeout: 30_000 });
    expect([...new URL(page.url()).searchParams.keys()].filter((k) => k.startsWith('proj'))).toEqual(['proj']);
    expect(errors).toEqual([]);
    await page.close();
  });

  it('the Raiders boulder on the GPU engine, which sizes its grid for it', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open(`${SCENE}&proj=boulder`);
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    const n = await page.evaluate(() => window.__viewer.bodies);
    await page.evaluate(() => window.__viewer.fire(0, 0));
    const s0 = await page.evaluate(() => window.__viewer.stepIndex);
    await page.waitForFunction((s) => window.__viewer.stepIndex > s + 60, s0, { timeout: 120_000 });
    expect(await page.evaluate(() => window.__viewer.status)).toBe('running');
    expect(await page.evaluate(() => window.__viewer.resets)).toBe(1); // the first load only: no rebuild
    expect(await page.evaluate(() => window.__viewer.painted)).toEqual([{ id: n, colour: PROJECTILE_PRESETS.boulder.candy }]);
    expect(errors).toEqual([]);
    await page.close();
  });
});

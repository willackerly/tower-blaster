// Edit mode in the viewer (C9, docs/game/placement.md) in headless Chromium:
// time stops, the ghost draws and follows the pointer, a click places, the
// overlap check refuses, the domino brush lays a run, Cancel reloads, and Play loads exactly
// the level a saved link loads (same level hash, same bodies). SwiftShader in CI.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, type LevelDef } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

type V3 = [number, number, number];
const L1C = compileLevel(L1);
// A free spot on the ground beside L1's structure, and one inside its first body.
let xMax = -Infinity, zMid = 0;
for (const b of L1C.scene.bodies) { xMax = Math.max(xMax, b.pos[0] + 0.5); zMid += b.pos[2] / L1C.meta.n; }
const FREE: V3 = [xMax + 1.2, 30, zMid];
const DOWN: V3 = [0, -1, 0];

describe('viewer edit mode', () => {
  it('stops time, draws the ghost, places, lays a run, and Play loads what the link loads', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?level=L1&presettle=10&offscreen=1&engine=rapier&look=hazy&edit=1&edit.item=cube');
    const status = await page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
    if (status.s === 'error' && /WebGPU|adapter/.test(status.e ?? '') && !requireWebGPU()) return ctx.skip();
    expect(status).toEqual({ s: 'running', e: undefined });
    await page.waitForFunction(() => window.__viewer.edit.on && window.__viewer.frames > 3, undefined, { timeout: 60_000 });
    expect(new URL(page.url()).searchParams.get('edit')).toBe('1');

    // Time is stopped: no steps while editing.
    const step0 = await page.evaluate(() => window.__viewer.stepIndex);
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => window.__viewer.stepIndex)).toBe(step0);

    // The ghost follows the pointer and draws green.
    await page.evaluate(([o, d]) => window.__viewer.edit.ray('move', o, d), [FREE, DOWN] as const);
    expect(await page.evaluate(() => window.__viewer.edit.ghosts())).toBe(1);
    const stats = await page.evaluate(() => window.__viewer.capture(true));
    const px = stats!.pixels!;
    let green = 0;
    for (let y = 0; y < stats!.height; y++) for (let x = 0; x < stats!.width; x++) {
      const i = y * px.bytesPerRow + 4 * x;
      if (px.data[i + 1]! - px.data[i]! > 40 && px.data[i + 1]! - px.data[i + 2]! > 25) green++;
    }
    expect(green).toBeGreaterThan(20);

    // A click places it.
    await page.evaluate(([o, d]) => window.__viewer.edit.ray('up', o, d), [FREE, DOWN] as const);
    const n0 = L1.parts.length;
    expect(await page.evaluate(() => window.__viewer.edit.def()!.parts.length)).toBe(n0 + 1);

    // The domino brush: press, drag, release.
    await page.evaluate(() => window.__viewer.edit.key('b'));
    const start: V3 = [FREE[0] + 2, 30, zMid - 3];
    await page.evaluate(([o, d]) => window.__viewer.edit.ray('down', o, d), [start, DOWN] as const);
    for (let k = 0; k <= 60; k++) await page.evaluate(([o, d]) => window.__viewer.edit.ray('move', o, d), [[start[0], 30, start[2] + 0.1 * k] as V3, DOWN] as const);
    expect(await page.evaluate(() => window.__viewer.edit.status())).toMatch(/dominoes/);
    await page.evaluate(([o, d]) => window.__viewer.edit.ray('up', o, d), [[start[0], 30, start[2] + 6] as V3, DOWN] as const);
    const def = await page.evaluate(() => window.__viewer.edit.def()) as LevelDef;
    expect(def.parts.at(-1)!.kind).toBe('run');
    const want = compileLevel(def);

    // Play: the edited level runs, and its hash is the one compiled from the definition.
    const resets = await page.evaluate(() => window.__viewer.resets);
    // The Build panel's Play button.
    await page.locator('#build button[data-a=play]').click();
    await page.waitForFunction((r) => window.__viewer.resets > r && !window.__viewer.edit.on, resets, { timeout: 60_000 });
    const after = await page.evaluate(() => ({ hash: window.__viewer.levelHash, played: window.__viewer.edit.played, bodies: window.__viewer.bodies, url: location.search }));
    expect(after.played).toBe(want.hash);
    expect(after.hash).toBe(want.hash);
    expect(after.bodies).toBe(want.meta.n);
    expect(new URLSearchParams(after.url).get('edit')).toBeNull();
    await page.waitForFunction((s) => window.__viewer.stepIndex > s, step0, { timeout: 30_000 });

    // The link the page now shows loads the same level: same hash, same bodies.
    const { page: again, errors: errors2 } = await open(after.url);
    await again.waitForFunction(() => window.__viewer.frames > 2, undefined, { timeout: 60_000 });
    expect(await again.evaluate(() => ({ hash: window.__viewer.levelHash, bodies: window.__viewer.bodies }))).toEqual({ hash: want.hash, bodies: want.meta.n });
    expect(errors).toEqual([]);
    expect(errors2).toEqual([]);
    await again.close();
    await page.close();
  });

  it('refuses an overlapping piece and Cancel leaves the scene as it was; B on a scenario builds on it as a level', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, errors } = await open('/?scenario=S1&param.F=2&param.H=3&offscreen=1&engine=rapier');
    if (await page.evaluate(() => window.__viewer.status) === 'error' && !requireWebGPU()) return ctx.skip();
    await page.waitForFunction(() => window.__viewer.frames > 2, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.levelHash)).toBeNull();
    await page.keyboard.press('b');
    await page.waitForFunction(() => window.__viewer.edit.on && window.__viewer.resets === 2, undefined, { timeout: 60_000 });
    const def = await page.evaluate(() => window.__viewer.edit.def()) as LevelDef;
    expect(def.parts[0]).toMatchObject({ kind: 'scenario', id: 'S1' });
    expect(await page.evaluate(() => window.__viewer.levelHash)).toBe(compileLevel(def).hash);
    // A pier (the beam tipped on its x axis) with snap off, beside the tower's first body on the ground, reaching into it.
    const c = compileLevel(def), b = c.scene.bodies.reduce((best, x) => (x.pos[1] < best.pos[1] || (x.pos[1] === best.pos[1] && x.pos[0] > best.pos[0]) ? x : best));
    const half = (b.shape as { half: V3 }).half;
    await page.evaluate(() => { window.__viewer.edit.key('5'); window.__viewer.edit.key('t'); });
    const at: V3 = [b.pos[0] + half[0] + 0.1, 30, b.pos[2]];
    await page.evaluate(([o]) => window.__viewer.edit.ray('up', o, [0, -1, 0], true), [at] as const);
    expect(await page.evaluate(() => window.__viewer.edit.status())).toMatch(/overlaps/);
    expect((await page.evaluate(() => window.__viewer.edit.def()))!.parts.length).toBe(def.parts.length);
    // Escape: edit mode ends, the scene reloads as it was.
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.__viewer.edit.on && window.__viewer.resets === 3, undefined, { timeout: 60_000 });
    expect(await page.evaluate(() => window.__viewer.levelHash)).toBe(compileLevel(def).hash);
    expect(errors).toEqual([]);
    await page.close();
  });
});

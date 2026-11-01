// A WeaponSpec in the viewer's sandbox (proj.weapon=firework): the shell
// splits into its 12 stars (spawned after the scene and the shell, numbered
// by the engine's order), each star blows and is spent, and the page keeps
// running. Rapier, then the GPU engine, headless Chromium.
import { describe, expect, it } from 'vitest';
import type { InputEvent } from '@tb/engine-api';
import { browser, open, useViewer } from './e2e-harness.ts';

useViewer();

const SCENE = '/?scenario=S1&param.F=2&param.H=3&engine=rapier&offscreen=1&proj.weapon=firework';

async function fireworks(search: string, timeout: number) {
  const { page, errors } = await open(search);
  if (await page.evaluate(() => window.__viewer.status) !== 'running') return null;
  const n = await page.evaluate(() => window.__viewer.bodies);
  await page.evaluate(() => window.__viewer.fire(0, 0.3));
  // Every star blows (on landing, or after 5 s).
  await page.waitForFunction(() => window.__viewer.inputs.filter((e) => e.kind === 'blast').length >= 12, undefined, { timeout });
  const inputs = await page.evaluate(() => window.__viewer.inputs) as InputEvent[];
  const count = (k: string) => inputs.filter((e) => e.kind === k).length;
  expect([count('spawn'), count('blast'), count('remove')]).toEqual([13, 12, 13]);
  // The split: 12 spawns then the shell's removal, at one step; each star's blast is centred on it, and it is spent.
  const split = inputs.find((e) => e.kind === 'remove' && e.id === n)!;
  expect(inputs.filter((e) => e.kind === 'spawn' && e.step === split.step)).toHaveLength(12);
  const stars = new Set(inputs.flatMap((e) => (e.kind === 'blast' && typeof e.blast.centre === 'object' && 'body' in e.blast.centre ? [e.blast.centre.body] : [])));
  expect([...stars].sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => n + 1 + i));
  for (const id of stars) expect(inputs.some((e) => e.kind === 'remove' && e.id === id)).toBe(true);
  expect(await page.evaluate(() => window.__viewer.bodies)).toBe(n + 13);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => window.__viewer.status)).toBe('running');
  await page.close();
  return true;
}

describe('a WeaponSpec in the viewer', () => {
  it('the firework splits into its stars, which blow and are spent (Rapier)', async (ctx) => {
    if (!browser) return ctx.skip();
    if (!(await fireworks(SCENE, 60_000))) ctx.skip();
  });

  it('on the GPU engine too (the viewer\'s default)', async (ctx) => {
    if (!browser) return ctx.skip();
    if (!(await fireworks(SCENE.replace('&engine=rapier', ''), 120_000))) ctx.skip();
  });
});

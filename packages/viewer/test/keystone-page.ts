// The viewer under Keystone's rules for the e2e files: open a page on the
// game's loop and play shots through window.__viewer.game.
import { expect } from 'vitest';
import type { Page } from 'playwright';
import { aimAt, compileLevel, launcherPos, type LevelDef, type Shot } from '@tb/keystone';
import { requireWebGPU } from '@tb/testkit';
import { open } from './e2e-harness.ts';

const MINUTES = 60_000;

export const ready = (page: Page, timeout = 5 * MINUTES) => page.waitForFunction(() => window.__viewer.game!.ready || window.__viewer.game!.result !== null, undefined, { timeout, polling: 250 });

/**
 * Open under the rules; null when there is no WebGPU adapter here (skip unless required). The page
 * leaves loading only after the level's first load, pre-settle included, which on the GPU solver under
 * SwiftShader takes minutes: `timeout` bounds it.
 */
export async function openRules(search: string, viewport?: { width: number; height: number }, timeout = MINUTES) {
  const o = await open(search, viewport, timeout);
  const st = await o.page.evaluate(() => ({ s: window.__viewer.status, e: window.__viewer.error }));
  if (st.s === 'error' && /WebGPU|adapter/.test(st.e ?? '') && !requireWebGPU()) { await o.page.close(); return null; }
  expect(st).toEqual({ s: 'running', e: undefined });
  return o;
}

/** Fire the shots at fast-forward, each once the game is ready, until the last has settled or the level ended. */
export async function play(page: Page, shots: Shot[]) {
  await page.evaluate(() => { window.__viewer.game!.fast = true; });
  for (const shot of shots) {
    await ready(page);
    expect(await page.evaluate((s) => window.__viewer.game!.fire(s), shot)).toBe(true);
  }
  await page.waitForFunction((n) => { const g = window.__viewer.game!; return g.result !== null || (g.ready && g.strokes === n); }, shots.length, { timeout: 10 * MINUTES, polling: 250 });
  return page.evaluate(() => ({ state: window.__viewer.game!.state(), score: window.__viewer.game!.result }));
}


/**
 * A cannonball at full power from launcher azimuth `az` (0.5 deg quanta) at the level's launcher
 * height, aimed (aimAt) at the centre of the structure body nearest the launcher whose centre is
 * between yLo and yHi h up; with the compiled level and the aim's miss distance (m).
 */
export function aimAtNearest(def: LevelDef, az: number, yLo: number, yHi: number) {
  const c = compileLevel(def), h = c.frame.unit, y = 4 * def.launcher.y, from = launcherPos(c.frame, az, y);
  let best = -1, dist = Infinity;
  for (let i = 0; i < c.meta.n; i++) {
    const by = c.meta.home[3 * i + 1]! / h;
    if (by < yLo || by > yHi) continue;
    const d = Math.hypot(c.meta.home[3 * i]! - from[0], c.meta.home[3 * i + 2]! - from[2]);
    if (d < dist) { dist = d; best = i; }
  }
  if (best < 0) throw new Error(`no body between ${yLo} and ${yHi} h`);
  const target: [number, number, number] = [c.meta.home[3 * best]!, c.meta.home[3 * best + 1]!, c.meta.home[3 * best + 2]!];
  return { c, ...aimAt(c.frame, 'cannonball', { az, y, power: 100 }, target, { dt: c.scene.dt }) };
}

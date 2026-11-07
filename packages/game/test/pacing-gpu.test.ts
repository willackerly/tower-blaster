// G4.2 on a page: the game's physics runs apart from its frames. On
// SwiftShader a GPU step of L1 takes tens of milliseconds or more, so this is
// an engine far over its budget. Before G4 every frame waited for its steps,
// and a frame was never shorter than a step; now frames keep coming while a
// step runs, the valve slows sim time to budget / cost, and the HUD says so.
// The claim checked is structural (who waits for whom), so it holds on any
// adapter; the times themselves are never performance results (CLAUDE.md).
import { describe, expect, it } from 'vitest';
import { L1, type Shot } from '@tb/keystone';
import { DEFAULT_BUDGET_MS, valve } from '../src/pacing.ts';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

describe('pacing on the GPU solver (G4.2)', () => {
  it('frames keep coming while slow steps run; the valve and the HUD tag follow the step cost', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=gpu&offscreen=1&keystone.presettle=30', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const shot = L1.solutions!.par![0] as Shot;
    expect(await page.evaluate((s) => window.__game.fire(s), shot)).toBe(true);
    // Sample the pace while the shot runs at normal speed (no fast-forward).
    const samples: Array<{ timeScale: number; speed: number; tag: string; costMs: number; tailSkip: boolean; hud: string; over: boolean }> = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      const p = await page.evaluate(() => ({ phase: window.__game.phase, ...window.__game.pace, hud: document.querySelector('.kg-hud .pace')?.textContent ?? '', over: window.__game.resultShownAt !== null }));
      if (p.phase !== 'running') break;
      samples.push(p);
    }
    const t = await page.evaluate(() => window.__game.timing);
    expect(t.costMs.length).toBeGreaterThan(5);
    const cost = median(t.costMs), frame = median(t.frameMs);
    console.log(`L1 on the GPU here: step cost median ${cost.toFixed(1)} ms over ${t.costMs.length}, frame interval median ${frame.toFixed(1)} ms over ${t.frameMs.length}`);
    if (cost < 3 * DEFAULT_BUDGET_MS) return ctx.skip(); // a fast GPU: nothing over budget to see here
    // Frames did not wait for steps: many frames per step, each far shorter than a step.
    expect(t.frameMs.length).toBeGreaterThan(2 * t.costMs.length);
    expect(frame).toBeLessThan(cost / 2);
    // The valve: at its floor or at budget / cost, and the speed reached never above it. Not once the round is
    // over (every crown down: the rest runs at fast-forward, untagged) or in the tail skip.
    const late = samples.slice(1).filter((s) => !s.tailSkip && !s.over);
    expect(late.length).toBeGreaterThan(0);
    for (const s of late) {
      expect(s.timeScale).toBeCloseTo(valve(DEFAULT_BUDGET_MS, s.costMs), 2);
      expect(s.speed).toBeLessThan(0.95);
      expect(s.tag).toMatch(/^\d{1,2}% speed$/);
      expect(s.hud).toBe(s.tag); // the HUD shows it
    }
    expect(errors).toEqual([]);
    await page.close();
  }, 20 * MINUTES);
});

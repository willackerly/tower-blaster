// GPU per-body sleep in the game (roadmap E2.5): `?keystone.sleep=1` (or a level's physics.sleep) builds
// the GPU engine with sleep. The structure falls asleep in the pre-settle, a shot wakes what it touches
// (the whole tower: one touch wakes the sleeper group), the par line still clears, and an undo puts the
// world, sleepers and all, back as it was. The debug tint (keystone.sleeptint) draws the sleepers in blue. One file of its own: SwiftShader takes about half a minute.
import { describe, expect, it } from 'vitest';
import { limitsHit } from '@tb/engine-api';
import { LEVELS, type Shot } from '@tb/keystone';
import { gamePage, playShots, ready } from './page.ts';

const MINUTES = 60_000;

describe('sleep on in the game (GPU)', () => {
  const game = gamePage();
  it('L1 with keystone.sleep=1: asleep after the pre-settle, woken by the shot, the par line clears, and undo restores the sleepers', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const def = LEVELS.find((l) => l.id === 'L1')!;
    const o = await game.open('/?level=L1&offscreen=1&engine=gpu&keystone.sleep=1', 10 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page, 10 * MINUTES);
    const start = await page.evaluate(() => ({ engine: window.__game.engine, asleep: window.__game.asleep(), state: window.__game.state() }));
    expect(start.engine).toBe('gpu');
    // The 300-step pre-settle leaves the tower at rest: (nearly) every block asleep. SwiftShader sleeps all 40.
    expect(start.asleep.of).toBe(40);
    expect(start.asleep.asleep).toBeGreaterThanOrEqual(36);
    // The debug tint (keystone.sleeptint, read live): the sleeping tower draws in blue, and only it changes.
    const tinted = await page.evaluate(async () => {
      const g = window.__game;
      const shot = async (on: boolean) => { g.feel.sleepTint = on; return (await g.capture(true))!.pixels!; };
      const off = await shot(false), on = await shot(true);
      g.feel.sleepTint = false;
      const keep = { off: off.data, on: on.data, bytesPerRow: off.bytesPerRow };
      let changed = 0, blueGain = 0;
      for (let o = 0; o < off.data.length; o += 4) {
        const d = Math.abs(on.data[o]! - off.data[o]!) + Math.abs(on.data[o + 1]! - off.data[o + 1]!) + Math.abs(on.data[o + 2]! - off.data[o + 2]!);
        if (d < 30) continue;
        changed++;
        blueGain += (on.data[o + 2]! - on.data[o]!) - (off.data[o + 2]! - off.data[o]!);
      }
      return { changed, total: off.data.length / 4, blueGain: changed ? blueGain / changed : 0, keep };
    });
    // Screenshots (SLEEP_SHOTS=dir): the tower asleep with the tint off and on.
    if (process.env.SLEEP_SHOTS) {
      const { writeFileSync } = await import('node:fs');
      const { encodePng } = await import('@tb/testkit');
      const w = tinted.keep.bytesPerRow / 4, h = tinted.keep.off.length / tinted.keep.bytesPerRow;
      for (const k of ['off', 'on'] as const) writeFileSync(`${process.env.SLEEP_SHOTS}/sleep-tint-${k}.png`, encodePng(w, h, { data: tinted.keep[k], bytesPerRow: tinted.keep.bytesPerRow }));
    }
    console.log(`sleep tint: ${tinted.changed} of ${tinted.total} pixels changed, blue minus red up ${tinted.blueGain.toFixed(1)} on them`);
    expect(tinted.changed).toBeGreaterThan(0.01 * tinted.total);
    expect(tinted.blueGain).toBeGreaterThan(40);
    const shots = def.solutions!.par as Shot[];
    expect(shots.length).toBe(1);
    await page.evaluate(() => { window.__game.fast = true; });
    expect(await page.evaluate((s) => window.__game.fire(s), shots[0]!)).toBe(true);
    // The ball reaches the tower and wakes it: some snapshot during the shot has fewer asleep.
    await page.waitForFunction((n) => window.__game.asleep().asleep < n || window.__game.result !== null, start.asleep.asleep, { timeout: 10 * MINUTES, polling: 100 });
    expect(await page.evaluate(() => window.__game.result)).toBeNull();
    await playShots(page, [], 20 * MINUTES);
    const end = await page.evaluate(() => ({ state: window.__game.state(), asleep: window.__game.asleep() }));
    console.log(`L1 with sleep: ${start.asleep.asleep}/40 asleep after the pre-settle, ${end.asleep.asleep}/40 at the end (step ${end.state.step})`);
    expect({ phase: end.state.phase, strokes: end.state.strokes, heritageBroken: end.state.heritageBroken }).toEqual({ phase: 'cleared', strokes: def.par, heritageBroken: 0 });
    // The rubble at rest falls asleep again.
    expect(end.asleep.asleep).toBeGreaterThan(0);
    expect(limitsHit((await page.evaluate(() => window.__game.health()))!).map((l) => l.message)).toEqual([]);
    // Undo (from the checkpoint taken as the shot went in) restores every pose and the sleep state with them.
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    expect(await page.evaluate(() => ({ state: window.__game.state(), asleep: window.__game.asleep(), mode: window.__game.undone?.mode }))).toEqual({ state: start.state, asleep: start.asleep, mode: 'checkpoint' });
    expect(await page.evaluate(() => ({ status: window.__game.status, error: window.__game.error }))).toEqual({ status: 'running', error: undefined });
    expect(errors).toEqual([]);
    await page.close();
  }, 30 * MINUTES);
});

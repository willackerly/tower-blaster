// Real projectiles fire from the rack (roadmap G3.2, spectacle-mode.md section 7):
// each p-<preset> spawns at its real size, its model-scale mass and its own speed,
// and the engine flies it from there; a line of presets played on the game page
// (?keystone.rack, ?keystone.shots) ends where runSession ends it headless, and the
// page's own replay agrees pose for pose. Rapier here; rack-presets-gpu.test.ts
// plays the same line on the GPU solver.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { freeFlight, massOf } from '@tb/engine-api';
import { compileLevel, Driver, type Feedback, L1, MODEL_DENSITY, runSession, type Shot, shotToSpawn, snapshotHash, speedOf, writeShots } from '@tb/keystone';
import { PRESET_NAMES, presetMass, PROJECTILE_PRESETS } from '@tb/weapons';
import { driverOptions } from '../src/engines.ts';
import { gamePage } from './page.ts';
import { PRESET_LINE, PRESET_RACK } from './rack-line.ts';

const game = gamePage();

describe('real projectiles in the rack', () => {
  it('each preset spawns at its converted mass and its speed, and the engine flies it from there (Rapier)', async () => {
    for (const p of PRESET_NAMES) for (const power of [0, 100]) {
      const item = `p-${p}` as const, real = PROJECTILE_PRESETS[p];
      const c = compileLevel({ ...L1, rack: [item] });
      const d = new Driver(new RapierEngine(), c, driverOptions('rapier'));
      await d.reset();
      // Aimed well away from the tower and launched clear of the ground (the boulder is 6.7 h across), so the first step is free flight.
      const y = Math.max(8, Math.ceil(4 * (real.diameter / 2 / c.frame.unit + 0.5)));
      const shot: Shot = { ammo: item, az: 0, y, yaw: 900, pitch: 300, power };
      const fired = d.fire(shot).find((f): f is Extract<Feedback, { t: 'fired' }> => f.t === 'fired')!;
      const spawn = shotToSpawn(c.frame, shot, fired.step);
      expect(spawn.body.shape).toEqual({ kind: 'sphere', radius: real.diameter / 2 });
      expect(massOf(spawn.body) / (presetMass(real) * MODEL_DENSITY) - 1).toBeLessThan(1e-12);
      expect(Math.hypot(...spawn.body.linVel)).toBeCloseTo(power === 0 ? real.speed / 2 : real.speed, 9);
      expect(Math.hypot(...spawn.body.linVel)).toBeCloseTo(speedOf(item, power), 12);
      expect(fired.ke).toBeCloseTo(0.5 * massOf(spawn.body) * speedOf(item, power) ** 2, 6);
      await d.step();
      const id = fired.body, s = d.snapshot;
      const want = freeFlight(spawn.body.pos, spawn.body.linVel, c.scene.gravity, c.scene.dt, d.engine.info.integrator?.substeps ?? 1, 1);
      for (let k = 0; k < 3; k++) {
        expect(s.pos[3 * id + k]!, `${p} pos ${k}`).toBeCloseTo(want.pos[k]!, 4);
        expect(s.linVel[3 * id + k]!, `${p} vel ${k}`).toBeCloseTo(want.vel[k]!, 4);
      }
      d.engine.dispose();
    }
  });

  it('a line of presets on the game page ends where runSession ends it, and the page replays it pose for pose (Rapier)', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(`/?level=L1&engine=rapier&offscreen=1&keystone.rack=${PRESET_RACK.join(',')}&keystone.shots=${writeShots(PRESET_LINE)}`);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.evaluate(() => { window.__game.fast = true; });
    // The line plays on load; it ends at the level's end or once its last shot settles.
    await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), PRESET_LINE.length, { timeout: 240_000, polling: 100 });
    const live = await page.evaluate(() => window.__game.state());
    const c = compileLevel({ ...L1, rack: PRESET_RACK });
    const r = await runSession(new RapierEngine(), c, PRESET_LINE, driverOptions('rapier'));
    expect(live).toEqual({ step: r.steps, phase: 'cleared', strokes: PRESET_LINE.length, heritageBroken: 0, hash: snapshotHash(r.snapshot) });
    expect(r.session.phase).toBe('cleared');
    expect(await page.evaluate((s) => window.__game.replay(s), PRESET_LINE)).toEqual(live);
    // The chips name the items, and the URL keeps the override while the level is the one it was given for.
    expect(await page.locator('#hud').innerText()).toMatch(/Wrecking ball/);
    expect(new URLSearchParams(await page.evaluate(() => location.search)).get('keystone.rack')).toBe(PRESET_RACK.join(','));
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});

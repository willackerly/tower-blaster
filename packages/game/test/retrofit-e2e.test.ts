// Aftershock's retrofit on the game page (M7b, docs/game/aftershock.md "Retrofit"), Rapier in headless Chromium:
// Lean on Me (A6) opens in the build phase with the budget on its status line; a plank laid from each column's top
// onto its hall (keys pick the plank, a ray straight down places it, as a click would) is spent from the budget;
// Play loads the level as built; the quake panel is the level's own quake, fixed: the dial keys and Q/E do nothing,
// and the panel shows what was braced against the budget; Enter starts that quake; and the page ends where
// runSession ends the built level headless, with a Budget left line on the card when every column stands. That the
// bracings save the columns on the reference and the GPU is keystone-lab's retrofit-ref and retrofit-gpu tests.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { A6, BuildSession, compileLevel, type LevelDef, runSession, type Shot, snapshotHash } from '@tb/keystone';
import { driverOptions } from '../src/engines.ts';
import { gamePage } from './page.ts';

const MINUTES = 60_000;
const game = gamePage();
type V3 = [number, number, number];
const DOWN: V3 = [0, -1, 0];

describe('a retrofit on the game page', () => {
  it('A6: builds against the budget, plays the build, the quake is the level\'s and fixed, Enter starts it, the card scores the budget left', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=A6&engine=rapier&offscreen=1&progress=off&door=0', undefined, { viewport: { width: 1024, height: 640 } });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.edit.on, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const budget = A6.build!.budget!;
    expect(await page.evaluate(() => window.__game.edit.status())).toContain(`${budget} of ${budget} left`);

    // The plank (its key is its place in the bin), then a ray straight down onto each column's top near its edge toward the hall.
    const s = new BuildSession(A6), plank = s.items.findIndex((i) => i.name === 'plank') + 1;
    expect(plank).toBeGreaterThan(0);
    expect(await page.evaluate((k) => window.__game.edit.key(String(k)), plank)).toBe(true);
    const bodies = compileLevel(A6).scene.bodies, tops = [5, 17, 29]; // col6, hall (six storeys, one body each), col6, hall, col6, hall
    for (const b of tops) {
      const body = bodies[b]!, half = body.shape.kind === 'box' ? body.shape.half : [0, 0, 0];
      const at: V3 = [body.pos[0] + 0.9 * half[0]!, 20, body.pos[2]];
      await page.evaluate(([o, d]) => window.__game.edit.ray('move', o, d), [at, DOWN] as const);
      await page.evaluate(([o, d]) => window.__game.edit.ray('down', o, d), [at, DOWN] as const);
      await page.evaluate(([o, d]) => window.__game.edit.ray('up', o, d), [at, DOWN] as const);
      // The same hit through the build tool headless (the retrofit search's tie): the page places what the bot places.
      expect(s.place(s.ghost({ body: b, point: [at[0], body.pos[1] + half[1]!, at[2]], normal: [0, 1, 0], t: 0 }, { item: 'plank', yaw: 0, tip: 0 }))).toBe(true);
    }
    const def = await page.evaluate(() => window.__game.edit.def()) as LevelDef;
    expect(def.parts.filter((p) => 'placed' in p && p.placed)).toHaveLength(3);
    expect(def.parts).toEqual(s.def().parts); // (the page marks the level custom on Rapier: the stars are the GPU's)
    const spent = budget - Number(/(\d+) of \d+ left/.exec(await page.evaluate(() => window.__game.edit.status()))![1]);
    expect(spent).toBe(A6.stars!.t3);

    // Play: the level as built; the quake panel is the level's quake, fixed, with what was braced against the budget.
    await page.locator('.kg-build button[data-a=play]').click();
    await page.waitForFunction(() => !window.__game.edit.on && window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 100 });
    const built = compileLevel(def);
    expect(await page.evaluate(() => window.__game.edit.played)).toBe(built.hash);
    await page.waitForSelector('.kg-hud .quake-panel.fixed', { timeout: 30_000 });
    const fixed = { peak: 30, hz: 10, sec: 10, axis: 0 };
    expect(await page.evaluate(() => window.__game.dial())).toEqual(fixed);
    for (const k of ['e', 'q', 'd', 'a', 'x', 'z', 'v', 'c']) await page.keyboard.press(k);
    expect(await page.evaluate(() => window.__game.dial())).toEqual(fixed);
    expect(await page.locator('.kg-hud .quake-panel button.qd').count()).toBe(0);
    expect(await page.locator('.kg-hud .qbrace').innerText()).toMatch(new RegExp(`${spent} / ${budget}\\s*braced`));

    // Enter starts the level's quake; the page ends where runSession ends the build headless.
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__game.strokes === 1, undefined, { timeout: 30_000, polling: 50 });
    const line: Shot[] = [{ ammo: 'quake', ...fixed }];
    expect(await page.evaluate(() => window.__game.line())).toEqual(line);
    await page.evaluate(() => { window.__game.fast = true; });
    await page.waitForFunction(() => window.__game.result !== null, undefined, { timeout: 4 * MINUTES, polling: 250 });
    const live = await page.evaluate(() => window.__game.state());
    const r = await runSession(new RapierEngine(), built, line, driverOptions('rapier'));
    expect(live).toEqual({ step: r.steps, phase: r.session.phase, strokes: 1, heritageBroken: r.session.heritageBroken.reduce((a, x) => a + x, 0), hash: snapshotHash(r.snapshot) });
    const result = await page.evaluate(() => window.__game.result!);
    const met = r.session.outcomeFacts().met;
    console.log(`A6 on Rapier, three planks: ${met ? 'every column stands' : 'a column fell'}; ${result.lines.map((l) => `${l.label} ${l.value}`).join(', ')}; ${result.stars} stars`);
    if (met) {
      expect(result.lines).toContainEqual({ label: 'Budget left', value: 10 * (budget - spent) });
      // One star on Rapier: the stars are the GPU solver's (onEngine marks them custom here); 3 for t3 blocks is retrofit.test.ts.
      expect(result.stars).toBe(1);
    } else expect(result.lines.map((l) => l.label)).not.toContain('Budget left');
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});

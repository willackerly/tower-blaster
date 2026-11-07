// Lost heritage reads as lost (PT28, agent playtest 2: the HUD said "28 cracked" over a cathedral that still
// looked whole, because a cracked block kept its teal). Under keystone.fx=damage a cracked heritage block
// flashes red and stays painted the lost red (scene.ts HERITAGE_LOST, COAT_PAINT), in every look, and Retry
// and Undo give it back its glaze. On L3 a marble from az 180 at pitch 311 cracks heritage block 37 (of 35,
// 37, 39) at step 34 on Rapier (the same steps on the page as in node: Rapier is deterministic per device);
// the physics is held at the break so the block is measured in place. The flash itself is read from the
// renderer's fx record at the break (a red glow that fades: Renderer.fxOf); that such a record draws a red
// flash brighter than the red it keeps is @tb/render's fx test (render.test 'FX tint, glow, flash'), on a
// fixed frame clock: here a SwiftShader frame can outlast the 0.9 s fade.
// Shared by heritage-lost-e2e.test.ts (candy, with Undo and Retry) and heritage-lost-looks-e2e.test.ts (hazy
// and real), two files so each stays inside a CI runner's per-file budget.
// Each block's colour is the mean OKLab of its own pixels (the ID pass of the same frame). Rapier, headless
// Chromium; the real look's grain off so a frame is a frame.
import { expect } from 'vitest';
import type { Page } from 'playwright';
import { compileLevel, L3, type Shot } from '@tb/keystone';
import { COAT_GLAZE, COAT_PAINT, linearToOklab, srgbToLinear } from '@tb/render';
import { HERITAGE_FLASH_GLOW, HERITAGE_FLASH_S, HERITAGE_LOST } from '../src/scene.ts';
import { ready } from './page.ts';

const MINUTES = 60_000;
export const c = compileLevel(L3);
const CRACK: Shot = { ammo: 'marble', az: 180, y: 8, yaw: 0, pitch: 311, power: 100 } as Shot;
const LOST = 37;
const KEPT = [35, 39];

interface Colour { L: number; hue: number; chroma: number; px: number }
/** Mean OKLab of each group's pixels in a frame drawn now, as lightness, hue (degrees) and chroma. */
async function colours(page: Page, groups: Record<string, readonly number[]>, atBreak = false): Promise<Record<string, Colour>> {
  // atBreak: run the physics a display frame at a time, each drawn, until the first heritage break, then hold
  // it and draw (a SwiftShader frame is slower than the steps: else Rapier knocks the block off the back of the
  // tower, out of the opening view, before a frame shows it).
  const s = await page.evaluate(async (wait) => {
    if (wait) {
      while (!(window.__game.state().heritageBroken > 0)) {
        window.__game.hold = false;
        await new Promise((r) => requestAnimationFrame(r));
        window.__game.hold = true;
        await window.__game.capture();
      }
    }
    return window.__game.capture(true);
  }, atBreak);
  if (!s?.pixels || !s.ids) throw new Error('no capture');
  const out: Record<string, Colour> = {};
  for (const [name, slots] of Object.entries(groups)) {
    const want = new Set(slots.map((k) => k + 1));
    let L = 0, a = 0, b = 0, n = 0;
    for (let i = 0; i < s.ids.length; i++) {
      if (!want.has(s.ids[i]!)) continue;
      const o = Math.floor(i / s.width) * s.pixels.bytesPerRow + 4 * (i % s.width);
      const lab = linearToOklab([0, 1, 2].map((k) => srgbToLinear(s.pixels!.data[o + k]! / 255)) as [number, number, number]);
      L += lab[0]; a += lab[1]; b += lab[2]; n++;
    }
    out[name] = { L: L / n, hue: ((((Math.atan2(b / n, a / n) * 180) / Math.PI) % 360) + 360) % 360, chroma: Math.hypot(a / n, b / n), px: n };
  }
  return out;
}
const hueGap = (x: number, y: number) => Math.abs(((((x - y) % 360) + 540) % 360) - 180);
/** Red: OKLCh hue within 40 degrees of 25 (the lost red is 29; the glaze is 176). */
const isRed = (h: Colour) => hueGap(h.hue, 25) < 40 && h.chroma > 0.05;
const isTeal = (h: Colour) => h.hue > 140 && h.hue < 210;
const groups = { lost: [LOST], kept: KEPT };
const settled = (page: Page, strokes: number) => page.waitForFunction((n) => window.__game.ready && window.__game.strokes === n && window.__game.phase !== 'running', strokes, { timeout: 3 * MINUTES, polling: 100 });

/** One look's run on its own page: crack heritage 37, check the flash's record and the lost red, and (withReset) that Undo and Retry give the glaze back. */
export async function runLook(game: { open: (url: string, timeout?: number) => Promise<{ page: Page; errors: string[] } | null> }, look: string, withReset: boolean): Promise<Record<string, unknown> | null> {
  const seen: Record<string, unknown> = {};
  const o = await game.open(`/?level=L3&engine=rapier&look=${look}&real.grain=0&offscreen=1&progress=off&door=0`, 5 * MINUTES);
  if (!o) return null;
  const { page } = o;
  await ready(page, 5 * MINUTES);
  expect(await page.evaluate(() => window.__game.feel.fx)).toBe('damage');
  const before = await colours(page, groups);
  expect(isTeal(before.lost!) && isTeal(before.kept!), JSON.stringify(before)).toBe(true);
  expect(await page.evaluate((x) => window.__game.fire(x), CRACK)).toBe(true);
  // The break, the physics held: the block red at once, its record a red flash; then, the flash over, the look it keeps.
  const flash = await colours(page, groups, true);
  const fx = (await page.evaluate((b) => window.__game.fxOf(b), LOST))!;
  expect(fx.coat).toBe(COAT_PAINT);
  fx.tint.forEach((x, k) => expect(x).toBeCloseTo(HERITAGE_LOST[k]!, 2));
  expect(fx.emissive).toBeCloseTo(HERITAGE_FLASH_GLOW, 2);
  expect(fx.flash).toBeCloseTo(HERITAGE_FLASH_S, 5);
  for (const k of KEPT) expect((await page.evaluate((b) => window.__game.fxOf(b), k))!.coat).toBe(COAT_GLAZE);
  await page.waitForTimeout(1500); // HERITAGE_FLASH_S is 0.9 s
  const after = await colours(page, groups);
  await page.evaluate(() => { window.__game.hold = false; });
  await settled(page, 1);
  expect(await page.evaluate(() => window.__game.state().heritageBroken)).toBe(1);
  seen[look] = { before, flash, after };
  // Lost: red, and unlike intact heritage in hue (the lit lightness of the two is close in candy: logged); the intact ones are still teal.
  expect(after.lost!.px, JSON.stringify(after)).toBeGreaterThan(30);
  expect(isRed(after.lost!), JSON.stringify(after)).toBe(true);
  expect(isTeal(after.kept!), JSON.stringify(after)).toBe(true);
  expect(hueGap(after.lost!.hue, after.kept!.hue)).toBeGreaterThan(90);
  expect(isRed(flash.lost!), JSON.stringify(flash)).toBe(true);
  if (withReset) {
    // Undo gives the glaze back (the restored world has no crack) ...
    expect(await page.evaluate(() => window.__game.undo())).toBe(true);
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 0, undefined, { timeout: 2 * MINUTES });
    const undone = await colours(page, groups);
    expect(isTeal(undone.lost!), JSON.stringify(undone)).toBe(true);
    expect((await page.evaluate((b) => window.__game.fxOf(b), LOST))!).toMatchObject({ coat: COAT_GLAZE, emissive: 0 });
    // ... and so does Retry, after the block was lost again.
    expect(await page.evaluate((x) => window.__game.fire(x), CRACK)).toBe(true);
    expect(isRed((await colours(page, groups, true)).lost!)).toBe(true);
    await page.evaluate(() => { window.__game.hold = false; });
    await settled(page, 1);
    await page.evaluate(() => window.__game.retry());
    await page.waitForFunction(() => window.__game.ready && window.__game.strokes === 0, undefined, { timeout: 2 * MINUTES });
    const retried = await colours(page, groups);
    expect(isTeal(retried.lost!), JSON.stringify(retried)).toBe(true);
    expect((await page.evaluate((b) => window.__game.fxOf(b), LOST))!).toMatchObject({ coat: COAT_GLAZE, emissive: 0 });
    seen.reset = { undone, retried };
  }
  expect(o.errors).toEqual([]);
  await page.close();
  return seen;
}

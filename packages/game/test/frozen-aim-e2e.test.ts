// Bullet Time keeps what you aim at (agent playtest PT33, docs/game/bullet-time-undercut-polish.md): while frozen the
// grade drains the world but the crowns keep their colour (the scene's keep mask, post.ts), and the aim stays up with no
// pointer (a freeze from the HUD or a key, a finger lifted): it holds on a standing crown, so the frozen frame shows the
// arc and the impact marker. keystone.frozenaim=0 (read live) drains the crowns with the rest. Rapier, headless Chromium.
import { describe, expect, it } from 'vitest';
import { compileLevel, L1, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const game = gamePage();
/** A marble well wide of the tower (it runs a while, and the crowns stand). */
const miss: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30 };
const URL = '/?level=L1&engine=rapier&look=candy&offscreen=1&keystone.rapid=0&keystone.freeze=1';

type Capture = { width: number; height: number; pixels?: { data: number[]; bytesPerRow: number } } | null;

/** Mean saturation (HSV) and saturation-weighted circular mean hue (degrees) of the pixels at `at` (all when absent). */
function colour(p: Capture, at?: readonly number[]) {
  const px = p!.pixels!, w = p!.width;
  let s = 0, hx = 0, hy = 0, n = 0;
  const one = (i: number) => {
    const o = Math.floor(i / w) * px.bytesPerRow + 4 * (i % w), r = px.data[o]!, g = px.data[o + 1]!, b = px.data[o + 2]!;
    const mx = Math.max(r, g, b), d = mx - Math.min(r, g, b), sat = mx > 0 ? d / mx : 0;
    s += sat;
    n++;
    if (d === 0) return;
    const h = (mx === r ? ((g - b) / d + 6) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 * (Math.PI / 180);
    hx += sat * Math.cos(h);
    hy += sat * Math.sin(h);
  };
  if (at) at.forEach(one);
  else for (let i = 0; i < w * p!.height; i++) one(i);
  return { sat: s / n, hue: ((Math.atan2(hy, hx) * 180) / Math.PI + 360) % 360 };
}
const hueGap = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));

describe('Bullet Time keeps what you aim at (PT33)', () => {
  it('frozen with no pointer: the aim holds on a crown (arc and marker drawn), the crowns keep their gold while the rest drains; frozenaim off drains them too', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open(URL);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await ready(page);
    expect(await page.evaluate(() => window.__game.feel.frozenAim)).toBe(true);
    const start = await page.evaluate(() => window.__game.stepIndex);
    expect(await page.evaluate((s) => window.__game.fire(s), miss)).toBe(true);
    await page.waitForFunction((n) => window.__game.stepIndex >= n, start + 10, { timeout: 60_000, polling: 20 });
    // Nothing has aimed on this page (no pointer ever): unfrozen, a running shot shows no aim.
    expect(await page.evaluate(() => window.__game.input.aimed)).toBeNull();
    expect(await page.evaluate(() => window.__game.freeze(true))).toBe(true);
    await page.waitForFunction(() => window.__game.frozenGrade === 1, undefined, { timeout: 30_000, polling: 50 });
    // The held aim: a shot aimed (at a crown), its impact marker and arc drawn in the frozen frame.
    // (view.impact: the marker was drawn, which it is only over the aim's beads.)
    await page.waitForFunction(() => window.__game.view.impact, undefined, { timeout: 30_000, polling: 50 });
    const c = compileLevel(L1), crowns = c.meta.crowns;
    const aim = await page.evaluate(() => ({ aimed: window.__game.input.aimed, impact: window.__game.impact }));
    expect(aim.aimed).not.toBeNull();
    expect(aim.impact).not.toBeNull();
    expect(aim.impact!.opener).toBe(false);
    expect(crowns, 'the held aim is on a crown').toContain(aim.impact!.body);
    // The crowns' pixels (the ID pass, the same frozen view as every capture below).
    const masks = await page.evaluate((cs) => Promise.all(cs.map((b) => window.__game.pixelsOf(b))), [...crowns]);
    const at = masks.flatMap((m) => m.at);
    expect(at.length, 'crown pixels in view').toBeGreaterThan(40);
    const kept = await page.evaluate(() => window.__game.capture(true));
    expect([kept!.width, kept!.height]).toEqual([masks[0]!.width, masks[0]!.height]);
    // The keep off (read live): the same graded frame, the crowns drained with the rest.
    await page.evaluate(() => { window.__game.feel.frozenAim = false; });
    const f0 = await page.evaluate(() => window.__game.frames);
    await page.waitForFunction((n) => window.__game.frames >= n + 2, f0, { timeout: 30_000, polling: 20 });
    const drained = await page.evaluate(() => window.__game.capture(true));
    // No grade at all (the frozen look off): the frame as it runs.
    await page.evaluate(() => { window.__game.feel.frozenAim = true; window.__game.feel.frozenLook = false; });
    await page.waitForFunction(() => window.__game.frozenGrade === 0, undefined, { timeout: 30_000, polling: 50 });
    const plain = await page.evaluate(() => window.__game.capture(true));
    const crownSet = new Set(at), rest: number[] = [];
    for (let i = 0; i < kept!.width * kept!.height; i++) if (!crownSet.has(i)) rest.push(i);
    const m = {
      plain: { crown: colour(plain, at), rest: colour(plain, rest) },
      kept: { crown: colour(kept, at), rest: colour(kept, rest) },
      drained: { crown: colour(drained, at) },
    };
    const msg = JSON.stringify(m);
    console.log(`PT33 crown keep: ${msg} impact body ${aim.impact!.body} crowns ${[...crowns]}`);
    expect(m.plain.crown.sat, msg).toBeGreaterThan(0.3);
    // Kept: the crowns' colour stays (saturation and hue), the rest of the frame drains.
    expect(m.kept.crown.sat, msg).toBeGreaterThan(0.85 * m.plain.crown.sat);
    expect(hueGap(m.kept.crown.hue, m.plain.crown.hue), msg).toBeLessThan(12);
    expect(m.kept.rest.sat, msg).toBeLessThan(0.8 * m.plain.rest.sat); // measured 0.67 (the fired marble and the aim's beads keep too)
    // Off: the crowns drain like everything else.
    expect(m.drained.crown.sat, msg).toBeLessThan(0.6 * m.plain.crown.sat);
    expect(errors).toEqual([]);
    await page.close();
  }, 300_000);
});

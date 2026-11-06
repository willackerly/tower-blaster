// Quality tiers on the game page (roadmap P1, docs/game/quality-tiers.md), in headless Chromium:
// SwiftShader stands in for the low tier. The probe on load names it low (a software adapter) well under
// a second; measured instead of named, it is still low (its physics leaves no frame budget); the tier's
// knobs reach the renderer, the canvas size and the frame governor; an offscreen page keeps high unless
// the URL asks for the probe; the door's Quality row applies at once, is stored and drops ?quality=.
import { describe, expect, it } from 'vitest';
import { gamePage } from './page.ts';

const game = gamePage();
const MINUTES = 60_000;
const real = Boolean(process.env.TB_CHANNEL);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[xs.length >> 1]!;

describe('quality tiers', () => {
  it('SwiftShader: the probe on load picks low in under a second, and low\'s knobs are in effect', async (ctx) => {
    if (!game.browser() || real) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off&quality=auto', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    const s = await page.evaluate(() => ({ quality: window.__game.quality, maxDpr: window.__game.maxDpr, frames: window.__game.feel.frames }));
    console.log(`probe on load: ${JSON.stringify(s.quality?.probe)} (software: not a performance result)`);
    expect(s.quality).toMatchObject({ setting: 'auto', tier: 'low', reason: 'software', probed: 'low', knobs: { maxDpr: 0.5, shadow: true, ao: false, sparks: false, frames: 'auto' } });
    expect(s.quality!.probe!.ms).toBeLessThan(1000);
    expect(s.maxDpr).toBe(0.5);
    expect(s.frames).toBe('auto');
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('SwiftShader measured, not named: its 1k step leaves no frame budget, so low, in under a second', async (ctx) => {
    if (!game.browser() || real) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off&quality=high', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page } = o;
    // A string, so the page's own module graph (Vite) resolves the imports, not this file's.
    const p = await page.evaluate(`(async () => {
      const g = await import('/src/quality-probe.ts');
      const { createDevice } = await import('/@id/@tb/gpu');
      const { device, adapter } = await createDevice({ timestamps: false });
      try { return await g.probeQuality(device, adapter, 640, 400, 1, { measureSoftware: true }); } finally { device.destroy(); }
    })()`) as import('../src/quality.ts').ProbeResult & import('../src/quality.ts').TierPick;
    console.log(`measured probe: ${JSON.stringify(p)} (software: not a performance result)`);
    expect(p).toMatchObject({ software: false, tier: 'low', reason: 'physics' });
    expect(p.dispatchMs).toBeGreaterThan(0);
    expect(p.stepMs).toBeGreaterThan(1000 / 60);
    expect(p.ms).toBeLessThan(1000);
    await page.close();
  }, 5 * MINUTES);

  it('an offscreen page keeps high with no probe; ?quality=low and mid set their knobs; keystone.frames wins', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const read = (search: string) => game.open(search, 2 * MINUTES).then(async (o) => {
      if (!o) return null;
      const r = await o.page.evaluate(() => ({ q: window.__game.quality, maxDpr: window.__game.maxDpr, frames: window.__game.feel.frames }));
      expect(o.errors).toEqual([]);
      await o.page.close();
      return r;
    });
    const plain = await read('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off');
    if (!plain) return ctx.skip();
    expect(plain).toEqual({ q: { setting: 'auto', tier: 'high', reason: 'offscreen', probed: null, probe: null, knobs: { maxDpr: 2, shadow: true, ao: true, sparks: true, frames: 'all' } }, maxDpr: 2, frames: 'all' });
    expect(await read('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off&quality=low')).toMatchObject({ q: { setting: 'low', tier: 'low', reason: 'setting', probe: null }, maxDpr: 0.5, frames: 'auto' });
    expect(await read('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off&quality=mid&sharp=1')).toMatchObject({ q: { tier: 'mid' }, maxDpr: 1, frames: 'auto' });
    expect(await read('/?level=L1&engine=rapier&offscreen=1&door=0&progress=off&quality=mid&keystone.frames=all')).toMatchObject({ q: { tier: 'mid' }, frames: 'all' });
  }, 5 * MINUTES);

  it('the tier\'s toggles reach the renderer: the same still view drawn high, low, high again', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=1&progress=off&quality=high', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.waitForFunction(() => window.__game.ready, undefined, { timeout: 2 * MINUTES, polling: 250 });
    await page.locator('.kg-door [data-act="advanced"]').click();
    const shot = async (q: string) => {
      await page.locator(`.kg-door [data-act="quality"][data-arg="${q}"]`).click();
      return page.evaluate(async () => {
        const s = (await window.__game.capture(true))!;
        return { luma: s.meanLuma, data: s.pixels!.data, stride: s.pixels!.bytesPerRow, w: s.width, h: s.height };
      });
    };
    const first = await shot('high'), high = await shot('high'), low = await shot('low'), again = await shot('high');
    /** Share of pixels whose colour moved by more than 2 levels in any channel. */
    const moved = (x: typeof high, y: typeof high) => {
      let n = 0;
      for (let r = 0; r < x.h; r++) for (let c = 0; c < x.w; c++) {
        const i = r * x.stride + 4 * c;
        if (Math.abs(x.data[i]! - y.data[i]!) > 2 || Math.abs(x.data[i + 1]! - y.data[i + 1]!) > 2 || Math.abs(x.data[i + 2]! - y.data[i + 2]!) > 2) n++;
      }
      return n / (x.w * x.h);
    };
    const same = moved(high, again), tiered = moved(high, low);
    console.log(`first two: ${(100 * moved(first, high)).toFixed(2)}%`);
    console.log(`L1 still view: ${(100 * tiered).toFixed(2)}% of pixels moved high -> low, ${(100 * same).toFixed(2)}% high -> high`);
    expect(same).toBeLessThan(0.001);
    expect(tiered).toBeGreaterThan(0.01);
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  it('the door\'s Quality row: applies at once, is stored, drops ?quality=, and Auto names the probe\'s tier', async (ctx) => {
    if (!game.browser()) return ctx.skip();
    const o = await game.open('/?level=L1&engine=rapier&offscreen=1&door=1&progress=on&quality=auto', 2 * MINUTES);
    if (!o) return ctx.skip();
    const { page, errors } = o;
    await page.locator('.kg-door [data-act="advanced"]').click();
    const probed = await page.evaluate(() => window.__game.quality!.probed);
    const names = { high: 'High', mid: 'Medium', low: 'Low' } as const;
    expect(await page.locator('.kg-door [data-act="quality"].on').innerText()).toBe(`Auto (${names[probed!]})`);
    await page.locator('.kg-door [data-act="quality"][data-arg="mid"]').click();
    expect(await page.evaluate(() => [window.__game.quality!.tier, window.__game.quality!.reason, window.__game.maxDpr, window.__game.feel.frames])).toEqual(['mid', 'setting', 1, 'auto']);
    expect(new URLSearchParams(await page.evaluate(() => location.search)).has('quality')).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('tb.settings.v1')!).quality)).toBe('mid');
    await page.locator('.kg-door [data-act="quality"][data-arg="high"]').click();
    expect(await page.evaluate(() => [window.__game.quality!.tier, window.__game.maxDpr, window.__game.feel.frames])).toEqual(['high', 2, 'all']);
    // Auto again: the probe's tier from load (no second probe).
    await page.locator('.kg-door [data-act="quality"][data-arg="auto"]').click();
    expect(await page.evaluate(() => window.__game.quality!.tier)).toBe(probed);
    await page.evaluate(() => localStorage.clear());
    expect(errors).toEqual([]);
    await page.close();
  }, 5 * MINUTES);

  // The M5 check (bench queue; TB_CHANNEL=chrome on the Mac, Metal, out of Low Power Mode): Will's screen
  // (1728 x 1117 CSS points at 2x) picks high in under a second, and the step proxy is checked against B1's
  // real steps on the GPU solver. Prints both for docs/game/quality-tiers.md.
  it('Metal: the M5 picks high at 2x in under a second; the step proxy against B1\'s real steps', async (ctx) => {
    if (!game.browser() || !real) return ctx.skip();
    const o = await game.open('/?level=B1&engine=gpu&door=0&progress=off&quality=auto', 5 * MINUTES, { viewport: { width: 1728, height: 1117 }, deviceScaleFactor: 2 });
    if (!o) return ctx.skip();
    const { page, errors } = o;
    const q = (await page.evaluate(() => window.__game.quality))!;
    console.log(`M5 probe: ${JSON.stringify(q.probe)}`);
    expect(q.tier).toBe('high');
    expect(q.probe!.ms).toBeLessThan(1000);
    await page.waitForFunction(() => window.__game.ready, undefined, { timeout: 5 * MINUTES, polling: 250 });
    await page.evaluate(() => { window.__game.fireOpener(); });
    await page.waitForTimeout(5000);
    const cost = median(await page.evaluate(() => window.__game.timing.costMs.slice(-240)));
    console.log(`B1 step on the GPU solver: median ${cost.toFixed(2)} ms measured, ${q.probe!.stepMs.toFixed(2)} ms predicted (ratio ${(q.probe!.stepMs / cost).toFixed(2)})`);
    expect(q.probe!.stepMs / cost).toBeGreaterThan(1 / 3);
    expect(q.probe!.stepMs / cost).toBeLessThan(3);
    expect(errors).toEqual([]);
    await page.close();
  }, 10 * MINUTES);
});

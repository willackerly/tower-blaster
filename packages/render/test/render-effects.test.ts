// Effects that follow the damage (PT2, docs/render/damage-effects.md): the spark rule's CPU twins (a
// ball's own impact a puff, life and brightness by strength, the live-spark bucket), and on the GPU
// the bucket against its twin, Sparks.reset, Renderer.resetEffects with effectStats, a ball's flash
// share, and the heat glow's rim. Headless Chromium (SwiftShader without a GPU); correctness only.
import { describe, expect, it } from 'vitest';
import { CLASSIC_SPARKS, DEFAULT_LIGHTS, DEFAULT_SPARKS, MATERIAL, MAX_PER_EVENT, SPAWN_BUDGET, newSparkReference, sparkBucketReference, sparkClass, sparkCount, sparkGlow, sparkLife, type Impact } from '../src/index.ts';
import { gpu, call } from './harness.ts';

const block = (strength: number): Impact => ({ pos: [0, 1, 0], dir: [1, 0, 0], strength, packed: 7 });
const ballHit = (strength: number): Impact => ({ pos: [0, 1, 0], dir: [1, 0, 0], strength, packed: 9 | (MATERIAL.ball << 28) });

describe('the spark rule (CPU)', () => {
  it("a ball's own impact throws at most ballSparks, class 0; a block's scales with its speed change", () => {
    expect(sparkCount(ballHit(20), DEFAULT_SPARKS)).toBe(DEFAULT_SPARKS.ballSparks);
    expect(sparkCount(ballHit(20), CLASSIC_SPARKS)).toBe(Math.floor((20 - 2.5) * 24)); // classic: in full
    expect(sparkCount(block(20), DEFAULT_SPARKS)).toBe(Math.floor((20 - 2.5) * 24));
    expect(sparkCount(block(60), DEFAULT_SPARKS)).toBe(MAX_PER_EVENT);
    expect(sparkClass(ballHit(20), DEFAULT_SPARKS)).toBe(0);
    expect([2.5, 3.3, 8.5, 14.5, 40].map((s) => sparkClass(block(s), DEFAULT_SPARKS))).toEqual([0, 1, 7, 15, 15]);
  });

  it('life and brightness grow with the class; classic sparks keep their life and full brightness', () => {
    const at = (strength: number, p = DEFAULT_SPARKS) => newSparkReference(block(strength), 3, 11, p).packed;
    const weak = at(3), strong = at(30), classic = at(3, CLASSIC_SPARKS);
    const life0 = (packed: number) => 0.4 + (0.8 * (packed & 0xff)) / 255;
    expect(sparkLife(strong)).toBeCloseTo(life0(strong), 6); // class 15: full life
    expect(sparkLife(weak) / life0(weak)).toBeCloseTo(0.35, 6); // class 0: 0.35 of it
    expect(sparkGlow(weak)).toBeCloseTo(0.45, 6);
    expect(sparkGlow(strong)).toBeCloseTo(1, 6);
    expect(sparkLife(classic)).toBeCloseTo(life0(classic), 6);
    expect(sparkGlow(classic)).toBe(1);
    expect((classic >>> 12) & 1).toBe(0);
  });

  it('the bucket: a frame spawns at most budget, a long flood is held to rate, and it refills when quiet', () => {
    const flood = Array.from({ length: 64 }, (_, i) => block(10 + (i % 20)));
    const frames = [...Array.from({ length: 120 }, () => ({ events: flood, dt: 1 / 60 })), ...Array.from({ length: 60 }, () => ({ events: [], dt: 1 / 60 })), { events: flood, dt: 1 / 60 }];
    const r = sparkBucketReference(frames, DEFAULT_SPARKS);
    expect(r.perFrame[0]).toBe(DEFAULT_SPARKS.budget);
    expect(Math.max(...r.perFrame)).toBe(DEFAULT_SPARKS.budget);
    // Over the 2 s of flood: the budget, then the rate (to within a frame's rounding).
    const spent = r.perFrame.slice(0, 120).reduce((a, b) => a + b, 0);
    expect(spent).toBeGreaterThan(DEFAULT_SPARKS.budget + DEFAULT_SPARKS.rate * (119 / 60) - 120);
    expect(spent).toBeLessThanOrEqual(DEFAULT_SPARKS.budget + DEFAULT_SPARKS.rate * (119 / 60));
    expect(r.perFrame[180]).toBe(DEFAULT_SPARKS.budget); // a second of quiet refills it (rate x 1 s > budget)
    // Classic: SPAWN_BUDGET every frame.
    expect(sparkBucketReference(frames.slice(0, 3), CLASSIC_SPARKS).perFrame).toEqual([SPAWN_BUDGET, SPAWN_BUDGET, SPAWN_BUDGET]);
  });
});

describe('damage effects on the GPU', () => {
  it('the bucket spawns as its twin does, frame by frame', async (ctx) => {
    if (!gpu) return ctx.skip();
    for (const [dt, config] of [[1 / 60, {}], [0.1, { budget: 700, rate: 1500 }]] as const) {
      const r = await call('sparkBucket', 40, dt, config);
      expect(r.error).toBeNull();
      expect(r.got).toEqual(r.want.perFrame);
      expect(r.total).toBe(r.want.total);
      expect(r.got[0]).toBe(r.config.budget);
      // Live sparks stay under budget + rate x the longest life (1.2 s).
      expect(Math.max(...r.alive)).toBeLessThanOrEqual(r.config.budget + r.config.rate * 1.2 + r.config.budget);
    }
  });

  it('Sparks.reset kills every particle, cools every body, drops queued impacts and zeroes the counts', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('sparkReset');
    expect(r.error).toBeNull();
    expect(r.before.spawned).toBeGreaterThan(100);
    expect(r.before.hot).toBe(4);
    expect(r.before.heat.slice(0, 4).every((h) => h > 0.5)).toBe(true);
    expect(r.reset).toEqual({ alive: 0, hot: 0, total: 0, tokens: r.budget * 256, dead: true, heat: r.reset.heat.map(() => 0) });
    // The next frame: the bodies are unseen, so their new speeds are no impact; the dropped burst never spawns.
    expect(r.after).toEqual({ events: 0, spawned: 0, alive: 0, hot: 0, total: 0 });
  });

  it('Renderer.resetEffects leaves no particle, heat, flash, blast or fuse', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('effectsReset');
    expect(r.error).toBeNull();
    expect(r.live.particles).toBeGreaterThan(50);
    expect(r.live.spawned).toBeGreaterThan(50);
    expect(r.live.hot).toBe(1);
    expect(r.live.flashes).toBeGreaterThan(0);
    expect([r.live.blasts, r.live.fuses]).toEqual([1, 1]);
    expect(r.reset).toEqual({ particles: 0, hot: 0, spawned: 0, flashes: 0, blasts: 0, fuses: 0 });
    expect(r.next).toEqual({ particles: 0, hot: 0, spawned: 0, flashes: 0, blasts: 0, fuses: 0 });
  });

  it("a ball's own impact bids for a flash at ballFlash of its strength, a block's in full", async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await call('ballFlash');
    expect(r.error).toBeNull();
    expect(r.slots[0]).not.toBe(r.slots[1]);
    expect(r.share).toBe(DEFAULT_LIGHTS.ballFlash);
    expect(r.block).toBeCloseTo(r.full, 2); // 15 m/s = flashFull: full
    expect(r.ball).toBeCloseTo(r.full * DEFAULT_LIGHTS.ballFlash, 2);
    const c = await call('ballFlash', true);
    expect(c.ball).toBeCloseTo(c.full, 2);
  });

  it('the rim glow brightens a hit block along its edges and never turns it white; classic washes it white', async (ctx) => {
    if (!gpu) return ctx.skip();
    const rim = await call('heatRim', 'damage');
    const classic = await call('heatRim', 'classic');
    for (const r of [rim, classic]) { expect(r.error).toBeNull(); expect(r.n).toBeGreaterThan(1500); expect(r.midN).toBeGreaterThan(300); }
    console.log(`heat rim: rim +${rim.rim.toFixed(1)} mid +${rim.mid.toFixed(1)} white ${rim.white}/${rim.n}; classic rim +${classic.rim.toFixed(1)} mid +${classic.mid.toFixed(1)} white ${classic.white}`);
    expect(rim.white).toBe(0);
    expect(classic.white).toBeGreaterThan(0.3 * classic.n);
    expect(rim.rim).toBeGreaterThan(20); // it shows
    expect(rim.rim).toBeGreaterThan(1.5 * rim.mid); // along the edges more than in the middle
  });
});

// Blasts (blasts.ts): the timeline on the CPU, and what a blast draws in
// headless Chromium (SwiftShader without a GPU). Correctness only.
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadBundle, openWebGPU, type WebGPUSession } from '@tb/testkit';
import { bakeBlastNoise, blastState, Blasts, DEFAULT_BLASTS, durationScale, MAX_BLASTS, NOISE_SIZE } from '../src/blasts.ts';
import type * as Drivers from './blasts-page.ts';

const p = DEFAULT_BLASTS;
const at = (age: number, radius = p.sizeRef) => blastState([1, 2, 3], radius, age, p);

describe('blast timeline (blastState)', () => {
  it('the shock shell runs out to exactly the blast radius, then drifts on to overshoot x it as it fades, then is gone', () => {
    expect(at(0).shockR).toBe(0);
    expect(at(p.shock / 2).shockR).toBeGreaterThan(0.5 * p.sizeRef);
    expect(at(p.shock).shockR).toBeCloseTo(p.sizeRef, 12);
    expect(at(p.shock).shockA).toBe(1);
    expect(at(p.shock + p.shockHold / 2).shockR).toBeCloseTo(p.sizeRef * (1 + (p.overshoot - 1) / 2), 12);
    expect(at(p.shock + p.shockHold / 2).shockA).toBeCloseTo(0.5, 12);
    expect(at(p.shock + p.shockHold + 0.01).shockA).toBe(0);
    let last = -1;
    for (let a = 0; a <= p.shock + p.shockHold; a += p.shock / 50) { const r = at(a).shockR; expect(r).toBeGreaterThanOrEqual(last); last = r; }
  });

  it('the fireball grows to `fire` x the radius, burns down, then thins to nothing', () => {
    // Already big on its first frame.
    expect(at(0).fireR).toBeCloseTo(p.start * p.fire * p.sizeRef, 12);
    expect(at(p.grow).fireR).toBeCloseTo(p.fire * p.sizeRef, 12);
    expect(at(p.smoke - 1e-6).fireR).toBeLessThanOrEqual((1 + p.swell) * p.fire * p.sizeRef + 1e-9);
    expect(at(0.5 * p.grow).heat).toBe(1);
    expect(at(p.grow + p.burn).heat).toBe(0);
    expect(at(p.grow + p.burn).density).toBe(1);
    expect(at(p.smoke - 1e-6).density).toBeLessThan(1e-6);
    expect(at(p.smoke).alive).toBe(false);
    expect(at(p.smoke).fireR).toBe(0);
    expect(at(-0.1).alive).toBe(false);
    // It rises once grown; the shell's centre is not the fireball's business.
    expect(at(p.grow).centre).toEqual([1, 2, 3]);
    expect(at(p.grow + 1).centre[1]).toBeCloseTo(2 + p.rise * p.sizeRef, 12);
  });

  it('the light peaks after a short attack, scales with radius squared, decays with lightTau, reaches `reach` radii', () => {
    const peak = at(0.025).light;
    expect(peak).toBeCloseTo(p.light * p.sizeRef ** 2, 9);
    expect(at(0.0125).light).toBeCloseTo(peak / 2, 9);
    expect(at(0.025 + p.lightTau).light / peak).toBeCloseTo(Math.exp(-1), 9);
    // Bigger blasts last longer (cube root), so compare at the same scaled age.
    const big = 2 * p.sizeRef, k = durationScale(big);
    expect(blastState([0, 0, 0], big, 0.025, p).light / peak).toBeCloseTo(4, 9);
    expect(blastState([0, 0, 0], big, 0.025 + p.lightTau * k, p).light / (4 * peak)).toBeCloseTo(Math.exp(-1), 9);
    expect(at(0.1).lightR).toBe(p.reach * p.sizeRef);
    expect(blastState([0, 0, 0], 5, 0.1, { ...p, light: 0 }).light).toBe(0);
  });

  it('durations scale with the cube root of the radius, clamped to 0.5..2', () => {
    expect(durationScale(p.sizeRef)).toBe(1);
    expect(durationScale(8 * p.sizeRef)).toBeCloseTo(2, 12);
    expect(durationScale(1000 * p.sizeRef)).toBe(2);
    expect(durationScale(p.sizeRef / 1000)).toBe(0.5);
    const big = 8 * p.sizeRef;
    expect(blastState([0, 0, 0], big, 2 * p.shock, p).shockR).toBeCloseTo(big, 9);
    expect(blastState([0, 0, 0], big, p.smoke * 2 - 1e-6, p).alive).toBe(true);
  });
});

describe('Blasts (CPU side)', () => {
  const blasts = () => new Blasts({} as GPUDevice);

  it('keeps at most MAX_BLASTS, retiring the oldest, and retires blasts that are over', () => {
    const b = blasts();
    for (let i = 0; i < MAX_BLASTS + 3; i++) b.add([i, 0, 0], 5, i * 0.01);
    expect(b.blasts.length).toBe(MAX_BLASTS);
    expect(b.blasts[0]!.centre[0]).toBe(3);
    expect(b.states(0.5).length).toBe(MAX_BLASTS);
    expect(b.states(10).length).toBe(0);
    expect(b.blasts.length).toBe(0);
  });

  it('refuses blasts with no reach or a non-finite centre', () => {
    const b = blasts();
    b.add([0, 0, 0], 0, 0);
    b.add([Number.NaN, 0, 0], 5, 0);
    b.add([0, 0, 0], -1, 0);
    expect(b.blasts.length).toBe(0);
  });
});

describe('blast noise (bakeBlastNoise)', () => {
  const n = NOISE_SIZE, tex = bakeBlastNoise();
  const v = (x: number, y: number, z: number, c: number) => tex[4 * (((z + n) % n) * n * n + ((y + n) % n) * n + ((x + n) % n)) + c]!;

  it('uses the full range in each of its four channels, and the channels are independent', () => {
    for (let c = 0; c < 4; c++) {
      let lo = 255, hi = 0;
      for (let i = 0; i < n ** 3; i++) { lo = Math.min(lo, tex[4 * i + c]!); hi = Math.max(hi, tex[4 * i + c]!); }
      expect([lo, hi]).toEqual([0, 255]);
    }
    let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
    const N = n ** 3;
    for (let i = 0; i < N; i++) { const a = tex[4 * i]!, b = tex[4 * i + 1]!; sx += a; sy += b; sxy += a * b; sxx += a * a; syy += b * b; }
    const corr = (sxy / N - (sx / N) * (sy / N)) / Math.sqrt((sxx / N - (sx / N) ** 2) * (syy / N - (sy / N) ** 2));
    expect(Math.abs(corr)).toBeLessThan(0.05);
  });

  it('is smooth and tiles: steps across the wrap are like steps inside', () => {
    let inner = 0, wrap = 0, k = 0;
    for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) {
      inner += Math.abs(v(n / 2, y, z, 0) - v(n / 2 - 1, y, z, 0));
      wrap += Math.abs(v(0, y, z, 0) - v(n - 1, y, z, 0));
      k++;
    }
    expect(inner / k).toBeLessThan(25); // smooth: white noise would step ~85 on average
    expect(wrap / k).toBeLessThan(1.5 * (inner / k));
  });
});

let gpu: WebGPUSession | null = null;
beforeAll(async () => {
  gpu = await openWebGPU();
  if (gpu) await loadBundle(gpu.page, fileURLToPath(new URL('./blasts-page.ts', import.meta.url)), '__blasts');
}, 120_000);
afterAll(async () => { await gpu?.close(); });

const frames = (c: Parameters<typeof Drivers.blastFrames>[0]) =>
  gpu!.page.evaluate((cc) => (window as unknown as { __blasts: typeof Drivers }).__blasts.blastFrames(cc), c);

describe('blasts on the GPU', () => {
  it('no blast: nothing compiled, the frame unchanged; a hot blast: a bright orange fireball inside its silhouette only, and the box beside it lit', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look: 'candy', age: 0.15 });
    expect(r.error).toBeNull();
    expect(r.compiledBefore).toBe(false);
    expect(r.offDiff).toBe(0);
    expect(r.outsideChanged).toBe(0);
    const [red, green, blue] = r.coreRgb as [number, number, number];
    expect(red).toBeGreaterThan(200);
    // White-hot at the middle to orange: warm on average, never blue.
    expect(red).toBeGreaterThanOrEqual(green);
    expect(red).toBeGreaterThan(blue + 20);
    expect(r.core).toBeGreaterThan(60);
    expect(r.boxSide.n).toBeGreaterThan(20);
    // Outside the shell, so only the blast's light can brighten it.
    expect(r.boxSide.after).toBeGreaterThan(r.boxSide.before + 5);
  });

  it('the shock shell alone: changes nothing outside the blast radius, and is brightest at its rim', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look: 'candy', age: DEFAULT_BLASTS.shock, shellOnly: true });
    expect(r.error).toBeNull();
    expect(r.outsideChanged).toBe(0);
    expect(r.rim).toBeGreaterThan(8);
    // (Display values: the tone curve lifts the faint middle over a dark sky more than the bright rim.)
    expect(r.rim).toBeGreaterThan(2 * Math.max(r.core, 0.5));
  });

  it('a box in front hides the fire behind it', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look: 'candy', age: 0.15, blocker: true });
    expect(r.error).toBeNull();
    expect(r.blocker.n).toBeGreaterThan(50);
    // Its camera-facing face looks away from the blast: no fire, no light on it.
    expect(Math.abs(r.blocker.after - r.blocker.before)).toBeLessThan(1);
  });

  it('the real look (no stylized effects): the fireball and its light still show', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await frames({ look: 'real', age: 0.15 });
    expect(r.error).toBeNull();
    expect(r.compiledBefore).toBe(false);
    expect(r.offDiff).toBe(0);
    expect(r.outsideChanged, JSON.stringify(r.outsideAt)).toBe(0);
    expect(r.core).toBeGreaterThan(40);
    expect(r.boxSide.after).toBeGreaterThan(r.boxSide.before + 5);
  });
});

describe('lit fuses on the GPU (fuses.ts)', () => {
  it('nothing compiled or changed until a body is marked; a dark cord up from its top to a warm spark; nothing once it is removed or unmarked', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpu.page.evaluate(() => (window as unknown as { __blasts: typeof Drivers }).__blasts.fuseFrames());
    expect(r.error).toBeNull();
    expect(r.compiledBefore).toBe(false);
    expect(r.topGain).toBeGreaterThan(60);
    // The spark sits at the cord's end, above the ball's top (screen y grows downward), not on it.
    expect(r.sparkAt[1]!, JSON.stringify(r.sparkAt)).toBeLessThanOrEqual(-4);
    // The cord darkens the bright sky behind it.
    expect(r.cordDark).toBeLessThan(-20);
    const [red, , blue] = r.topRgb as [number, number, number];
    expect(red).toBeGreaterThan(blue);
    expect(r.removedDiff).toBe(0);
    expect(r.unmarkedDiff).toBe(0);
  });
});

describe('blast reach zone on the GPU (reach.ts)', () => {
  it('nothing compiled until shown; a red edge at the radius and a red crosshair at the centre; faint behind a box; nothing outside the sphere; gone when hidden', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await gpu.page.evaluate(() => (window as unknown as { __blasts: typeof Drivers }).__blasts.reachFrames());
    expect(r.error).toBeNull();
    expect(r.compiledBefore).toBe(false);
    expect(r.shown).toEqual({ centre: [0, 2, -10], radius: 2 });
    expect(r.visible.n).toBeGreaterThan(20);
    expect(r.blocked.n).toBeGreaterThan(0);
    // The edge: clearly redder (red over green, display values).
    expect(r.visible.r, JSON.stringify(r)).toBeGreaterThan(25);
    // Behind the box the edge still shows, fainter.
    expect(r.blocked.r, JSON.stringify(r.blocked)).toBeGreaterThan(3);
    expect(r.blocked.r).toBeLessThan(r.visible.r);
    expect(r.centre.r, JSON.stringify(r.centre)).toBeGreaterThan(25);
    expect(r.outsideChanged).toBe(0);
    expect(r.hiddenDiff).toBe(0);
  });
});

describe('blast options (URL keys)', () => {
  it('default on at DEFAULT_BLASTS; blast=0 turns them off; blast.<knob> sets one; round-trips', async () => {
    const { parseBlastOptions, writeBlastOptions } = await import('../src/blasts.ts');
    expect(parseBlastOptions(new URLSearchParams())).toEqual({ on: true, params: DEFAULT_BLASTS });
    const o = parseBlastOptions(new URLSearchParams('blast=0&blast.glow=4&blast.light=0'));
    expect(o).toEqual({ on: false, params: { ...DEFAULT_BLASTS, glow: 4, light: 0 } });
    const q = new URLSearchParams();
    writeBlastOptions(o, q);
    expect(q.toString()).toBe('blast=0&blast.glow=4&blast.light=0');
    expect(parseBlastOptions(q)).toEqual(o);
    const none = new URLSearchParams();
    writeBlastOptions(parseBlastOptions(none), none);
    expect(none.toString()).toBe('');
  });

  it('refuses bad values and unknown knobs', async () => {
    const { parseBlastOptions } = await import('../src/blasts.ts');
    expect(() => parseBlastOptions(new URLSearchParams('blast=2'))).toThrow(/blast must be 0 or 1/);
    expect(() => parseBlastOptions(new URLSearchParams('blast.glow=-1'))).toThrow(/blast.glow must be a number from 0/);
    expect(() => parseBlastOptions(new URLSearchParams('blast.glow='))).toThrow(/blast.glow/);
    expect(() => parseBlastOptions(new URLSearchParams('blast.colour=1'))).toThrow(/not a blast knob/);
  });
});

describe('fired balls beside a bomb on the GPU (fx band)', () => {
  const lineup = (c: Parameters<typeof Drivers.lineupFrames>[0]) =>
    gpu!.page.evaluate((cc) => (window as unknown as { __blasts: typeof Drivers }).__blasts.lineupFrames(cc), c);
  const luma = (c: number[]) => (c[0]! + c[1]! + c[2]!) / 3;

  it.for(['hazy', 'real', 'candy'] as const)('%s: a painted ball is red with a pale band round it, far brighter than the bomb beside it', async (look, ctx) => {
    if (!gpu) return ctx.skip();
    const r = await lineup({ look, keep: !!process.env.LINEUP_SHOTS });
    if (process.env.LINEUP_SHOTS && r.pixels) {
      const { writeFileSync } = await import('node:fs');
      const { encodePng } = await import('@tb/testkit');
      writeFileSync(`${process.env.LINEUP_SHOTS}/lineup-${look}.png`, encodePng(r.size[0]!, r.size[1]!, r.pixels));
    }
    expect(r.error).toBeNull();
    const msg = JSON.stringify(r, (k, v) => (k === 'pixels' ? undefined : v));
    // The bomb stays the dark one.
    expect(luma(r.painted), msg).toBeGreaterThan(luma(r.bomb) + 25);
    // Off the band the ball is red; on the band it is pale: red barely over green there, where off it red is far over
    // green. (Not brighter: the look's ball glow takes the paint and not the band, so in a glowing look the red is the brighter.)
    expect(r.across[0]!, msg).toBeGreaterThan(r.across[2]! + 30);
    expect(r.along[0]! - r.along[1]!, msg).toBeLessThan(40);
    expect(r.across[0]! - r.across[1]!, msg).toBeGreaterThan(r.along[0]! - r.along[1]! + 60);
    expect(luma(r.along), msg).toBeGreaterThan(90);
  });

  it('the band turns with the ball: turned a quarter about the view axis, it runs up and down', async (ctx) => {
    if (!gpu) return ctx.skip();
    const r = await lineup({ look: 'hazy', turned: true });
    expect(r.error).toBeNull();
    expect(r.along[0]! - r.along[1]!, JSON.stringify(r)).toBeLessThan(40);
    expect(r.across[0]! - r.across[1]!, JSON.stringify(r)).toBeGreaterThan(r.along[0]! - r.along[1]! + 60);
    expect(r.across[0]!).toBeGreaterThan(r.across[2]! + 30);
  });
});

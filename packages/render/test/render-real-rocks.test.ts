// The real look's small rocks (rocks.ts: real.rocks, real.rockSize), drawn in
// headless Chromium (SwiftShader without a GPU) from straight above, against
// the CPU twin of their placement. Correctness only: timings from here are
// never performance results.
import { describe, expect, it } from 'vitest';
import { gpu, call } from './harness.ts';
import { ROCK_CELL, ROCK_CLUMP, rockIn } from '../src/rocks.ts';

type RockStat = { cx: number; cy: number; tip: number; rPx: number; centre: number; toSun: number; away: number; rimSun: number; rimAway: number };
type Frames = { frames: Array<{ hash: number; mean: number; rocks: RockStat[] }>; error: string | null };

describe('small rocks (2026-11-02)', () => {
  it('rocks sit where the twin puts them, cast their shadows away from the sun, and rocks 0 runs nothing', async (ctx) => {
    if (!gpu) return ctx.skip();
    const size = 0.15;
    // Sun 35 degrees high, and 15 for the shadows (flat rocks sunk a quarter into the ground throw short ones).
    const low = { sunElevation: 15 };
    const r: Frames = await call('rockChecks', [{ rocks: 0, rockSize: size }, { rocks: 1, rockSize: size }, { rocks: 0.4, rockSize: size }, { rocks: 0, rockSize: 0.3 }, { rocks: 0, rockSize: size, ...low }, { rocks: 1, rockSize: size, ...low }], { rocks: 1, rockSize: size });
    expect(r.error).toBeNull();
    const [off, full, some, offBig, offLow, fullLow] = r.frames;
    // Off: the size changes nothing (the floor shader skips the rocks on a uniform).
    expect(offBig!.hash).toBe(off!.hash);
    expect(full!.hash).not.toBe(off!.hash);
    // Each rock is drawn where the twin put it, a dome lit from the sun's side: inside its rim, the side toward
    // the sun brighter than the side away, by 15 more than the bare ground's grain gives at the same two pixels
    // (measured 33 to 102).
    // Rocks at least 3 px across their narrower radius (the smallest are 0.35 rockSize).
    const big = (k: RockStat) => k.rPx >= 3;
    const n = full!.rocks.filter(big).length;
    expect(n).toBeGreaterThan(12);
    const lit = (k: RockStat, i: number) => (k.rimSun - k.rimAway) - (off!.rocks[i]!.rimSun - off!.rocks[i]!.rimAway) > 15;
    const drawn = (f: typeof full) => f!.rocks.map((k, i) => big(k) && lit(k, i));
    expect(drawn(full).filter(Boolean).length / n).toBeGreaterThan(0.9);
    // At share 0.4 (the same rocks read from that frame) the ones the twin keeps are drawn, the others not.
    const keeps = some!.rocks.map((k) => rockIn(k.cx, k.cy, 0.4, size, ROCK_CELL * size, ROCK_CLUMP) !== null);
    const d4 = drawn(some);
    expect(some!.rocks.filter((k, i) => big(k) && d4[i] === keeps[i]).length / n).toBeGreaterThan(0.9);
    expect(d4.filter(Boolean).length).toBeLessThan(drawn(full).filter(Boolean).length);
    // Shadows (sun 15 degrees): past the rim, the ground away from the sun is darker than toward it, for rocks
    // whose shadow reaches past the sample (tip > 1.4 of the radius along the sun: rounder rocks; flat ones lying
    // along the sun throw shadows that barely clear their rim). Measured: toward the sun 82 to 107, away 45 to 79.
    const long = fullLow!.rocks.filter((k) => big(k) && k.tip > 1.4);
    expect(long.length).toBeGreaterThan(5);
    expect(long.filter((k) => k.away < 0.8 * k.toSun).length / long.length).toBeGreaterThan(0.9);
    // Toward the sun the ground is as without rocks, apart from the contact darkening (at least 0.75 of it).
    expect(long.filter((k) => k.toSun > 0.7 * offLow!.rocks[fullLow!.rocks.indexOf(k)]!.toSun).length / long.length).toBeGreaterThan(0.9);
    // The rocks barely change the mean brightness of the ground (within 3%).
    expect(Math.abs(full!.mean - off!.mean) / off!.mean).toBeLessThan(0.03);
  }, 240_000);
});

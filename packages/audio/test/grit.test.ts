import { describe, expect, it } from 'vitest';
import { BLOCK, CEILING, CLASSIC_SOUND_MATERIALS, CollapseEngine, DV_EDGES, GRIT, gritEnergy, gritGrains, SOUND_MATERIALS, type SoundMaterial } from '@tb/audio';
import { db, frame, octaves, run, SR } from './helpers.ts';

// The grit law on G6's stone (smooth contacts, no dense field): grit is the same in both sets, and this
// keeps the modes and clicks under the limiter at FULL. realism.test.ts covers the real set.
const stone: SoundMaterial = CLASSIC_SOUND_MATERIALS.stone;
/** Stone with its modes and click silenced: what is left is the grit. */
const gritOnly: SoundMaterial = { ...stone, ringDb: -Infinity, clickDb: -Infinity };
const FULL = 1000;

function quiet(m: SoundMaterial, edge = 1, opts = {}, seed = 1) {
  const e = new CollapseEngine({ sampleRate: SR, seed, fullScale: FULL, ...opts });
  e.setMaterial(0, m, edge);
  e.lowcut = 0;
  return e;
}

/**
 * Expected grit energy of a bank cell of sum A^2 a2 rebuilt as k impulses: the bank draws their dv
 * log-uniform in the bin and A_i in proportion, so the cell's grit is a2 sum(lam dv^4) / sum(dv^2) over
 * those k; its mean over draws (Monte Carlo here: the ratio's mean is not the means' ratio at small k).
 */
function bankLaw(bin: number, a2: number, k: number, m: SoundMaterial, edge: number) {
  const lo = DV_EDGES[bin]!, hi = bin + 1 < DV_EDGES.length ? DV_EDGES[bin + 1]! : 2 * lo, T = 20000;
  let x = 12345, s = 0;
  const r = () => { x = (Math.imul(x, 1103515245) + 12345) >>> 0; return x / 4294967296; };
  for (let t = 0; t < T; t++) {
    let num = 0, den = 0;
    for (let i = 0; i < k; i++) { const dv = lo * (hi / lo) ** r(); num += gritGrains(dv) * dv ** 4; den += dv * dv; }
    s += num / den;
  }
  return ((a2 * s) / T) * gritEnergy(m, edge) / FULL ** 2;
}

describe('grit (stone chips, plan S8)', () => {
  it('only materials with a finite gritDb have it, and its energy goes with the block volume', () => {
    expect(gritEnergy(SOUND_MATERIALS.pine)).toBe(0);
    expect(gritEnergy(SOUND_MATERIALS.acrylic)).toBe(0);
    expect(gritEnergy(stone, 0.5) / gritEnergy(stone, 0.25)).toBeCloseTo(8, 9);
    expect(gritEnergy({ ...stone, gritDb: -6 }) / gritEnergy({ ...stone, gritDb: 0 })).toBeCloseTo(10 ** -0.6, 9);
    expect(gritGrains(GRIT.dvMin)).toBe(0);
    expect(gritGrains(2)).toBeCloseTo(6, 9);
    expect(gritGrains(50)).toBe(GRIT.most);
  });

  it('a foreground impact sheds its law: lam(dv) grains of gritEnergy (A dv)^2 each, within 0.25 dB', () => {
    const e = quiet(gritOnly), dv = 3, dist = 2, n = 40, frames = 60;
    const { energy, mono } = run(e, frames * 6 + 120, (b) => { if (b % 6 === 0 && b / 6 < frames) e.push(frame([], Array.from({ length: n }, (_, j) => [dv, dist, -0.9 + (1.8 * j) / n, 0, 0]))); });
    const law = frames * n * gritGrains(dv) * gritEnergy(gritOnly) * ((dv / dist) * dv) ** 2 / FULL ** 2;
    expect(e.grains).toBeGreaterThan(0.95 * frames * n * gritGrains(dv));
    expect(e.grains).toBeLessThan(1.05 * frames * n * gritGrains(dv));
    expect(Math.abs(db(energy / law))).toBeLessThan(0.25);
    // Every grain played whole, also across block edges: each kernel sums to zero, so a cut one would not.
    let sum = 0, abs = 0;
    for (const x of mono) { sum += x; abs += Math.abs(x); }
    expect(Math.abs(sum)).toBeLessThan(1e-5 * abs);
    expect(e.gritOverflow).toBe(0);
  });

  // n = 5: every impact its own impulse, under maxGrains (64) only in bin 2; 40 and 1e5: capped, the
  // same energy in fewer grains; 1000 with the cap lifted: 256 impulses of n / k impacts each.
  it.each([[2, 5, 64], [3, 5, 64], [5, 5, 64], [3, 40, 64], [5, 1e5, 64], [3, 1000, 1e5]] as const)('the bank sheds the same law, bin %i, %i impacts a frame, maxGrains %i', (bin, n, maxGrains) => {
    const frames = 120, a2 = 4; // the same energy however many impacts carry it
    let energy = 0, grains = 0;
    for (let seed = 1; seed <= 3; seed++) {
      const e = quiet(gritOnly, 1, { maxGrains }, seed);
      energy += run(e, frames * 6 + 120, (b) => { if (b % 6 === 0 && b / 6 < frames) e.push(frame([{ bin, sector: 1, count: n, a2 }])); }).energy;
      expect(e.limiter.minGain).toBe(1);
      grains += e.grains;
    }
    expect(Math.abs(db(energy / (3 * frames * bankLaw(bin, a2, Math.min(n, 256), gritOnly, 1))))).toBeLessThan(0.35);
    // The cell's grains: min(lam, maxGrains) a frame, lam about n gritGrains(the bin's middle).
    const lo = DV_EDGES[bin]!, lam = Math.min(maxGrains, n * gritGrains(lo * Math.SQRT2));
    expect(grains / (3 * frames)).toBeGreaterThan(0.75 * lam);
    expect(grains / (3 * frames)).toBeLessThan(1.33 * lam);
  });

  it('soft hits shed none, and pine and acrylic none at all', () => {
    const e = quiet(gritOnly);
    run(e, 60, (b) => b === 0 && e.push(frame([{ bin: 0, count: 500, a2: 50 }], [[0.59, 1, 0, 0, 0], [0.45, 1, 0, 0, 0]])));
    expect(e.grains).toBe(0);
    for (const m of [SOUND_MATERIALS.pine, SOUND_MATERIALS.acrylic]) {
      const p = quiet(m);
      run(p, 60, (b) => b === 0 && p.push(frame([{ bin: 5, count: 500, a2: 50 }], [[8, 1, 0, 0, 0]])));
      expect(p.grains).toBe(0);
    }
  });

  it('only adds: the modes and clicks are bit for bit the same with grit on or off (its own random stream)', () => {
    const feed = (e: CollapseEngine) => (b: number) => { if (b % 6 === 0 && b < 120) e.push(frame([0, 1, 2, 3, 4, 5].map((bin) => ({ bin, sector: bin % 4, count: 30, a2: 3 })), [[4, 3, 0.3, 0, 0.5], [2, 5, -0.6, 0, -1]])); };
    const on = quiet(stone), off = quiet({ ...stone, gritDb: -Infinity }), grit = quiet(gritOnly);
    const a = run(on, 200, feed(on)).mono, b = run(off, 200, feed(off)).mono, c = run(grit, 200, feed(grit)).mono;
    let peak = 0, err = 0, g = 0;
    for (let i = 0; i < a.length; i++) { peak = Math.max(peak, Math.abs(a[i]!)); err = Math.max(err, Math.abs(a[i]! - b[i]! - c[i]!)); g = Math.max(g, Math.abs(c[i]!)); }
    expect(g).toBeGreaterThan(1e-3 * peak); // there is grit to see
    expect(err).toBeLessThan(1e-5 * peak); // float rounding only
  });

  it('is crackle, not hiss: impulsive (kurtosis well over a noise floor\'s 3) and bright (1-16 kHz)', () => {
    const e = quiet(gritOnly);
    const { mono } = run(e, 900, (b) => { if (b % 6 === 0) e.push(frame([{ bin: 2, sector: 1, count: 6, a2: 6 }])); });
    const x = mono.subarray(20000);
    let m2 = 0, m4 = 0;
    for (const v of x) { m2 += v * v; m4 += v ** 4; }
    const kurt = (m4 / x.length) / (m2 / x.length) ** 2;
    expect(kurt).toBeGreaterThan(8);
    const oct = octaves(x), total = oct.reduce((s, v) => s + v, 0), bright = oct.slice(6, 10).reduce((s, v) => s + v, 0); // 1, 2, 4, 8 kHz octaves
    expect(bright / total).toBeGreaterThan(0.9);
  });

  it('spreads its chips after the hit, longer for bigger blocks (mean delay spread sqrt(edge / 0.25 m))', () => {
    const delay = (edge: number) => {
      let t = 0, w = 0;
      for (let seed = 1; seed <= 6; seed++) {
        const e = quiet(gritOnly, edge, { maxGrains: 1e5 }, seed); e.alignOnsets = true;
        const { mono } = run(e, 400, (b) => b === 0 && e.push(frame([{ bin: 3, sector: 1, count: 300, a2: 300 }])));
        mono.forEach((v, i) => { t += i * v * v; w += v * v; });
      }
      // Onsets on the frame's start (latency 30 ms), heard LOOKAHEAD - 1 samples late.
      return (t / w - Math.round(0.03 * SR) - 63) / SR;
    };
    const big = delay(1), small = delay(0.25);
    expect(big / (GRIT.spread * 2)).toBeGreaterThan(0.88);
    expect(big / (GRIT.spread * 2)).toBeLessThan(1.12);
    expect(big / small).toBeGreaterThan(1.7);
    expect(big / small).toBeLessThan(2.3);
  });

  it('stays under the limiter and finite when grains overflow their buckets', () => {
    const e = new CollapseEngine({ sampleRate: SR, seed: 2, fullScale: 1, maxGrains: 1e5 });
    e.setMaterial(0, stone, 1);
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    let peak = 0, finite = true;
    for (let b = 0; b < 300; b++) {
      if (b % 6 === 0 && b < 200) e.push(frame([3, 4, 5].flatMap((bin) => [0, 1, 2, 3].map((sector) => ({ bin, sector, count: 1e5, a2: 1e5 }))), [[30, 1, 0, 0, 0]]));
      e.render(L, R);
      for (let i = 0; i < BLOCK; i++) { finite &&= Number.isFinite(L[i]!) && Number.isFinite(R[i]!); peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!)); }
    }
    expect(finite).toBe(true);
    expect(e.gritOverflow).toBeGreaterThan(0);
    expect(peak).toBeLessThanOrEqual(CEILING + 1e-6);
  });
});

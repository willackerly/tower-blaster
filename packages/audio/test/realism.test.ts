// The real material set (2026-11-05): contact roughness, the dense mode field and the energy law, and
// what must not change: G6's classic set renders bit for bit as main did. The judge that picked the
// values (an AudioSet classifier) runs offline (scripts/sound-judge, docs/sound.md Realism); these
// tests hold the physics and the plumbing it rests on.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOCK, cellOf, CLASSIC_SOUND_MATERIALS, CollapseEngine, contactTime, DENSE_BANDS, DENSE_LOOP, denseField, denseNoise, DV_EDGES,
  forceSpectrum, loudness, mass, modes, parseSoundMaterial, pulseSpectrum, ROUGH_T, SOUND_MATERIALS, type SoundMaterial, VIB_SHARE,
} from '@tb/audio';
import { db, frame, octaves, run, SR } from './helpers.ts';

const REAL = SOUND_MATERIALS as Record<string, SoundMaterial>, CLASSIC = CLASSIC_SOUND_MATERIALS as Record<string, SoundMaterial>;
/** Edges the game and the viewer use: Keystone's 0.5 m blocks, the viewer's 1 m city, 25 cm city blocks. */
const EDGES = [0.25, 0.5, 1];

describe('the classic set is G6 bit for bit', () => {
  // Hashes of this scene rendered by main at 2dfb348-era code (before the real set): every material.
  const PINNED: Record<string, string> = {
    pine: '5167fae557ddd8ad', acrylic: '6736b48c73521d13', stone: '1578584fe99770cc', plaster: 'e5397be4317bcdde',
    iron: 'a5e8bab6304cad76', ice: 'b0a3bc651bff505d', rubber: 'eb5336e08f492718', steel: 'dbcb09fa5bd01151',
  };
  it.each(Object.keys(PINNED))('%s', (name) => {
    const e = new CollapseEngine({ sampleRate: 48000, seed: 3, fullScale: 200 });
    e.setMaterial(0, CLASSIC[name]!, 0.5);
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK), h = createHash('sha256');
    for (let b = 0; b < 400; b++) {
      if (b % 6 === 0 && b < 120) {
        const S = 4, n = DV_EDGES.length * S, counts = new Float32Array(n), a2 = new Float32Array(n);
        for (let bin = 0; bin < DV_EDGES.length; bin++) { const k = cellOf(0, bin, bin % S, S); counts[k] = 20; a2[k] = 2 * (bin + 1); }
        e.push({ dt: 800 / 48000, materials: 1, sectors: S, counts, a2, top: Float32Array.from([3, 2, 0.4, 0, 0.3, 1.5, 4, -0.5, 0, -1]) });
      }
      e.render(L, R); h.update(Buffer.from(L.buffer)); h.update(Buffer.from(R.buffer));
    }
    expect(h.digest('hex').slice(0, 16)).toBe(PINNED[name]);
  });
  it('classic materials carry none of the new fields; real ones are valid materials', () => {
    for (const m of Object.values(CLASSIC)) for (const k of ['roughDb', 'denseDb', 'law', 'walls'] as const) expect(m[k]).toBeUndefined();
    for (const m of Object.values(REAL)) expect(parseSoundMaterial(m)).toEqual(m);
    expect(() => parseSoundMaterial({ law: 'loud' } as never, REAL.stone)).toThrow(/law/);
    expect(() => parseSoundMaterial({ walls: [1, 2] }, REAL.plaster)).toThrow(/walls/);
    expect(() => parseSoundMaterial({ roughDb: Number.NaN }, REAL.plaster)).toThrow(/roughDb/);
  });
});

describe('contact roughness', () => {
  it('is the smooth pulse exactly at eps 0, and a floor that a long contact smooths (sqrt(ROUGH_T / T))', () => {
    for (const f of [10, 300, 2000, 9000]) expect(forceSpectrum(f, 4e-3, 0)).toBe(pulseSpectrum(f, 4e-3));
    // Far above 1 / T the pulse has nothing; the floor is eps sqrt(0.75 ROUGH_T / T) times an asperity's pulse.
    for (const T of [1e-3, 4e-3, 16e-3]) {
      const f = 2000, floor = Math.sqrt(0.75 * ROUGH_T / T) * pulseSpectrum(f, ROUGH_T);
      expect(forceSpectrum(f, T, 1) / floor).toBeCloseTo(1, 1);
    }
    expect(forceSpectrum(2000, 16e-3, 1) / forceSpectrum(2000, 4e-3, 1)).toBeCloseTo(0.5, 1);
    // It rolls off past an asperity's bandwidth: the floor is gone at f ROUGH_T = 2.
    const f = 2 / ROUGH_T;
    expect(forceSpectrum(f, 4e-3, 1) ** 2 - pulseSpectrum(f, 4e-3) ** 2).toBeLessThan(1e-20);
  });
  it('wakes the higher modes: the classic plaster block rings one mode; the real one many', () => {
    const share = (m: SoundMaterial) => {
      const md = modes(m, 0.5), T = contactTime(m, 1, 0.5), eps = m.roughDb === undefined ? 0 : 10 ** (m.roughDb / 20);
      const e = [...md.freq].map((f, k) => (forceSpectrum(f, T, eps) * md.gain[k]!) ** 2 * md.tau[k]!);
      const lo = Math.min(...md.freq), sum = e.reduce((a, b) => a + b, 0);
      return e.filter((_, k) => md.freq[k]! < 1.2 * lo).reduce((a, b) => a + b, 0) / sum;
    };
    expect(share(CLASSIC.plaster!)).toBeGreaterThan(0.95); // the "plop": all in the lowest cluster
    expect(share(REAL.plaster!)).toBeLessThan(0.7);
  });
});

describe('the dense field', () => {
  it('is off for planks, classic materials and denseDb -Infinity', () => {
    expect(denseField(REAL.pine!, [1e-3])).toBeNull();
    expect(denseField(CLASSIC.stone!, [1e-3])).toBeNull();
    expect(denseField({ ...REAL.stone!, denseDb: -Infinity }, [1e-3])).toBeNull();
  });
  it('never takes more than the impact\'s energy, and every real material radiates under 5% of it', () => {
    for (const [name, m] of Object.entries(REAL)) for (const edge of EDGES) {
      const binT = DV_EDGES.map((d) => contactTime(m, d * Math.SQRT2, edge)), d = denseField(m, binT, edge);
      if (!d) continue;
      const B = DENSE_BANDS.length, KE = 0.5 * m.mstar * mass(m, edge);
      for (let bin = 0; bin < binT.length; bin++) {
        expect(d.share[bin], `${name} ${edge} m bin ${bin}`).toBeLessThanOrEqual(VIB_SHARE + 1e-12);
        // Radiated: Int p^2 dt at 1 m times 4 pi / (rho c), per (m/s of dv)^2.
        let W = 0;
        for (let b = 0; b < B; b++) W += d.energy[bin * B + b]! * (4 * Math.PI) / (1.2 * 343);
        expect(W / KE, `${name} ${edge} m bin ${bin}`).toBeLessThan(0.05);
      }
      expect(d.from).toBeGreaterThan(Math.max(...modes(m, edge).freq));
    }
  });
  it('band noise: unit mean square, periodic over its loop, and the bands sum flat (power-complementary)', () => {
    const nz = denseNoise(SR);
    expect(nz).toHaveLength(DENSE_BANDS.length);
    for (const t of nz) { expect(t).toHaveLength(DENSE_LOOP); expect(t.reduce((a, x) => a + x * x, 0) / t.length).toBeCloseTo(1, 4); }
    // Each band holds the same energy (a half-octave each), so their sum is pink: equal energy per octave,
    // within 1.5 dB from 250 Hz to 8 kHz, where the cos^2 shoulders of neighbours add to one.
    const sum = new Float32Array(DENSE_LOOP);
    for (const t of nz) for (let i = 0; i < DENSE_LOOP; i++) sum[i]! += t[i]!;
    const o = octaves(sum);
    for (let k = 4; k <= 9; k++) expect(Math.abs(db(o[k]! / o[8]!)), `octave ${16 * 2 ** k} Hz`).toBeLessThan(1.5);
  });
  it('plays the energy it is given: a dense-only material\'s output matches the field\'s law', () => {
    // Modes and click silenced (ringDb trims the table, clickDb the click), grit off: what sounds is the field.
    const m: SoundMaterial = { ...REAL.stone!, ringDb: -Infinity, clickDb: -Infinity, gritDb: -Infinity }, edge = 0.5;
    const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: 1 });
    e.setMaterial(0, m, edge); e.lowcut = 0; e.limiter.process = () => {};
    const bin = 2, n = 40, a2 = 3; // 40 impacts in bin 2 a frame, sum A^2 = 3, for 30 frames
    let energy = 0;
    const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    for (let b = 0; b < 30 * 6 + 400; b++) {
      if (b % 6 === 0 && b < 30 * 6) e.push(frame([{ bin, sector: 1, count: n, a2 }]));
      e.render(L, R);
      for (let i = 0; i < BLOCK; i++) energy += L[i]! ** 2 + R[i]! ** 2;
    }
    const binT = DV_EDGES.map((d) => contactTime(m, d * Math.SQRT2, edge)), d = denseField(m, binT, edge)!, B = DENSE_BANDS.length;
    let per = 0;
    for (let b = 0; b < B; b++) per += d.energy[bin * B + b]!;
    expect(Math.abs(db(energy / (30 * a2 * per * SR)))).toBeLessThan(0.5);
  });
  it('costs nothing when idle', () => {
    const e = new CollapseEngine({ sampleRate: SR, seed: 1 });
    e.setMaterial(0, REAL.plaster!, 0.5);
    run(e, 40);
    expect(e.work).toBe(0);
    run(e, 40, (b) => b === 0 && e.push(frame([{ bin: 2, count: 5, a2: 1 }])));
    const busy = e.work;
    expect(busy).toBeGreaterThan(0);
    run(e, 3000); // everything has decayed: the field goes quiet again
    const after = e.work;
    run(e, 40);
    expect(e.work).toBe(after);
  });
});

describe('the energy law (table modes)', () => {
  // The click (the rigid body's compact dipole, unchanged from G6) is left out: past ka ~ 1 (a 1 m box
  // stopping in 1 ms) the compact formula overstates it, a known limit (docs/sound.md, Realism).
  it('a real material radiates at most ~10% of the impact\'s energy, modes and field together (dv 0.5-4 m/s)', () => {
    for (const [name, m] of Object.entries(REAL)) {
      if (name === 'pine') continue; // the velocity law (classic), unchanged
      for (const edge of [0.5, 1]) for (const dv of [0.5, 1, 4]) {
        const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: 1 });
        e.setMaterial(0, { ...m, clickDb: -Infinity }, edge); e.lowcut = 0; e.limiter.process = () => {};
        let E = 0;
        const L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
        for (let b = 0; b < 600; b++) {
          if (b === 0) e.push(frame([{ bin: 2, sector: 1, count: 1, a2: 1e-12 }], [[dv, 1, 0, 0, 0]]));
          e.render(L, R);
          for (let i = 0; i < BLOCK; i++) E += L[i]! ** 2 + R[i]! ** 2;
        }
        const W = ((4 * Math.PI) / (1.2 * 343)) * (E / SR), KE = 0.5 * m.mstar * mass(m, edge) * dv * dv;
        expect(W / KE, `${name} ${edge} m ${dv} m/s`).toBeLessThan(0.1); // struck shells and bells: up to ~10%
        expect(W / KE, `${name} ${edge} m ${dv} m/s`).toBeGreaterThan(1e-6);
      }
    }
  });
});

describe('loudness (ITU-R BS.1770)', () => {
  const sine = (amp: number, f = 997, s = 5) => Float32Array.from({ length: s * SR }, (_, i) => amp * Math.sin((2 * Math.PI * f * i) / SR));
  it('reads a full-scale 997 Hz sine in one channel as -3.01 LUFS, and EBU Tech 3341\'s -23 dBFS stereo sine as -23', () => {
    expect(loudness(sine(1))).toBeCloseTo(-3.01, 1);
    const x = sine(10 ** (-23 / 20));
    expect(loudness(x, x)).toBeCloseTo(-23, 1);
  });
  it('gates silence out', () => {
    const x = sine(0.1, 997, 4), y = new Float32Array(8 * SR);
    y.set(x, 0);
    expect(Math.abs(loudness(y) - loudness(x))).toBeLessThan(0.3); // blocks straddling the edge: a little under
    expect(loudness(new Float32Array(SR))).toBe(-Infinity);
  });
});

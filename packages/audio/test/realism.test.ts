// The real material set (2026-11-05): contact roughness, the dense mode field and the energy law, and
// what must not change: G6's classic set renders bit for bit as main did. The judge that picked the
// values (an AudioSet classifier) runs offline (scripts/sound-judge, docs/sound.md Realism); these
// tests hold the physics and the plumbing it rests on.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BLOCK, cellOf, CLASSIC_SOUND_MATERIALS, CollapseEngine, contactTime, DENSE_BANDS, DENSE_LOOP, denseField, denseNoise, DV_EDGES,
  CLAMPED_PLATE, clickFilter, clickKernel, forceSpectrum, modalDensity, modalOverlap, radiatedClick, volume, loudness, mass, modes, parseSoundMaterial, plateTable, pulseSpectrum, ROUGH_T, roughTime, SOUND_MATERIALS, type SoundMaterial, VIB_SHARE,
} from '@tb/audio';
import { GRIT, GRIT_SHARE, gritGrains, REAL1_SOUND_MATERIALS, soundMaterials, SOUND_SETS } from '@tb/audio';
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
    for (const m of Object.values(CLASSIC)) for (const k of ['roughDb', 'roughT', 'denseDb', 'law', 'walls', 'plateModes'] as const) expect(m[k]).toBeUndefined();
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

describe('material identity (the listening ladder, step 1)', () => {
  it('plate tables: Leissa\'s 8 when absent; past them the edge-effect asymptote, which meets Leissa at (3, 2) and (3, 3)', () => {
    expect(plateTable()).toBe(CLAMPED_PLATE);
    const t = plateTable(8), key = (p: number, q: number) => t.find(([, a, b]) => a === p && b === q)![0];
    expect(t).toHaveLength(64);
    expect(new Set(t.map(([, p, q]) => `${p},${q}`)).size).toBe(64);
    for (const row of CLAMPED_PLATE) expect(t).toContainEqual([...row]); // the table's own values where it has them
    const asym = (p: number, q: number) => 0.91 * Math.PI ** 2 * ((p + 0.5) ** 2 + (q + 0.5) ** 2);
    expect(Math.abs(asym(3, 2) / 165.15 - 1)).toBeLessThan(0.007); // Leissa (3, 2), 0.6%
    expect(key(3, 3) / 220.03).toBeCloseTo(1, 3); // Leissa (3, 3), not in the table: the asymptote alone
    for (let q = 1; q <= 8; q++) for (let p = 2; p <= 8; p++) expect(key(p, q)).toBeGreaterThan(key(p - 1, q));
    expect(plateTable(2)).toEqual(CLAMPED_PLATE.filter(([, p, q]) => p <= 2 && q <= 2).map((x) => [...x]));
  });

  it('a shell with more plate modes rings denser, and its dense field starts above the larger table', () => {
    const few = { ...REAL.iron!, plateModes: undefined }, many = REAL.iron!;
    expect(many.plateModes).toBe(8);
    expect(modes(many, 0.5).freq.length).toBeGreaterThan(4 * modes(few, 0.5).freq.length);
    const top = Math.max(...modes(many, 0.5).freq), field = denseField(many, [1e-3], 0.5)!;
    expect(field).not.toBeNull();
    expect(top).toBeLessThan(18000);
  });

  it('the iron box\'s walls weigh what the game\'s iron does (1950 kg/m^3), as plaster\'s solid block does (250)', () => {
    expect(mass(REAL.iron!, 0.5) / 0.125 / 1950).toBeCloseTo(1, 1);
    expect(mass(REAL.plaster!, 0.5) / 0.125).toBeCloseTo(250, 6);
  });

  it('loss factors sit in their material\'s band (Wildes & Richards; the judge, docs/sound.md): metal < glass < stone < wood', () => {
    const eta = (k: string) => REAL[k]!.eta;
    expect(eta('steel')).toBeLessThanOrEqual(0.002);
    expect(eta('iron')).toBeLessThan(0.005);
    expect(eta('ice')).toBeGreaterThanOrEqual(0.005); expect(eta('ice')).toBeLessThanOrEqual(0.01);
    for (const k of ['stone', 'plaster']) { expect(eta(k)).toBeGreaterThanOrEqual(0.02); expect(eta(k)).toBeLessThan(0.04); }
    expect(eta('rubber')).toBeGreaterThan(0.04);
  });

  it('an asperity time (roughT) sets the roughness floor\'s bandwidth; absent, ROUGH_T as before', () => {
    expect(roughTime(REAL.plaster!)).toBe(ROUGH_T);
    for (const f of [300, 2000, 9000]) expect(forceSpectrum(f, 4e-3, 0.5)).toBe(forceSpectrum(f, 4e-3, 0.5, ROUGH_T));
    // Five times longer: the floor is gone at f roughT = 2 (1.3 kHz), where ROUGH_T's still holds.
    const rt = 5 * ROUGH_T, f = 2 / rt;
    expect(forceSpectrum(f, 4e-3, 1, rt) ** 2 - pulseSpectrum(f, 4e-3) ** 2).toBeLessThan(1e-20);
    expect(forceSpectrum(f, 4e-3, 1) / pulseSpectrum(f, 4e-3)).toBeGreaterThan(10);
  });

  it('rejects plate modes and asperity times that cannot be', () => {
    for (const plateModes of [0, 2.5, 17]) expect(() => parseSoundMaterial({ plateModes }, REAL.iron)).toThrow(/plateModes/);
    for (const roughT of [0, 1e-6, 0.1, Number.NaN]) expect(() => parseSoundMaterial({ roughT }, REAL.steel)).toThrow(/roughT/);
    expect(parseSoundMaterial({ plateModes: 12, roughT: 1e-3 }, REAL.iron)).toMatchObject({ plateModes: 12, roughT: 1e-3 });
  });
});

describe('step 2 options (off by default)', () => {
  it('overlap: discrete modes from the table up to modal overlap 1, at the Weyl count; the field above them', () => {
    const steel = REAL.steel!, md0 = modes(steel, 0.5), md = modes({ ...steel, overlap: 1 }, 0.5);
    expect(steel.overlap).toBeUndefined();
    const top = Math.max(...md0.freq), added = [...md.freq].slice(md0.freq.length);
    expect([...md.freq].slice(0, md0.freq.length)).toEqual([...md0.freq]); // the table untouched
    expect(added.length).toBeGreaterThan(50);
    for (const f of added) { expect(f).toBeGreaterThan(top); expect(modalOverlap(steel, f, 0.5)).toBeLessThan(1.01); }
    // As many as the density integrates to between the table top and the last one (within the +-0.3 jitter's 1).
    let N = 0;
    for (let f = top, last = Math.max(...added); f < last; f *= 1.0005) N += modalDensity(steel, f, 0.5) * f * 0.0005;
    expect(Math.abs(added.length - N)).toBeLessThan(1.5);
    for (let k = 1; k < added.length; k++) expect(added[k]!).toBeGreaterThan(added[k - 1]!); // no repeats
    // Each impact weights the new modes by independent unit normals (rms 1), the table's own as before.
    const rng = (seed: number) => { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
    const rand = rng(5);
    const w = new Float64Array(md.freq.length), w0 = new Float64Array(md0.freq.length);
    let ss = 0, n = 0;
    for (let k = 0; k < 4000; k++) { md.weights(rand, w); for (let j = md0.freq.length; j < w.length; j++) { ss += w[j]! ** 2; n++; } }
    expect(Math.sqrt(ss / n)).toBeCloseTo(1, 1);
    md.weights(rng(9), w); md0.weights(rng(9), w0);
    expect([...w].slice(0, w0.length)).toEqual([...w0]);
    expect(denseField({ ...steel, overlap: 1 }, [1e-3], 0.5)?.from ?? Infinity).toBeGreaterThan(Math.max(...added));
    // A material already overlapping at its table's top (plaster) gains nothing.
    expect(modes({ ...REAL.plaster!, overlap: 1 }, 0.5).freq.length).toBe(modes(REAL.plaster!, 0.5).freq.length);
  });

  it('clickModel sphere: the oscillating sphere\'s far field, 2 / sqrt(4 + (ka)^4) of the compact dipole', () => {
    expect(clickFilter(REAL.stone!, SR, 0.5)).toBeNull();
    const m = { ...REAL.stone!, clickModel: 'sphere' as const }, [b0, b1, b2, a1, a2] = clickFilter(m, SR, 0.5)!;
    const a = Math.cbrt((3 * volume(m, 0.5)) / (4 * Math.PI));
    const mag = (f: number) => {
      const w = (2 * Math.PI * f) / SR, re = (c: number[]) => c[0]! + c[1]! * Math.cos(w) + c[2]! * Math.cos(2 * w), im = (c: number[]) => -(c[1]! * Math.sin(w) + c[2]! * Math.sin(2 * w));
      return Math.hypot(re([b0, b1, b2]), im([b0, b1, b2])) / Math.hypot(re([1, a1, a2]), im([1, a1, a2]));
    };
    for (const f of [20, 100, 250, 500, 1000, 2000, 4000]) {
      const ka = (2 * Math.PI * f * a) / 343;
      expect(mag(f) / (2 / Math.sqrt(4 + ka ** 4))).toBeCloseTo(1, 1);
    }
    // A voice's radiated click: the compact one at low frequencies, with less energy (the piston limit above ka ~ 1.4).
    const T = 3e-3, k = clickKernel(m, T, SR, 0.5), rk = radiatedClick(m, T, SR, 0.5), e = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);
    expect(rk.length).toBeGreaterThan(k.length);
    expect(e(rk)).toBeLessThan(e(k));
    expect(radiatedClick(REAL.stone!, T, SR, 0.5)).toEqual(clickKernel(REAL.stone!, T, SR, 0.5));
    // In the engine: the bank's clicks pass the same filter; finite, quieter, and silent again after.
    const energy: number[] = [];
    for (const cm of ['dipole', 'sphere'] as const) {
      const e = new CollapseEngine({ sampleRate: SR, seed: 2, fullScale: 1000 });
      e.setMaterial(0, { ...REAL.stone!, clickModel: cm, denseDb: -Infinity, ringDb: -120, gritDb: -Infinity }, 0.5);
      const { mono, energy: en } = run(e, 300, (b) => { if (b === 2) e.push(frame([{ bin: 3, count: 40, a2: 40 }, { bin: 5, count: 10, a2: 30 }], [[2, 1, 0.2, 0, 0.5]])); });
      expect(mono.every(Number.isFinite)).toBe(true);
      expect(Math.max(...mono.slice(-1024).map(Math.abs))).toBeLessThan(1e-6); // nothing left ringing
      energy.push(en);
    }
    expect(energy[1]!).toBeLessThan(energy[0]!);
    expect(energy[1]!).toBeGreaterThan(0);
  });

  it('rejects overlaps and click models that cannot be', () => {
    for (const overlap of [0, 0.05, 11]) expect(() => parseSoundMaterial({ overlap }, REAL.steel)).toThrow(/overlap/);
    expect(() => parseSoundMaterial({ clickModel: 'cone' } as never, REAL.steel)).toThrow(/clickModel/);
    expect(parseSoundMaterial({ overlap: 1, clickModel: 'sphere' }, REAL.steel)).toMatchObject({ overlap: 1, clickModel: 'sphere' });
  });
});

describe('step 2c options: stone and ice from real recordings (absent: as before; set real1 keeps the step 2b sounds)', () => {
  const R1 = REAL1_SOUND_MATERIALS as Record<string, SoundMaterial>;
  it('discrete modes on a body with no table (its first mode past fmax) end: the count starts at 20 Hz, not 0', () => {
    // A 5 cm stone cube's first mode is past 18 kHz; from 0 the old step (x * 0.002) never moved and hung.
    const m = { ...R1.stone!, overlap: 1 }, t0 = Date.now(), md = modes(m, 0.05);
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(modes(R1.stone!, 0.05).freq.length).toBe(0);
    for (const f of md.freq) { expect(Number.isFinite(f)).toBe(true); expect(f).toBeGreaterThan(20); }
  });

  /** Grit alone: modes, click and field silenced, at a 25 cm block (the grains' mean delay is gritSpread there). */
  function gritEngine(over: Partial<SoundMaterial>, ringDb: number) {
    const m: SoundMaterial = { ...R1.ice!, ringDb, clickDb: -Infinity, denseDb: -Infinity, roughDb: -Infinity, gritDb: 40, ...over };
    const e = new CollapseEngine({ sampleRate: SR, seed: 3, fullScale: 1e6 });
    e.setMaterial(0, m, GRIT.refEdge); e.lowcut = 0; e.limiter.process = () => {};
    return { e, mono: run(e, 600, (b) => { if (b === 2) e.push(frame([], [[5, 1, 0, 0, 0.3]])); }).mono };
  }
  const gritRun = (over: Partial<SoundMaterial>, ringDb = -Infinity) => gritEngine(over, ringDb).mono;
  /** The energy's mean time, s. */
  const centroid = (x: Float32Array) => { let a = 0, w = 0; x.forEach((v, i) => { a += i * v * v; w += v * v; }); return a / w / SR; };
  const energyOf = (x: Float32Array) => x.reduce((s, v) => s + v * v, 0);

  it('gritRate: grains per m/s of dv (absent: GRIT.perDv), the cap scaling with it; the energy follows the count', () => {
    expect(gritGrains(2)).toBe(GRIT.perDv * 2);
    expect(gritGrains(2, GRIT.perDv)).toBe(gritGrains(2));
    expect(gritGrains(2, 30)).toBe(60);
    expect(gritGrains(100, 30)).toBe((GRIT.most * 30) / GRIT.perDv);
    expect(gritGrains(GRIT.dvMin * 0.9, 30)).toBe(0);
    // dv 5: Poisson(15) grains by default, Poisson(150) at rate 30.
    const n0 = gritEngine({}, -Infinity).e.grains, n30 = gritEngine({ gritRate: 30 }, -Infinity).e.grains;
    expect(n0).toBeGreaterThan(15 - 4 * Math.sqrt(15)); expect(n0).toBeLessThan(15 + 4 * Math.sqrt(15));
    expect(n30).toBeGreaterThan(150 - 4 * Math.sqrt(150)); expect(n30).toBeLessThan(150 + 4 * Math.sqrt(150));
  });

  it('gritSpread: the grains\' mean delay; absent, GRIT.spread', () => {
    const t = (s?: number) => centroid(gritRun({ gritRate: 30, ...(s === undefined ? {} : { gritSpread: s }) }));
    const t0 = t(0.002);
    expect((t(0.08) - t0) / 0.078).toBeGreaterThan(0.75);
    expect((t(0.08) - t0) / 0.078).toBeLessThan(1.25);
    expect(t()).toBeCloseTo(t(GRIT.spread), 6);
  });

  it('gritRing: 0 plays as absent bit for bit; 1 moves the grains\' energy into the body\'s modes (no dry clicks, a ringing tail)', () => {
    const hash = (x: Float32Array) => createHash('sha256').update(Buffer.from(x.buffer)).digest('hex');
    expect(hash(gritRun({ gritRate: 30, gritRing: 0 }, 0))).toBe(hash(gritRun({ gritRate: 30 }, 0)));
    // The impact's own ring is the same in every run (grit and cracks draw from their own stream), so the
    // difference from a grit-free run is the grit alone (field off: everything left is linear).
    // A 2 ms burst, so the ring's tail (ice's modes, tau ~18 ms at 25 cm) stands clear of the clicks.
    const base = gritRun({ gritDb: -Infinity }, 0), part = (r: number) => gritRun({ gritRate: 30, gritSpread: 0.002, gritRing: r }, 0).map((v, i) => v - base[i]!);
    const dry = part(0), rung = part(1), half = part(0.5);
    // Energy kept (the modes' tau sr / 4 law, unit-rms weights): within 2 dB.
    expect(Math.abs(db(energyOf(rung) / energyOf(dry)))).toBeLessThan(2);
    expect(Math.abs(db(energyOf(half) / energyOf(dry)))).toBeLessThan(2);
    // Rung, the grains ring on: the energy sits later than the dry clicks' (4-32 samples each).
    expect(centroid(rung)).toBeGreaterThan(centroid(dry) + 0.005);
    // Modes silenced (ringDb -Infinity) silence the cracks' ring too: all-ringing grit is then quiet.
    expect(energyOf(gritRun({ gritRate: 30, gritRing: 1 }))).toBe(0);
  });

  it('face: contact time from Hertz (absent, 0) toward a flat face, T_hertz^(1 - face) T_face^face', () => {
    const stone = R1.stone!, dv = (Math.sqrt(2 * 9.81 * 0.05) * 1.35) / 2; // the knock: a 5 cm drop
    const hertz = contactTime(stone, dv, 0.5);
    expect(hertz).toBeCloseTo(7.53e-3, 4);
    expect(contactTime({ ...stone, face: 0 }, dv, 0.5)).toBe(hertz);
    const Es = stone.E / (2 * (1 - stone.nu ** 2)), flat = Math.PI * Math.sqrt((stone.mstar * mass(stone, 0.5)) / (Es * 0.5));
    expect(flat).toBeCloseTo(5.04e-4, 6);
    expect(contactTime({ ...stone, face: 1 }, dv, 0.5)).toBeCloseTo(flat, 12);
    expect(contactTime({ ...stone, face: 0.6 }, dv, 0.5)).toBeCloseTo(hertz ** 0.4 * flat ** 0.6, 12);
    // Still faster for harder hits, by (1 - face) of Hertz's dv^(-1/5).
    expect(contactTime({ ...stone, face: 0.6 }, 4 * dv, 0.5) / contactTime({ ...stone, face: 0.6 }, dv, 0.5)).toBeCloseTo(4 ** (-0.2 * 0.4), 9);
    for (const face of [-0.1, 1.1]) expect(() => parseSoundMaterial({ face }, R1.stone)).toThrow(/face/);
  });

  it('rejects grit rates, spreads and ring shares that cannot be', () => {
    for (const gritRate of [0, 0.05, 61]) expect(() => parseSoundMaterial({ gritRate }, R1.ice)).toThrow(/gritRate/);
    for (const gritSpread of [0, 0.0005, 0.3]) expect(() => parseSoundMaterial({ gritSpread }, R1.ice)).toThrow(/gritSpread/);
    for (const gritRing of [-0.1, 1.1]) expect(() => parseSoundMaterial({ gritRing }, R1.ice)).toThrow(/gritRing/);
    expect(parseSoundMaterial({ gritRate: 30, gritSpread: 0.08, gritRing: 0.5 }, R1.ice)).toMatchObject({ gritRate: 30, gritSpread: 0.08, gritRing: 0.5 });
  });
});

describe('step 2c defaults (Will away 2026-11-06: the recommended picks, stone E and ice E)', () => {
  it('the real set is real1 with stone and ice from the recordings; real1 and classic stay selectable', () => {
    expect(SOUND_SETS).toEqual(['real', 'real1', 'classic']);
    expect(soundMaterials('real1')).toBe(REAL1_SOUND_MATERIALS);
    expect(soundMaterials()).toBe(SOUND_MATERIALS);
    const R1 = REAL1_SOUND_MATERIALS as Record<string, SoundMaterial>;
    for (const k of Object.keys(REAL)) if (k !== 'stone' && k !== 'ice') expect(REAL[k], k).toBe(R1[k]);
    expect(REAL.stone).toEqual({ ...R1.stone, overlap: 1, jitter: 0.15, gritDb: 50, gritRate: 10, face: 0.6 });
    expect(REAL.ice).toEqual({ ...R1.ice, jitter: 0.08, gritDb: 50, gritRate: 30, gritSpread: 0.08, face: 0.5 });
    for (const m of [REAL.stone!, REAL.ice!]) expect(parseSoundMaterial({}, m)).toEqual(m);
  });

  it(`grit never radiates more than GRIT_SHARE (${GRIT_SHARE}) of an impact's kinetic energy; G6's grit is far under it`, () => {
    const W = (m: SoundMaterial, edge: number, dv: number) => {
      const e = new CollapseEngine({ sampleRate: SR, seed: 4, fullScale: 1 }); // Pa out
      e.setMaterial(0, { ...m, ringDb: -Infinity, clickDb: -Infinity, denseDb: -Infinity, roughDb: -Infinity }, edge); e.lowcut = 0; e.limiter.process = () => {};
      const { mono } = run(e, 600, (b) => { if (b === 2) e.push(frame([], [[dv, 1, 0, 0, 0]])); });
      let E = 0; for (const v of mono) E += v * v / 2; // mono is L + R of a centred source: L^2 + R^2 = mono^2 / 2
      return ((4 * Math.PI) / (1.2 * 343)) * (E / SR) / (0.5 * m.mstar * mass(m, edge) * dv * dv);
    };
    // Ice at 4 m/s would shed ~16% without the cap; with it, the share is GRIT_SHARE (Poisson and lognormal scatter).
    const ice = W(REAL.ice!, 0.5, 4);
    expect(ice).toBeLessThan(GRIT_SHARE * 1.5); expect(ice).toBeGreaterThan(GRIT_SHARE * 0.5);
    // Soft hits are under the cap, so the burst is the rate's: about the same share at 0.7 m/s with and without it.
    expect(W(REAL.ice!, 0.5, 0.7)).toBeLessThan(GRIT_SHARE);
    expect(W(CLASSIC.stone!, 0.5, 4)).toBeLessThan(GRIT_SHARE / 100);
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

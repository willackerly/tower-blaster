import { describe, expect, it } from 'vitest';
import {
  BETA_L, beamBending, clickKernel, contactTime, mass, materialFromJson, materialToJson, modes, parseSoundMaterial,
  pulseSpectrum, SOUND_MATERIALS, type SoundMaterial,
} from '@tb/audio';
import { rng } from '@tb/scenarios';

const pine: SoundMaterial = SOUND_MATERIALS.pine, acrylic: SoundMaterial = SOUND_MATERIALS.acrylic, stone: SoundMaterial = SOUND_MATERIALS.stone;
const sorted = (a: Float64Array) => [...a].sort((x, y) => x - y);

describe('plank (Kapla)', () => {
  it('bending matches the closed-form Euler-Bernoulli beam when shear is stiff, less rotary inertia', () => {
    const [L, , t] = pine.dims!, rg = t / Math.sqrt(12);
    const eb = (BETA_L[0]! ** 2 / (2 * Math.PI * L * L)) * Math.sqrt(pine.E / pine.rho) * rg;
    const rayleigh = eb / Math.sqrt(1 + ((BETA_L[0]! / L) * rg) ** 2);
    expect(beamBending(L, t, pine.E, 1e30, pine.rho, 0)).toBeCloseTo(rayleigh, 6);
    expect(rayleigh / eb).toBeGreaterThan(0.995); // a slender plank: rotary inertia is under 0.5%
    // Shear (wood: E/G = 14) lowers every mode, the higher ones more.
    const r0 = beamBending(L, t, pine.E, pine.G!, pine.rho, 0) / beamBending(L, t, pine.E, 1e30, pine.rho, 0);
    const r2 = beamBending(L, t, pine.E, pine.G!, pine.rho, 2) / beamBending(L, t, pine.E, 1e30, pine.rho, 2);
    expect(r0).toBeLessThan(1);
    expect(r2).toBeLessThan(r0);
  });

  it('rings first at 2.5 kHz, inside the literature range, with a 13 ms decay', () => {
    const m = modes(pine);
    const f = sorted(m.freq);
    expect(f[0]).toBeGreaterThan(2400);
    expect(f[0]).toBeLessThan(2700);
    expect(m.freq.length).toBeGreaterThanOrEqual(8);
    expect(m.freq.length).toBeLessThanOrEqual(16);
    const i = m.freq.indexOf(f[0]!);
    expect(m.tau[i]! * 1e3).toBeCloseTo(12.8, 0);
  });

  it('weighs 10 g and keeps its real size whatever the world scale', () => {
    expect(mass(pine)).toBeCloseTo(0.0103, 4);
    expect([...modes(pine, 0.25).freq]).toEqual([...modes(pine, 4).freq]);
  });
});

describe('cube (finite elements) and shell', () => {
  it('a free cube rings first at 0.45 c_t / L, a doubly degenerate mode', () => {
    const L = 0.25, ct = Math.sqrt(stone.E / (2 * (1 + stone.nu)) / stone.rho);
    const f = sorted(modes(stone, L).freq);
    expect(f[0]! / (ct / L)).toBeGreaterThan(0.44);
    expect(f[0]! / (ct / L)).toBeLessThan(0.47);
    expect(f[1]! / f[0]!).toBeCloseTo(1, 4);
  });

  it('pitch follows size: f ~ 1/L for a solid cube, ~ h/a^2 for a shell', () => {
    const a = modes(stone, 0.25).freq, b = modes(stone, 0.5).freq;
    a.forEach((x, i) => expect(b[i]! * 2).toBeCloseTo(x, 6));
    const s1 = sorted(modes(acrylic).freq)[0]!;
    const s2 = sorted(modes({ ...acrylic, size: 0.16, wall: 0.005 }).freq)[0]!;
    expect(s2 / s1).toBeCloseTo((0.005 / 0.16 ** 2) / (0.0025 / 0.08 ** 2), 6);
    expect(s1).toBeGreaterThan(1000);
    expect(s1).toBeLessThan(1250);
  });
});

describe('contact weights', () => {
  for (const [name, m, edge] of [['pine', pine, 1], ['acrylic', acrylic, 1], ['stone', stone, 0.25]] as const) {
    it(`${name}: rms about 1 per mode over many hits, and deterministic for a seed`, () => {
      const md = modes(m, edge), n = md.freq.length, w = new Float64Array(n), sum = new Float64Array(n), N = 20000;
      const r = rng(7);
      for (let k = 0; k < N; k++) { md.weights(r, w); for (let j = 0; j < n; j++) sum[j]! += w[j]! ** 2; }
      const rms = [...sum].map((s) => Math.sqrt(s / N));
      // The direction splits a beam's energy over its three axes (1/sqrt 3 each), so planks sit lower.
      for (const v of rms) { expect(v).toBeGreaterThan(name === 'pine' ? 0.25 : 0.6); expect(v).toBeLessThan(1.6); }
      const a = md.weights(rng(3), new Float64Array(n)), b = md.weights(rng(3), new Float64Array(n));
      expect([...a]).toEqual([...b]);
    });
  }
});

describe('contact and click', () => {
  it('Hertz contact time falls as v^-1/5 and grows as m^2/5', () => {
    expect(contactTime(pine, 32) / contactTime(pine, 1)).toBeCloseTo(0.5, 6);
    expect(contactTime(pine, 1) * 1e3).toBeCloseTo(0.40, 2);
    const heavy = { ...stone, rho: stone.rho * 32 };
    expect(contactTime(heavy, 1, 0.25) / contactTime(stone, 1, 0.25)).toBeCloseTo(4, 6);
    // A 25 cm stone block's contact outlasts its first mode period many times over: it thuds.
    expect(contactTime(stone, 1, 0.25) * sorted(modes(stone, 0.25).freq)[0]!).toBeGreaterThan(5);
  });

  it('the pulse spectrum is 1 at DC, continuous at fT = 1 and zero at fT = 2, 3', () => {
    expect(pulseSpectrum(0, 1e-3)).toBe(1);
    expect(pulseSpectrum(1000 * (1 - 1e-6), 1e-3)).toBeCloseTo(0.5, 4);
    expect(pulseSpectrum(2000, 1e-3)).toBeLessThan(1e-9);
    expect(pulseSpectrum(3000, 1e-3)).toBeLessThan(1e-9);
  });

  it('the click integrates to zero (no net pressure) and its peak scales as 1/T^2', () => {
    const a = clickKernel(pine, 4e-4, 192000), b = clickKernel(pine, 8e-4, 192000);
    expect(Math.abs(a.reduce((s, x) => s + x, 0)) / Math.max(...a)).toBeLessThan(0.02);
    expect(Math.max(...a) / Math.max(...b)).toBeCloseTo(4, 1);
  });
});

describe('config', () => {
  it('every default round-trips through JSON, -Infinity included', () => {
    for (const m of Object.values(SOUND_MATERIALS)) expect(materialFromJson(materialToJson(m))).toEqual(m);
  });

  it('rejects values that cannot make sound', () => {
    expect(() => parseSoundMaterial({ eta: 0 }, pine)).toThrow(/eta/);
    expect(() => parseSoundMaterial({ nu: 0.5 }, pine)).toThrow(/nu/);
    expect(() => parseSoundMaterial({ model: 'gong' }, pine)).toThrow(/model/);
    expect(() => parseSoundMaterial({ wobble: 1 } as never, pine)).toThrow(/unknown/);
    expect(() => parseSoundMaterial({ model: 'cube' })).toThrow(/positive/);
    expect(() => parseSoundMaterial({ model: 'shell' }, SOUND_MATERIALS.stone)).toThrow(/wall/);
    expect(parseSoundMaterial({ eta: 0.02 }, pine).eta).toBe(0.02);
  });
});

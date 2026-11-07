// Air absorption (A8a step 3): the ISO 9613-1 formula gives the standard's own table, the fitted filters follow
// it over distance, moving between table entries does not click, and the engine filters each voice and sector
// for its distance only with space and air on.
import { describe, expect, it } from 'vitest';
import { AIR_D0, AIR_STEP, AIR_TABLE, airAlpha, AirFilter, airIndex, airLoss, BLOCK, CollapseEngine, CollapseHost, SPACE_FIELDS, sectorOf } from '@tb/audio';
import { airError } from '../src/air-cli.ts';
import { frame, FRAME, octaves, pine, SR } from './helpers.ts';

describe('air absorption (A8a step 3)', () => {
  it('the formula gives ISO 9613-1 Table 1 (20 C, 70% RH), dB/km at the exact midbands', () => {
    const table: [number, number][] = [[1000, 4.98], [1995.3, 9.02], [3981.1, 22.9], [7943.3, 76.6]];
    for (const [f, want] of table) expect(airAlpha(f, 20, 70) * 1000).toBeCloseTo(want, 1);
    // The game's air (50%): 9 dB at 16 kHz over 25 m, 10.5 dB at 8 kHz over 100 m.
    expect(airAlpha(16000) * 25).toBeCloseTo(9.1, 1);
    expect(airAlpha(8000) * 100).toBeCloseTo(10.5, 1);
  });

  it('every table entry follows the standard: within 0.2 dB to 50 m, 2.5 dB out to 400 m (where the loss is under 20 dB)', () => {
    expect(AIR_TABLE.length).toBe(123);
    AIR_TABLE.forEach((p, i) => {
      const d = AIR_D0 * AIR_STEP ** i, e = airError(p, d);
      expect(e, `${d.toFixed(1)} m`).toBeLessThan(d <= 50 ? 0.2 : 2.5);
      expect(airLoss(p, 1e-3)).toBeCloseTo(0, 6); // no loss at DC
    });
    // Monotone in distance: each entry loses more at 8 kHz than the one before.
    for (let i = 1; i < AIR_TABLE.length; i++) expect(airLoss(AIR_TABLE[i]!, 8000)).toBeGreaterThan(airLoss(AIR_TABLE[i - 1]!, 8000));
    expect([airIndex(0.2), airIndex(1), airIndex(25), airIndex(1e4)]).toEqual([0, 0, Math.round(Math.log(25) / Math.log(AIR_STEP)), AIR_TABLE.length - 1]);
  });

  it('the filter plays its fit, and stepping through the table each block does not click', () => {
    // An impulse at 25 m: its spectrum is the fit's.
    const f = new AirFilter(); f.set(25);
    const N = 1 << 14, x = new Float32Array(N); x[0] = 1; f.process(x);
    for (const hz of [1000, 4000, 8000, 16000]) {
      let re = 0, im = 0; for (let n = 0; n < 256; n++) { re += x[n]! * Math.cos((2 * Math.PI * hz * n) / SR); im -= x[n]! * Math.sin((2 * Math.PI * hz * n) / SR); }
      expect(-20 * Math.log10(Math.hypot(re, im))).toBeCloseTo(airLoss(AIR_TABLE[airIndex(25)]!, hz), 2);
    }
    // A 3 kHz tone while the distance walks from 5 to 200 m, one table entry a block: the second difference never
    // jumps above the tone's own (a click would; without the coefficient ramp, the step at 47 m reached 1.41).
    const g = new AirFilter(), blocks = 80, y = new Float32Array(blocks * BLOCK);
    for (let i = 0; i < y.length; i++) y[i] = Math.sin((2 * Math.PI * 3000 * i) / SR);
    let d = 5;
    for (let b = 0; b < blocks; b++, d *= AIR_STEP) { g.set(d); g.process(y, b * BLOCK, (b + 1) * BLOCK); }
    const dd = (i: number) => Math.abs(y[i + 1]! - 2 * y[i]! + y[i - 1]!), w = (2 * Math.PI * 3000) / SR;
    let worst = 0, amp = 0;
    for (let i = BLOCK; i < y.length - 1; i++) { worst = Math.max(worst, dd(i) / (w * w)); amp = Math.max(amp, Math.abs(y[i]!)); }
    expect(worst).toBeLessThan(1.05 * amp);
  });

  it('at 44.1 and 96 kHz the filter follows the standard too (the entry for d (rate / 48 kHz)^2)', () => {
    // The impulse response's spectrum at rate sr against ISO; where the standard loses under 20 dB.
    const resp = (sr: number, d: number, hz: number) => {
      const f = new AirFilter(sr); f.set(d);
      const x = new Float32Array(512); x[0] = 1; f.process(x);
      let re = 0, im = 0; for (let n = 0; n < x.length; n++) { re += x[n]! * Math.cos((2 * Math.PI * hz * n) / sr); im -= x[n]! * Math.sin((2 * Math.PI * hz * n) / sr); }
      return -20 * Math.log10(Math.hypot(re, im));
    };
    for (const [sr, d, tol] of [[44100, 25, 0.2], [44100, 50, 0.25], [96000, 10, 0.8], [96000, 25, 2.5]] as const)
      for (const hz of [2000, 4000, 8000, 12000, 16000]) if (airAlpha(hz) * d < 20) expect(Math.abs(resp(sr, d, hz) - airAlpha(hz) * d), `${sr} Hz, ${d} m, ${hz} Hz`).toBeLessThan(tol);
    // Unscaled, 44.1 kHz would lose 1.4 dB too much at 16 kHz, 25 m.
    expect(airLoss(AIR_TABLE[airIndex(25)]!, 16000, 44100) - airAlpha(16000) * 25).toBeGreaterThan(1.2);
    expect(() => new AirFilter(0)).toThrow(/positive/);
  });

  /** One stream of impacts at distance d, bank and a voice; octave energies of the output. */
  const play = (d: number, space: boolean, air: boolean) => {
    const e = new CollapseEngine({ sampleRate: SR, seed: 5, fullScale: 1e4 });
    e.setMaterial(0, { ...pine, clickBand: 'limited' }, 0.117); e.setSpace(space); e.setAir(air); e.lowcut = 0;
    const A = 1.4 / d, s = sectorOf(0.05, 4), out = new Float32Array(40 * FRAME), L = new Float32Array(BLOCK), R = new Float32Array(BLOCK);
    let due = 0, k = 0;
    for (let b = 0; b * BLOCK < out.length; b++) {
      if (k < 8 && b * BLOCK >= due) {
        const f = frame([{ bin: 2, sector: s, count: 30, a2: 30 * A * A }], [[1.4, d, 0.05, 0, 0.2]]);
        f.space = new Float32Array(SPACE_FIELDS * 4); f.space[SPACE_FIELDS * s] = 31 * A * A; f.space[SPACE_FIELDS * s + 1] = 31 * A * A * 0.05; f.space[SPACE_FIELDS * s + 2] = 31 * A * A * d;
        e.push(f); due += FRAME; k++;
      }
      e.render(L, R);
      for (let i = 0; i < BLOCK && b * BLOCK + i < out.length; i++) out[b * BLOCK + i] = L[i]! + R[i]!;
    }
    return octaves(out);
  };

  it('in the engine: at 25 m the top octave loses what the air takes, the mids nothing; only with space and air on', () => {
    const dry = play(25, true, false), wet = play(25, true, true), off = play(25, false, true);
    const band = (o: number[], i: number) => 10 * Math.log10(o[i]! / dry[i]!);
    // Octave bands from 16 Hz: index 6 = 1-2 kHz, 9 = 8-16 kHz, 10 = 16-24 kHz.
    expect(Math.abs(band(wet, 6))).toBeLessThan(0.2);
    expect(band(wet, 9)).toBeLessThan(-airAlpha(8000) * 25 + 0.5);
    expect(band(wet, 9)).toBeGreaterThan(-airAlpha(16000) * 25 - 0.5);
    expect(band(wet, 10)).toBeLessThan(-airAlpha(16000) * 25 + 1);
    expect(off).toEqual(play(25, false, false)); // air without space does nothing
    const host = new CollapseHost(SR);
    host.onMessage({ type: 'space', on: true, air: true });
    expect([host.engine.space, host.engine.air]).toEqual([true, true]);
    host.onMessage({ type: 'space', on: true });
    expect(host.engine.air).toBe(true); // absent: unchanged
  });
});

// The blast sound (A6): its physics from the blast's reach and distance, the samples, the voice a
// 'blast' feedback makes, and the Synth's cache of built waves.
import { describe, expect, it } from 'vitest';
import { BLAST_TAKES, Synth, voicesFor } from '../src/audio.ts';
import {
  BLAST_B, BLAST_GAIN, BLAST_GAIN_MAX, BLAST_GAIN_MIN, BLAST_MIX, BLAST_T_PER_M, BLAST_T_PER_M_SHORT, blastParams, blastWave, C_AIR, ECHO_START, friedlanderFilter, MAX_DELAY,
  REF_DIST, REF_REACH, RUMBLE_HZ, RUMBLE_HZ_SHORT, RUMBLE_TAU_1M, RUMBLE_TAU_MAX, RUMBLE_TAU_MIN, softClip, TAIL_TAUS,
} from '../src/blast-sound.ts';
import { blastSoundOf } from '../src/options/blastsound.ts';

const SR = 48000;

/** Spectral centroid, Hz, of the first `seconds` of x (direct DFT over 20 Hz-4 kHz in 20 Hz steps). */
function centroid(x: Float32Array, seconds = 0.4): number {
  const n = Math.min(x.length, Math.round(seconds * SR));
  let num = 0, den = 0;
  for (let f = 20; f < 4000; f += 20) {
    let re = 0, im = 0;
    for (let i = 0; i < n; i += 2) { const a = (2 * Math.PI * f * i) / SR; re += x[i]! * Math.cos(a); im += x[i]! * Math.sin(a); }
    const p = re * re + im * im; num += f * p; den += p;
  }
  return num / den;
}

const peakOf = (x: Float32Array) => x.reduce((a, v) => Math.max(a, Math.abs(v)), 0);
const rmsOf = (x: Float32Array) => Math.sqrt(x.reduce((a, v) => a + v * v, 0) / x.length);

describe('blast sound physics', () => {
  it('the Friedlander filter rings out the closed-form pulse, (1 - i/Tn) e^(-B i/Tn)', () => {
    for (const Tn of [12, 40, 96]) {
      const x = new Float32Array(30 * Tn);
      x[0] = 1;
      friedlanderFilter(x, Tn);
      for (let i = 0; i < x.length; i++) expect(x[i]!).toBeCloseTo((1 - i / Tn) * Math.exp((-BLAST_B * i) / Tn), 6);
    }
  });

  it('scales the pulse with the reach (Hopkinson-Cranz), the rumble as its square root, both within range', () => {
    for (const reach of [1.5, 3, 5]) {
      const p = blastParams(reach, REF_DIST);
      expect(p.T).toBeCloseTo(BLAST_T_PER_M * reach, 12);
      expect(p.tau).toBeCloseTo(RUMBLE_TAU_1M * Math.sqrt(reach), 12);
      expect(p.seconds).toBeCloseTo(ECHO_START + TAIL_TAUS * p.tau, 12);
    }
    expect(blastParams(0.1, REF_DIST).tau).toBe(RUMBLE_TAU_MIN);
    // keystone.blastsound=short: A6's pulse (a third as long) and darker rumble; the rest as the boom.
    const boom = blastParams(3, REF_DIST), short = blastParams(3, REF_DIST, true);
    expect(boom.rumbleHz).toBe(RUMBLE_HZ);
    expect(short).toEqual({ ...boom, T: BLAST_T_PER_M_SHORT * 3, rumbleHz: RUMBLE_HZ_SHORT });
    expect(blastParams(50, REF_DIST).tau).toBe(RUMBLE_TAU_MAX);
  });

  it('is as loud as the reach over the distance (clamped), and arrives at the speed of sound', () => {
    expect(blastParams(REF_REACH, REF_DIST).gain).toBeCloseTo(BLAST_GAIN, 12);
    expect(blastParams(3, 20).gain / blastParams(3, 40).gain).toBeCloseTo(2, 12);
    expect(blastParams(3, 20).gain / blastParams(1.5, 20).gain).toBeCloseTo(2, 12);
    expect(blastParams(10, 1).gain).toBe(BLAST_GAIN_MAX);
    expect(blastParams(0.5, 500).gain).toBe(BLAST_GAIN_MIN);
    expect(blastParams(3, 20).delay).toBeCloseTo(20 / C_AIR, 12);
    expect(blastParams(3, 500).delay).toBe(MAX_DELAY);
    expect(() => blastParams(0, 10)).toThrow(/reach must be > 0/);
    expect(() => blastParams(3, -1)).toThrow(/dist >= 0/);
  });

  it('the soft clip is odd, monotone, and meets +-1 at 3', () => {
    let last = -1;
    for (let u = -3; u <= 3; u += 0.01) { const v = softClip(u); expect(v).toBeGreaterThanOrEqual(last); expect(softClip(-u)).toBeCloseTo(-v, 12); last = v; }
    expect(softClip(3)).toBe(1);
    expect(softClip(10)).toBe(1);
    expect(softClip(0.5)).toBeCloseTo(Math.tanh(0.5), 2);
  });
});

describe('blast sound samples', () => {
  const p = blastParams(3, REF_DIST), w = blastWave(p, SR, 1);

  it('peaks at the gain, lasts its seconds, ends silent, carries no DC, and repeats for a seed', () => {
    expect(w.length).toBe(Math.round(p.seconds * SR));
    expect(peakOf(w)).toBeCloseTo(p.gain, 5);
    expect(Math.abs(w[w.length - 1]!)).toBe(0);
    expect(Math.abs(w.reduce((a, v) => a + v, 0) / w.length)).toBeLessThan(0.01 * rmsOf(w));
    expect(blastWave(p, SR, 1)).toEqual(w);
    expect(blastWave(p, SR, 2)).not.toEqual(w);
    expect(w.every(Number.isFinite)).toBe(true);
  });

  it('a bigger blast booms lower (its longer pulse), and the darkened rumble is lower than the raw echoes', () => {
    // Measured centroids (Hz): r1.5 261, r5 148; r3 173, raw echoes 237, darkened at A6's 400 Hz 125.
    const small = centroid(blastWave(blastParams(1.5, REF_DIST), SR, 1)), big = centroid(blastWave(blastParams(5, REF_DIST), SR, 1));
    expect(big).toBeLessThan(0.8 * small);
    const c = centroid(w);
    expect(c).toBeLessThan(0.8 * centroid(blastWave(p, SR, 1, { ...BLAST_MIX, rumbleHz: 0 })));
    expect(centroid(blastWave(p, SR, 1, { ...BLAST_MIX, rumbleHz: RUMBLE_HZ_SHORT }))).toBeLessThan(0.8 * c);
  });

  it('the short style (A6) is the boom with a third of the pulse: a higher crest factor, its raw echoes brighter', () => {
    // A6b: against real explosions (crest 9-12 dB) the A6 boom measured 14-17 dB; the boom 11-12 dB.
    const s = blastParams(3, REF_DIST, true), ws = blastWave(s, SR, 1);
    expect(ws.length).toBe(w.length);
    expect(peakOf(ws)).toBeCloseTo(p.gain, 5);
    expect(peakOf(ws) / rmsOf(ws)).toBeGreaterThan(1.2 * (peakOf(w) / rmsOf(w)));
    expect(centroid(blastWave(s, SR, 1, { ...BLAST_MIX, rumbleHz: 0 }))).toBeGreaterThan(1.5 * centroid(blastWave(p, SR, 1, { ...BLAST_MIX, rumbleHz: 0 })));
  });

  it('the overload brings the rumble up under the peak (crest factor at least halved)', () => {
    const raw = blastWave(p, SR, 1, { ...BLAST_MIX, drive: 0 });
    expect(peakOf(raw)).toBeCloseTo(p.gain, 5);
    expect(peakOf(w) / rmsOf(w)).toBeLessThan(0.5 * (peakOf(raw) / rmsOf(raw)));
  });
});

describe('blast sound in the game', () => {
  const blast = (radius: number, body = 3, step = 10) => ({ t: 'blast' as const, step, body, radius });

  it('a blast booms: one voice, its params from the reach and distance, played after the travel time', () => {
    const v = voicesFor(blast(5), { blastDist: 30 });
    expect(v).toHaveLength(1);
    const p = blastParams(5, 30);
    expect(v[0]).toMatchObject({ kind: 'blast', gain: p.gain, decay: p.seconds, delay: p.delay, blast: p });
    expect(v[0]!.take).toBeGreaterThanOrEqual(0);
    expect(v[0]!.take).toBeLessThan(BLAST_TAKES);
    // No camera distance (a blast at a point, no body): the reference distance.
    expect(voicesFor(blast(5))[0]!.blast).toEqual(blastParams(5, REF_DIST));
    // Blasts going off together take different takes, so they do not add up coherently.
    expect(new Set([0, 1, 2, 3].map((b) => voicesFor(blast(2, b))[0]!.take)).size).toBe(BLAST_TAKES);
  });

  it('keystone.blastsound none keeps blasts silent, short plays A6\'s boom; it reads boom, short or none', () => {
    expect(voicesFor(blast(5), { blastSound: 'none' })).toEqual([]);
    expect(voicesFor(blast(5), { blastDist: 30, blastSound: 'short' })[0]!.blast).toEqual(blastParams(5, 30, true));
    expect(blastSoundOf('short')).toBe('short');
    expect(voicesFor(blast(0))).toEqual([]);
    expect(blastSoundOf('boom')).toBe('boom');
    expect(blastSoundOf('none')).toBe('none');
    expect(() => blastSoundOf('bang')).toThrow(/keystone.blastsound must be boom, short, none: bang/);
  });

  it('the Synth builds each reach and take once, and plays it at the voice gain after its delay', () => {
    const made: number[] = [], started: number[] = [], gains: number[] = [];
    const param = () => ({ value: 0, setValueAtTime: (v: number) => { gains.push(v); }, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => { gains.length = 0; } });
    const node = () => ({ connect: (d: unknown) => d, gain: param(), threshold: param(), ratio: param(), frequency: param(), Q: param(), type: '' });
    const ctx = {
      state: 'running', currentTime: 0, sampleRate: SR, destination: node(),
      createGain: node, createDynamicsCompressor: node, createBiquadFilter: node, createOscillator: () => ({ ...node(), start: () => {}, stop: () => {} }),
      createBuffer: (_c: number, n: number) => { made.push(n); return { getChannelData: () => new Float32Array(n), copyToChannel: () => {} }; },
      createBufferSource: () => ({ ...node(), buffer: null, start: (t: number) => started.push(t), stop: () => {} }),
    };
    const synth = new Synth(ctx as unknown as AudioContext);
    const before = made.length; // the noise buffer
    const a = voicesFor(blast(3, 1), { blastDist: 20 }), b = voicesFor(blast(3, 1), { blastDist: 40 });
    synth.play(a); synth.play(b);
    expect(made.length - before).toBe(1);
    expect(made[made.length - 1]).toBe(Math.round(blastParams(3, 20).seconds * SR));
    expect(started).toEqual([a[0]!.delay, b[0]!.delay]);
    expect(gains[gains.length - 1]).toBeCloseTo(b[0]!.gain, 12);
    synth.play(voicesFor(blast(3, 2), { blastDist: 20 }));
    expect(made.length - before).toBe(2);
    // The short style at the same reach and take is a different wave, so a buffer of its own.
    synth.play(voicesFor(blast(3, 2), { blastDist: 20, blastSound: 'short' }));
    expect(made.length - before).toBe(3);
  });
});

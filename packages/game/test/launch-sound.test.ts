// The launch whump (A10): its physics from the shot, the samples, and how a fired shot picks it.
import { describe, expect, it } from 'vitest';
import { ammoBody, compileLevel, L1 } from '@tb/keystone';
import { voicesFor } from '../src/audio.ts';
import { BARREL_CALIBRES, BLAST_T_1KJ, C_AIR, EFFICIENCY, LAUNCH_GAIN, LAUNCH_GAIN_MAX, LAUNCH_GAIN_MIN, LAUNCH_SECONDS, launchParams, launchShapeOf, launchWave, REF_KE, REPORT_SHARE, STROUHAL, VENT_TRANSITS } from '../src/launch-sound.ts';
import { launchSoundOf } from '../src/options/launchsound.ts';

const SR = 48000;
const cannon = { diameter: 0.5, speed: 15 }, marble = { diameter: 0.2, speed: 20 };
/** The least share of the whump's energy after its first 50 ms (measured: 0.27 cannonball, 0.25 marble; dry 0.05, 0.001). */
const MIN_TAIL = 0.15;

/** Spectral centroid, Hz, of x (direct DFT over 20 Hz-4 kHz in 10 Hz steps: slow but exact enough). */
function centroid(x: Float32Array): number {
  let num = 0, den = 0;
  for (let f = 20; f < 4000; f += 10) {
    let re = 0, im = 0;
    for (let i = 0; i < x.length; i += 2) { const a = (2 * Math.PI * f * i) / SR; re += x[i]! * Math.cos(a); im += x[i]! * Math.sin(a); }
    const p = re * re + im * im; num += f * p; den += p;
  }
  return num / den;
}

describe('launch whump physics', () => {
  it('rings the barrel at its odd quarter-wave partials, BARREL_CALIBRES shots long, with the end correction', () => {
    const p = launchParams(cannon), L = BARREL_CALIBRES * 0.5, f1 = C_AIR / (4 * (L + 0.61 * 0.25));
    expect(p.barrel).toBeCloseTo(L, 12);
    p.partials.forEach((f, k) => expect(f).toBeCloseTo((2 * k + 1) * f1, 9));
    // A shot of half the size has a barrel half as long: an octave up (a little more, the end correction being shorter too).
    expect(launchParams(marble).partials[0]! / p.partials[0]!).toBeCloseTo((L + 0.61 * 0.25) / (BARREL_CALIBRES * 0.2 + 0.61 * 0.1), 9);
  });

  it('scales the muzzle blast as the cube root of the gas energy (Hopkinson-Cranz), the chuff by Strouhal on the bore', () => {
    const a = launchParams(cannon), b = launchParams({ ...cannon, speed: cannon.speed * Math.sqrt(8) }); // 8x the energy
    expect(a.ke).toBeCloseTo(0.5 * 7850 * (4 / 3) * Math.PI * 0.25 ** 3 * 15 * 15, 6);
    expect(a.gas).toBeCloseTo(a.ke * (1 / EFFICIENCY - 1), 6);
    expect(a.blastT).toBeCloseTo(BLAST_T_1KJ * Math.cbrt(a.gas / 1000), 12);
    expect(b.blastT / a.blastT).toBeCloseTo(2, 9);
    expect(a.chuffHz).toBeCloseTo((STROUHAL * C_AIR) / 0.5, 9);
    expect(a.vent).toBeCloseTo((VENT_TRANSITS * a.barrel) / C_AIR, 12);
  });

  it('plays louder for more energy, within LAUNCH_GAIN_MIN..MAX, and LAUNCH_GAIN at REF_KE', () => {
    const gains = [1, 5, 10, 20, 40, 80].map((v) => launchParams({ ...cannon, speed: v }).gain);
    for (let i = 1; i < gains.length; i++) expect(gains[i]!).toBeGreaterThanOrEqual(gains[i - 1]!);
    for (const g of gains) { expect(g).toBeGreaterThanOrEqual(LAUNCH_GAIN_MIN); expect(g).toBeLessThanOrEqual(LAUNCH_GAIN_MAX); }
    const v = Math.sqrt((2 * REF_KE) / launchParams(cannon).mass);
    expect(launchParams({ ...cannon, speed: v }).gain).toBeCloseTo(LAUNCH_GAIN, 9);
    expect(() => launchParams({ diameter: 0, speed: 1 })).toThrow(/diameter/);
  });
});

describe('launch whump samples', () => {
  it('are finite, peak at the gain, end in silence, carry no DC, and repeat exactly', () => {
    const p = launchParams(cannon), x = launchWave(p, SR);
    expect(x.length).toBe(Math.round(LAUNCH_SECONDS * SR));
    let peak = 0, sum = 0;
    for (const v of x) { expect(Number.isFinite(v)).toBe(true); peak = Math.max(peak, Math.abs(v)); sum += v; }
    expect(peak).toBeCloseTo(p.gain, 6);
    expect(Math.abs(x[x.length - 1]!)).toBeLessThan(1e-6);
    expect(Math.abs(sum / x.length)).toBeLessThan(0.01 * p.gain);
    expect(launchWave(p, SR)).toEqual(x);
    expect(launchWave(p, 44100).length).toBe(Math.round(LAUNCH_SECONDS * 44100));
  });

  it('the report (A10b) carries the whump past its first 50 ms, as real launches do; dry is the A10 whump', () => {
    const tail = (x: Float32Array) => { let a = 0, b = 0; const k = Math.round(0.05 * SR); for (let i = 0; i < x.length; i++) (i < k ? (a += x[i]! * x[i]!) : (b += x[i]! * x[i]!)); return b / (a + b); };
    for (const shot of [cannon, marble]) {
      const whump = tail(launchWave(launchParams(shot), SR)), dry = tail(launchWave(launchParams(shot, undefined, 0), SR));
      expect(whump).toBeGreaterThan(MIN_TAIL);
      expect(whump).toBeGreaterThan(3 * dry);
    }
    expect(launchParams(cannon).report).toBe(REPORT_SHARE);
    expect(launchParams(cannon, undefined, 0).report).toBe(0);
    for (const bad of [-0.1, 1.1, NaN]) expect(() => launchParams(cannon, undefined, bad)).toThrow(/report/);
  });

  it('a heavier shot whumps lower: the cannonball\'s centroid is under the marble\'s', () => {
    const c = centroid(launchWave(launchParams(cannon), SR)), m = centroid(launchWave(launchParams(marble), SR));
    expect(c).toBeLessThan(0.8 * m);
  });
});

describe('a fired shot\'s cue', () => {
  const c = compileLevel(L1), h = c.frame.unit;
  const fired = (ammo: string) => ({ t: 'fired', step: 0, ammo, body: c.meta.n, ke: 1 }) as Parameters<typeof voicesFor>[0];

  it('whumps from the fired body (keystone.launchsound=whump, the default), the old glide with glide or no body', () => {
    const ball = launchShapeOf(ammoBody('cannonball', h, [0, 1, 0], [15, 0, 0]))!;
    expect(ball).toEqual({ diameter: expect.closeTo(h, 9), speed: 15, rho: 7800, sphere: true });
    const w = voicesFor(fired('cannonball'), { launch: ball });
    expect(w).toHaveLength(1);
    expect(w[0]!.kind).toBe('launch');
    expect(w[0]!.launch).toEqual(launchParams(ball));
    expect(w[0]!.gain).toBe(launchParams(ball).gain);
    for (const g of [voicesFor(fired('cannonball'), { launch: ball, launchSound: 'glide' }), voicesFor(fired('cannonball'))]) {
      expect(g).toEqual([{ kind: 'tone', wave: 'sine', freq: 70, gain: 0.35, decay: 0.22, delay: 0, glide: 0.5 }]);
    }
  });

  it('a drop (released) and a cue (pushed) keep the glide; a pull, plunger and quake keep their own', () => {
    const anvil = launchShapeOf(ammoBody('drop', h, [0, 5, 0], [0, 0, 0]))!;
    expect(voicesFor(fired('drop'), { launch: anvil })[0]!.kind).toBe('tone');
    expect(voicesFor(fired('cue'), { launch: anvil })[0]!.kind).toBe('tone');
    for (const a of ['pull', 'plunger', 'quake']) expect(voicesFor(fired(a), { launch: anvil }).some((v) => v.kind === 'launch'), a).toBe(false);
    expect(launchShapeOf(undefined)).toBeNull();
  });

  it('keystone.launchsound reads whump, dry or glide; dry is the whump without its report', () => {
    expect(launchSoundOf('whump')).toBe('whump');
    expect(launchSoundOf('dry')).toBe('dry');
    expect(launchSoundOf('glide')).toBe('glide');
    expect(() => launchSoundOf('boom')).toThrow(/keystone.launchsound must be whump, dry, glide: boom/);
    const ball = launchShapeOf(ammoBody('cannonball', h, [0, 1, 0], [15, 0, 0]))!;
    expect(voicesFor(fired('cannonball'), { launch: ball })[0]!.launch!.report).toBe(REPORT_SHARE);
    const dry = voicesFor(fired('cannonball'), { launch: ball, launchSound: 'dry' });
    expect(dry).toHaveLength(1);
    expect(dry[0]!.kind).toBe('launch');
    expect(dry[0]!.launch).toEqual(launchParams(ball, undefined, 0));
  });
});

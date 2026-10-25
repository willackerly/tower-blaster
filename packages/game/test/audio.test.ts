import { describe, expect, it } from 'vitest';
import { BANDS, type Feedback, materialId } from '@tb/keystone';
import { degree, limitVoices, MAX_VOICES, PENTATONIC, ROOT, type Voice, voicesFor } from '../src/audio.ts';

/** True if f is ROOT times a pentatonic ratio times a power of two. */
const onScale = (f: number) => PENTATONIC.some((r) => { const o = Math.log2(f / (ROOT * r)); return Math.abs(o - Math.round(o)) < 1e-9; });
const valid = (v: Voice) => v.gain > 0 && v.gain <= 0.6 && v.decay > 0 && v.decay <= 3 && v.freq > 20 && v.freq < 20000 && v.delay >= 0;
const score = { lines: [], total: 0, stars: 3 as const, stamp: 'PAR', leverage: 1 };

describe('voices for feedback', () => {
  it('degrees wrap into octaves', () => {
    expect(degree(0)).toBe(ROOT);
    expect(degree(5)).toBe(2 * ROOT);
    expect(degree(-1)).toBeCloseTo((ROOT * 5) / 3 / 2, 9);
  });
  it('crowns climb the scale and stay on it', () => {
    const fs = [0, 1, 2, 3, 4, 5, 6].map((ordinal) => voicesFor({ t: 'crownDown', step: 0, body: 0, ordinal })[0]!.freq);
    for (let i = 1; i < fs.length; i++) expect(fs[i]).toBeGreaterThan(fs[i - 1]!);
    expect(fs.every(onScale)).toBe(true);
  });
  it('impacts give one voice per active bin, pitched by band, louder for more bodies', () => {
    const hist = new Uint32Array(6 * BANDS);
    const plaster = materialId('plaster'), stone = materialId('stone');
    hist[plaster * BANDS + 1] = 1; hist[plaster * BANDS + 6] = 9; hist[stone * BANDS + 3] = 4;
    const vs = voicesFor({ t: 'impacts', step: 0, hist, total: 14 });
    expect(vs).toHaveLength(3);
    expect(vs.every((v) => onScale(v.freq) && valid(v))).toBe(true);
    expect(vs[1]!.freq).toBeGreaterThan(vs[0]!.freq);
    expect(vs[1]!.gain).toBeGreaterThan(vs[0]!.gain);
    expect(vs[0]!.kind).toBe('noise'); // plaster knocks; stone rings
    expect(vs[2]!.kind).toBe('tone');
  });
  it('every event makes valid voices; heritage is the only dissonance', () => {
    const events: Feedback[] = [
      { t: 'fired', step: 0, ammo: 'marble', body: 0, ke: 1 },
      { t: 'contact', step: 0, body: 0, dv: 3, impulse: 3000 },
      { t: 'heritageCrack', step: 0, body: 0 },
      { t: 'tier', step: 0, leverage: 20, tier: 2 },
      { t: 'levelEnd', step: 0, cleared: true, score },
      { t: 'levelEnd', step: 0, cleared: false, score },
    ];
    for (const e of events) {
      const vs = voicesFor(e);
      expect(vs.length).toBeGreaterThan(0);
      expect(vs.every(valid)).toBe(true);
    }
    const crack = voicesFor({ t: 'heritageCrack', step: 0, body: 0 }).filter((v) => v.kind === 'tone');
    expect(crack[1]!.freq / crack[0]!.freq).toBeCloseTo(Math.SQRT2, 3);
    expect(voicesFor({ t: 'slowMo', step: 0, body: 0 })).toEqual([]);
  });
  it('limits a collapse to the loudest voices', () => {
    const vs: Voice[] = Array.from({ length: 20 }, (_, k) => ({ kind: 'tone', freq: 440, gain: k / 100, decay: 0.1, delay: 0 }));
    const kept = limitVoices(vs);
    expect(kept).toHaveLength(MAX_VOICES);
    expect(Math.min(...kept.map((v) => v.gain))).toBe((20 - MAX_VOICES) / 100);
  });
});

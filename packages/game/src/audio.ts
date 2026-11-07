// Sound, synthesised (no samples): feedback events map to voices by a pure
// function, and a thin WebAudio player renders them. Everything melodic sits
// on one major pentatonic scale, so any pile of impacts sounds consonant.
import { BANDS, type Feedback, MATERIALS } from '@tb/keystone';

export type Wave = 'sine' | 'triangle' | 'square' | 'sawtooth';
export interface Voice {
  /** 'tone' is an oscillator; 'noise' is band-passed noise centred on freq. */
  kind: 'tone' | 'noise';
  freq: number;
  wave?: Wave;
  /** Peak gain, 0..1 before the master. */
  gain: number;
  /** Seconds to fall to silence (exponential). */
  decay: number;
  /** Seconds from now. */
  delay: number;
  /** Ratio the pitch glides to over the decay (1 = none). */
  glide?: number;
}

export const PENTATONIC = [1, 9 / 8, 5 / 4, 3 / 2, 5 / 3];
export const ROOT = 220; // A3
export const MAX_VOICES = 8;

/** Pentatonic degree k (any integer, wraps into octaves) above `root`. */
export const degree = (k: number, root = ROOT) => root * PENTATONIC[((k % 5) + 5) % 5]! * 2 ** Math.floor(k / 5);

const TIMBRE: Record<string, { kind: Voice['kind']; wave?: Wave; octave: number; decay: number }> = {
  plaster: { kind: 'noise', octave: 2, decay: 0.07 },
  stone: { kind: 'tone', wave: 'triangle', octave: 0, decay: 0.12 },
  iron: { kind: 'tone', wave: 'square', octave: 1, decay: 0.35 },
  ice: { kind: 'tone', wave: 'sine', octave: 3, decay: 0.25 },
  rubber: { kind: 'tone', wave: 'sine', octave: -1, decay: 0.1 },
  steel: { kind: 'tone', wave: 'triangle', octave: 2, decay: 0.3 },
};

/**
 * A struck bell (Rube Lab, PT26): a church bell's partials over its strike note (hum 1/2, prime 1, minor-third
 * tierce 1.2, quint 1.5, nominal 2; Rossing, The Science of Sound, ch. 13), the low ones ringing longest, so it
 * reads as a bell and not as one more crown's arpeggio note. Five voices, under MAX_VOICES.
 */
export const BELL_PARTIALS: readonly { ratio: number; gain: number; decay: number }[] = [
  { ratio: 0.5, gain: 0.12, decay: 2.6 }, { ratio: 1, gain: 0.22, decay: 1.8 }, { ratio: 1.2, gain: 0.12, decay: 1.4 },
  { ratio: 1.5, gain: 0.08, decay: 1.1 }, { ratio: 2, gain: 0.1, decay: 0.9 },
];
/** The bell's strike note: an octave over the crowns' first (degree 10 of the pentatonic), A5. */
export const BELL_NOTE = degree(10);

/**
 * opts.impacts false: the collision sound (@tb/audio, collapse-sound.ts) plays the impacts, so
 * `impacts` and `contact` make no voices here; the cues (launch, crowns, heritage, tier, level end) stay.
 * opts.bell: the level's crowns are bells (objective 'bell'), and a crown down rings as one (BELL_PARTIALS).
 */
export function voicesFor(fb: Feedback, opts: { impacts?: boolean; bell?: boolean } = {}): Voice[] {
  if (opts.impacts === false && (fb.t === 'impacts' || fb.t === 'contact')) return [];
  switch (fb.t) {
    case 'fired':
      // A pull: a short dry scrape, the block sliding out.
      if (fb.ammo === 'pull') return [{ kind: 'noise', freq: 600, gain: 0.22, decay: 0.16, delay: 0 }];
      // A plunger: a click; its charges are heard as their blasts.
      if (fb.ammo === 'plunger') return [{ kind: 'noise', freq: 2400, gain: 0.15, decay: 0.04, delay: 0 }];
      // A quake: a low rumble rising; the shaking itself is heard as the towers' impacts.
      if (fb.ammo === 'quake') return [{ kind: 'noise', freq: 120, gain: 0.3, decay: 1.2, delay: 0 }, { kind: 'tone', wave: 'sine', freq: 38, gain: 0.3, decay: 1.5, delay: 0, glide: 0.8 }];
      // A soft whump, heavier for heavier shots.
      return [{ kind: 'tone', wave: 'sine', freq: fb.ammo === 'cannonball' ? 70 : fb.ammo === 'drop' ? 55 : 110, gain: 0.35, decay: 0.22, delay: 0, glide: 0.5 }];
    case 'contact': {
      const g = Math.min(0.6, 0.12 + 0.07 * Math.log2(1 + fb.impulse / 50));
      return [{ kind: 'noise', freq: 900, gain: g, decay: 0.09, delay: 0 }, { kind: 'tone', wave: 'sine', freq: 60, gain: g, decay: 0.25, delay: 0, glide: 0.7 }];
    }
    case 'impacts': {
      // One voice per (material, band) bin that fired this step, louder for more bodies; low bands sound low.
      const out: Voice[] = [];
      for (let bin = 0; bin < fb.hist.length; bin++) {
        const count = fb.hist[bin]!;
        if (!count) continue;
        const m = MATERIALS[Math.floor(bin / BANDS)], band = bin % BANDS, tb = TIMBRE[m?.name ?? 'plaster']!;
        out.push({ kind: tb.kind, ...(tb.wave ? { wave: tb.wave } : {}), freq: degree(band + 5 * tb.octave), gain: Math.min(0.25, 0.05 * Math.sqrt(count)), decay: tb.decay, delay: 0 });
      }
      return out;
    }
    case 'crownDown':
      if (opts.bell) return BELL_PARTIALS.map((p) => ({ kind: 'tone', wave: 'sine', freq: BELL_NOTE * p.ratio, gain: p.gain, decay: p.decay, delay: 0 }));
      // Each crown climbs the scale: a run of them plays an arpeggio.
      return [
        { kind: 'tone', wave: 'triangle', freq: degree(fb.ordinal + 10), gain: 0.3, decay: 0.7, delay: 0 },
        { kind: 'tone', wave: 'sine', freq: degree(fb.ordinal + 15), gain: 0.12, decay: 0.5, delay: 0 },
      ];
    case 'heritageCrack':
      // The one dissonance in the game: a tritone.
      return [
        { kind: 'tone', wave: 'sawtooth', freq: 311.13, gain: 0.18, decay: 0.45, delay: 0, glide: 0.94 },
        { kind: 'tone', wave: 'sawtooth', freq: 440, gain: 0.18, decay: 0.45, delay: 0, glide: 0.94 },
        { kind: 'noise', freq: 2500, gain: 0.25, decay: 0.12, delay: 0 },
      ];
    case 'iceCrack':
      // Ice cracking: a dry high tick, brighter and louder as the crack grows (level 1 to 7).
      return [{ kind: 'noise', freq: 3500 + 500 * fb.level, gain: 0.06 + 0.025 * fb.level, decay: 0.05, delay: 0 }];
    case 'shatter':
      // A block of ice shattering: a burst of hiss and a quick run of high chimes down the scale (the pieces).
      return [
        { kind: 'noise', freq: 6000, gain: 0.35, decay: 0.25, delay: 0 },
        ...[19, 17, 16, 14].map((k, i) => ({ kind: 'tone' as const, wave: 'sine' as const, freq: degree(k), gain: 0.1, decay: 0.35 - 0.05 * i, delay: 0.015 * i })),
      ];
    case 'tier':
      // A singing bowl: inharmonic partials with a long tail, higher for each tier.
      return [1, 2.76, 5.4].map((r, k) => ({ kind: 'tone' as const, wave: 'sine' as const, freq: degree(5 * (fb.tier - 1)) * r, gain: 0.22 / (k + 1), decay: 2.6 / (k + 1), delay: 0 }));
    case 'levelEnd':
      return fb.cleared
        ? [0, 2, 4, 7, 9].map((k, i) => ({ kind: 'tone' as const, wave: 'triangle' as const, freq: degree(k + 10), gain: 0.25, decay: 0.9, delay: 0.09 * i }))
        : [4, 2, 0].map((k, i) => ({ kind: 'tone' as const, wave: 'sine' as const, freq: degree(k + 5), gain: 0.2, decay: 0.5, delay: 0.16 * i }));
    default:
      return [];
  }
}

/** Keep the loudest `max` voices: a collapse can fire dozens of bins in one step. */
export function limitVoices(vs: Voice[], max = MAX_VOICES): Voice[] {
  return vs.length <= max ? vs : [...vs].sort((a, b) => b.gain - a.gain).slice(0, max);
}

/** WebAudio renderer for voices. Created on the first user gesture (autoplay policy). */
export class Synth {
  private readonly out: GainNode;
  /** Where the page's sounds meet (the synth's own output goes here too). */
  readonly master: AudioNode;
  private readonly noise: AudioBuffer;
  muted = false;

  constructor(readonly ctx: AudioContext, dest: AudioNode = ctx.destination) {
    this.master = dest;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 6;
    this.out = ctx.createGain();
    this.out.gain.value = 0.7;
    this.out.connect(comp).connect(dest);
    // One second of white noise from a fixed LCG: no randomness at runtime.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    let x = 0x2545f491;
    for (let i = 0; i < d.length; i++) { x = (Math.imul(x, 1664525) + 1013904223) >>> 0; d[i] = x / 2 ** 31 - 1; }
  }

  play(vs: Voice[]) {
    if (this.muted || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    for (const v of limitVoices(vs)) {
      const t0 = now + v.delay, env = this.ctx.createGain();
      env.gain.setValueAtTime(0.0001, t0);
      env.gain.exponentialRampToValueAtTime(Math.max(0.0002, v.gain), t0 + 0.004);
      env.gain.exponentialRampToValueAtTime(0.0001, t0 + v.decay);
      env.connect(this.out);
      let src: AudioScheduledSourceNode;
      if (v.kind === 'noise') {
        const n = this.ctx.createBufferSource(), bp = this.ctx.createBiquadFilter();
        n.buffer = this.noise;
        bp.type = 'bandpass'; bp.frequency.value = v.freq; bp.Q.value = 1.2;
        n.connect(bp).connect(env);
        src = n;
      } else {
        const o = this.ctx.createOscillator();
        o.type = v.wave ?? 'sine';
        o.frequency.setValueAtTime(v.freq, t0);
        if (v.glide && v.glide !== 1) o.frequency.exponentialRampToValueAtTime(v.freq * v.glide, t0 + v.decay);
        o.connect(env);
        src = o;
      }
      src.start(t0);
      src.stop(t0 + v.decay + 0.05);
    }
  }
}

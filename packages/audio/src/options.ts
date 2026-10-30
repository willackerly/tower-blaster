// The sound's options as the viewer edits them (Scene panel, snd.* URL
// params, the config file): on or off, which material, and a few knobs over
// it. Knobs at their defaults leave the material exactly as SOUND_MATERIALS
// has it; the URL carries only what differs.
//
//   snd=1               sound on (off by default: nothing runs)
//   snd.mat=pine        pine | acrylic | stone | auto (the scene's: see the viewer)
//   snd.volume=-6       master, dB
//   snd.ring=3          the modes (ringing), dB over the material's
//   snd.click=-3        the contact click, dB over the material's
//   snd.damping=2       loss factor x: rings die twice as fast
//   snd.pitch=-5        semitones (stiffness x 2^(st/6), so every mode moves)
//   snd.spread=2        body-to-body pitch spread x
//   snd.dv=0.25         slowest speed change that sounds, m/s
//   snd.voices=8        loudest impacts a frame played as their own voices
//   snd.lowcut=35       master high-pass, Hz (0: off): below it only headroom is spent
import { SOUND_MATERIALS, type SoundMaterial } from './material.ts';

export type SoundMaterialName = keyof typeof SOUND_MATERIALS;
export const SOUND_MATERIAL_NAMES = Object.keys(SOUND_MATERIALS) as SoundMaterialName[];

export const SOUND_KNOBS = {
  volume: { label: 'volume (dB)', min: -40, max: 20, step: 1, def: 0 },
  ring: { label: 'ring (dB)', min: -40, max: 20, step: 1, def: 0 },
  click: { label: 'click (dB)', min: -40, max: 20, step: 1, def: 0 },
  damping: { label: 'damping x', min: 0.1, max: 10, step: 0.1, def: 1 },
  pitch: { label: 'pitch (semitones)', min: -24, max: 24, step: 1, def: 0 },
  spread: { label: 'pitch spread x', min: 0, max: 5, step: 0.1, def: 1 },
  dv: { label: 'quietest hit (m/s)', min: 0.05, max: 5, step: 0.05, def: 0.25 },
  voices: { label: 'loudest hits as voices', min: 0, max: 32, step: 1, def: 8 },
  lowcut: { label: 'low cut (Hz)', min: 0, max: 300, step: 5, def: 35 },
} as const;
export type SoundKnob = keyof typeof SOUND_KNOBS;

export interface SoundOptions extends Record<SoundKnob, number> {
  on: boolean;
  material: SoundMaterialName | 'auto';
}

export const DEFAULT_SOUND: SoundOptions = {
  on: false, material: 'auto',
  ...(Object.fromEntries(Object.entries(SOUND_KNOBS).map(([k, v]) => [k, v.def])) as Record<SoundKnob, number>),
};

/** Throws unless every knob is in range (and voices whole). */
export function checkSound(o: SoundOptions): SoundOptions {
  if (o.material !== 'auto' && !SOUND_MATERIAL_NAMES.includes(o.material)) throw new Error(`snd.mat must be auto or one of ${SOUND_MATERIAL_NAMES.join(', ')}: ${String(o.material)}`);
  for (const k of Object.keys(SOUND_KNOBS) as SoundKnob[]) {
    const r = SOUND_KNOBS[k], v = o[k];
    if (!(typeof v === 'number' && v >= r.min && v <= r.max)) throw new Error(`snd.${k} (${r.label}) must be from ${r.min} to ${r.max}: ${String(v)}`);
  }
  if (!Number.isInteger(o.voices)) throw new Error(`snd.voices must be a whole number: ${o.voices}`);
  return o;
}

/** Options from URL params snd and snd.<knob>; absent ones are the defaults. */
export function parseSoundOptions(q: URLSearchParams): SoundOptions {
  const o: SoundOptions = { ...DEFAULT_SOUND };
  const on = q.get('snd');
  if (on !== null) {
    if (!['0', '1', 'true', 'false', ''].includes(on)) throw new Error(`snd must be 1 or 0: ${on}`);
    o.on = on === '1' || on === 'true' || on === '';
  }
  const mat = q.get('snd.mat');
  if (mat !== null) o.material = mat as SoundOptions['material'];
  for (const k of Object.keys(SOUND_KNOBS) as SoundKnob[]) {
    const v = q.get(`snd.${k}`);
    if (v !== null) o[k] = v.trim() === '' ? NaN : Number(v);
  }
  return checkSound(o);
}

/** Write the options that differ from the defaults into q. */
export function writeSoundOptions(o: SoundOptions, q: URLSearchParams): void {
  if (o.on) q.set('snd', '1');
  if (o.material !== DEFAULT_SOUND.material) q.set('snd.mat', o.material);
  for (const k of Object.keys(SOUND_KNOBS) as SoundKnob[]) if (o[k] !== DEFAULT_SOUND[k]) q.set(`snd.${k}`, String(o[k]));
}

/** The material the knobs make of a base material. */
export function tunedMaterial(base: SoundMaterial, o: Pick<SoundOptions, 'ring' | 'click' | 'damping' | 'pitch' | 'spread'>): SoundMaterial {
  const stiff = 2 ** (o.pitch / 6);
  return {
    ...base,
    E: base.E * stiff,
    ...(base.G !== undefined ? { G: base.G * stiff } : {}),
    eta: base.eta * o.damping,
    jitter: Math.min(0.49, base.jitter * o.spread),
    ringDb: base.ringDb + o.ring,
    clickDb: base.clickDb + o.click,
  };
}

// What the master does with a capture (capture-cli.ts): render it through CollapseEngine at a few
// volumes and report the output peak, the most the limiter took off, its steepest gain change, and
// the spectrum (octave bands, dB of the total). wav=dir also writes each volume's output.
// usage: tsx packages/audio/src/levels-cli.ts frames.json [mat=stone edge=1 lowcut=35 wav=dir]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BLOCK, CollapseEngine } from './engine.ts';
import type { AudioFrame } from './frame.ts';
import { SOUND_MATERIALS, type SoundMaterial } from './material.ts';
import { FULL_SCALE } from './host.ts';

const [file, ...kv] = process.argv.slice(2);
const o: Record<string, string> = { mat: 'stone', edge: '1', lowcut: '35', wav: '' };
for (const a of kv) { const [k, v] = a.split('='); if (!(k! in o)) throw new Error(`unknown option ${k}`); o[k!] = v!; }
const SR = 48000, frames = (JSON.parse(readFileSync(file!, 'utf8')) as { frames: { dt: number; counts: number[]; a2: number[]; top: number[] }[] }).frames;
const material = SOUND_MATERIALS[o.mat as keyof typeof SOUND_MATERIALS] as SoundMaterial;

/** The capture through an engine at fullScale; L and R. */
function render(fullScale: number) {
  const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale });
  e.setMaterial(0, material, +o.edge!);
  e.lowcut = +o.lowcut!;
  const L: number[] = [], R: number[] = [], l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  const out = () => { e.render(l, r); L.push(...l); R.push(...r); };
  let due = 0;
  for (const f of frames) {
    e.push({ dt: f.dt, materials: 1, sectors: 4, counts: Float32Array.from(f.counts), a2: Float32Array.from(f.a2), top: Float32Array.from(f.top) } satisfies AudioFrame);
    for (due += f.dt * SR; due >= BLOCK; due -= BLOCK) out();
  }
  for (let b = 0; b < 60; b++) out();
  return { L, R };
}

/** Octave bands from 16 Hz (Welch, 2^14-sample Hann frames), dB of the total. */
function octaves(x: number[]): number[] {
  const N = 1 << 14, bands = new Float64Array(11);
  for (let off = 0; off + N <= x.length; off += N / 2) {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
    for (let i = 1, j = 0; i < N; i++) { let bit = N >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j]!, re[i]!]; }
    for (let len = 2; len <= N; len <<= 1) for (let i = 0; i < N; i += len) for (let k = 0; k < len / 2; k++) {
      const a = (-2 * Math.PI * k) / len, wr = Math.cos(a), wi = Math.sin(a), p = i + k, q = p + len / 2;
      const vr = re[q]! * wr - im[q]! * wi, vi = re[q]! * wi + im[q]! * wr;
      re[q] = re[p]! - vr; im[q] = im[p]! - vi; re[p]! += vr; im[p]! += vi;
    }
    for (let k = 1; k < N / 2; k++) bands[Math.min(10, Math.max(0, Math.floor(Math.log2((k * SR) / N / 16))))]! += re[k]! ** 2 + im[k]! ** 2;
  }
  const t = bands.reduce((a, b) => a + b, 0);
  return [...bands].map((e) => +(10 * Math.log10(e / t)).toFixed(1));
}

function wav(path: string, L: number[], R: number[]) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4), q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(L[i]!), 44 + 4 * i); buf.writeInt16LE(q(R[i]!), 46 + 4 * i); }
  writeFileSync(path, buf);
}

// Unlimited (the limiter never acts at this full scale): the signal the limiter is handed, in Pa.
const BIG = 1e6, raw = render(BIG);
console.log(`${o.mat}, edge ${o.edge} m, low cut ${o.lowcut} Hz; octaves from 16 Hz (dB of total): ${octaves(raw.L).join(' ')}`);
const rows = [];
if (o.wav) mkdirSync(o.wav, { recursive: true });
for (const volume of [0, 6, 12, 20]) {
  const fs = FULL_SCALE / 10 ** (volume / 20), out = render(fs);
  // Gain on each sample loud enough to read it (the limiter's delay is in both renders); its steepest change.
  let peak = 0, least = 1, steepest = 0, prev = NaN, at = 0;
  for (let i = 0; i < out.L.length; i++) {
    peak = Math.max(peak, Math.abs(out.L[i]!), Math.abs(out.R[i]!));
    const x = (raw.L[i]! * BIG) / fs;
    if (Math.abs(x) < 0.05) continue;
    const g = out.L[i]! / x;
    least = Math.min(least, g);
    if (!Number.isNaN(prev)) steepest = Math.max(steepest, Math.abs(20 * Math.log10(g / prev)) / (i - at));
    prev = g; at = i;
  }
  rows.push({ volumeDb: volume, peak: +peak.toFixed(3), limitedDb: +(20 * Math.log10(least)).toFixed(1), steepestDbPerSample: +steepest.toFixed(3) });
  if (o.wav) wav(`${o.wav}/${o.mat}-vol${volume}.wav`, out.L, out.R);
}
console.table(rows);

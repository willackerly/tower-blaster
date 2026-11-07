// The listening ladder (docs/sound.md, Material identity): scripted impacts, simplest first, rendered
// per material so each step can be described (tools/sound-judge) and listened to before the next.
//   knock     one block dropped 5 cm onto a resting one, both ring, two small bounces
//   clatter   six blocks tipping off a ledge at random over 1.2 s, each strikes twice
//   tumble    60 impacts over 2.5 s, exponential speeds (mean 1.5 m/s): a small pile coming down
// The frames are what the tap would post (buildFrame's definition: dv, distance, pan, material, pitch),
// built directly from the script, so a step isolates the synth from the physics.
// usage: tsx packages/audio/src/ladder-cli.ts out=dir [steps=knock,clatter,tumble mats=stone,plaster set=real|classic
//        edge=0.05 dist=0.6 name=tag m.<key>=<value> <knob>=<value>]
import { mkdirSync, writeFileSync } from 'node:fs';
import { BLOCK, CollapseEngine } from './engine.ts';
import { type AudioFrame, binOf, cellOf, DV_EDGES, pitchZ, sectorOf, TOP_FIELDS } from './frame.ts';
import { SOUND_SETS, type SoundMaterial, soundMaterials, type SoundSet } from './material.ts';
import { SOUND_KNOBS, type SoundKnob, tunedMaterial } from './options.ts';

const SR = 48000, FPS = 60, SECTORS = 4, TOP = 8;

/** One impact: time (s), speed change (m/s), distance (m), pan (-1..1), the body (its pitch). */
export interface Hit { t: number; dv: number; dist: number; pan: number; body: number }

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** The ladder's scripts, at a listening distance (m). Restitution 0.35 for the bounces. */
export function script(step: string, dist: number): Hit[] {
  const g = 9.81, e = 0.35, hits: Hit[] = [];
  // A drop of h onto a resting twin: the falling block loses (1 + e)/2 of its speed, the struck one gains it.
  const drop = (t0: number, v: number, body: number, pan: number, bounces: number) => {
    let t = t0, u = v;
    for (let k = 0; k <= bounces && u > 0.05; k++) {
      const dv = (u * (1 + e)) / 2;
      hits.push({ t, dv, dist, pan, body }, { t, dv, dist, pan: pan * 0.9, body: body + 1000 });
      u *= e; t += (2 * u) / g;
    }
  };
  if (step === 'knock') drop(0.2, Math.sqrt(2 * g * 0.05), 1, 0, 2);
  else if (step === 'clatter') {
    const r = rng(2);
    // Onsets uniform over 1.2 s, not a 0.2 s cadence: six evenly spaced strikes read as a rhythm ("Music").
    for (let i = 0; i < 6; i++) drop(0.2 + 1.2 * r(), 1.2 + 1.8 * r(), 10 + i, (r() - 0.5), 1);
  } else if (step === 'tumble') {
    const r = rng(3);
    for (let i = 0; i < 60; i++) hits.push({ t: 0.2 + 2.5 * r() ** 1.5, dv: -1.5 * Math.log(1 - 0.95 * r()), dist, pan: 1.2 * (r() - 0.5), body: 100 + Math.floor(25 * r()) });
  } else throw new Error(`unknown step ${step}`);
  return hits.sort((a, b) => a.t - b.t);
}

/** The frames a 60 Hz tap would post for these hits, every hit on material slot 0. */
export function framesOf(hits: readonly Hit[], seconds: number): AudioFrame[] {
  const n = Math.ceil(seconds * FPS), out: AudioFrame[] = [], cells = DV_EDGES.length * SECTORS;
  for (let f = 0, j = 0; f < n; f++) {
    const counts = new Float32Array(cells), a2 = new Float32Array(cells), cand: number[][] = [];
    for (; j < hits.length && hits[j]!.t < (f + 1) / FPS; j++) {
      const h = hits[j]!, d = Math.max(h.dist, 0.5), A = h.dv / d, c = cellOf(0, binOf(h.dv), sectorOf(h.pan, SECTORS), SECTORS);
      counts[c]! += 1; a2[c]! += A * A;
      cand.push([A, h.dv, d, h.pan, 0, pitchZ(h.body)]);
    }
    cand.sort((p, q) => q[0]! - p[0]!);
    const k = Math.min(TOP, cand.length), top = new Float32Array(k * TOP_FIELDS);
    for (let i = 0; i < k; i++) top.set(cand[i]!.slice(1), i * TOP_FIELDS);
    out.push({ dt: 1 / FPS, materials: 1, sectors: SECTORS, counts, a2, top });
  }
  return out;
}

/** Renders frames through the collapse engine with one material: stereo, peak-normalised to 0.5 when asked. */
export function renderLadder(frames: readonly AudioFrame[], m: SoundMaterial, edge: number, tail = 1): { L: Float32Array; R: Float32Array } {
  const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: 3000 }); // far under the limiter: the ladder hears the synth, not the limiter
  e.setMaterial(0, m, edge);
  const n = Math.ceil(((frames.length / FPS + tail) * SR) / BLOCK), L = new Float32Array(n * BLOCK), R = new Float32Array(n * BLOCK);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let due = 0, b = 0;
  const out = () => { e.render(l, r); L.set(l, b * BLOCK); R.set(r, b * BLOCK); b++; };
  for (const f of frames) { e.push(f); for (due += f.dt * SR; due >= BLOCK && b < n; due -= BLOCK) out(); }
  while (b < n) out();
  return { L, R };
}

function wav(path: string, L: Float32Array, R: Float32Array) {
  const n = L.length, buf = Buffer.alloc(44 + n * 8);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i]!, 44 + 8 * i); buf.writeFloatLE(R[i]!, 48 + 8 * i); }
  writeFileSync(path, buf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const kv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
  const KEYS = new Set(['out', 'steps', 'mats', 'set', 'edge', 'dist', 'name', ...Object.keys(SOUND_KNOBS)]);
  for (const k of Object.keys(kv)) if (!KEYS.has(k) && !k.startsWith('m.')) throw new Error(`unknown option ${k}`);
  if (!kv.out) throw new Error('out= is required');
  const set = (kv.set ?? 'real') as SoundSet;
  if (!(SOUND_SETS as readonly string[]).includes(set)) throw new Error(`set must be one of ${SOUND_SETS.join(', ')}: ${set}`);
  const mats = soundMaterials(set) as Record<string, SoundMaterial>;
  const knobs = Object.fromEntries((Object.keys(SOUND_KNOBS) as SoundKnob[]).map((k) => [k, kv[k] === undefined ? SOUND_KNOBS[k].def : Number(kv[k])])) as Record<SoundKnob, number>;
  const over = Object.fromEntries(Object.entries(kv).filter(([k]) => k.startsWith('m.')).map(([k, v]) => [k.slice(2), Number.isNaN(Number(v)) ? v : Number(v)]));
  const edge = Number(kv.edge ?? 0.05), dist = Number(kv.dist ?? 0.6);
  mkdirSync(kv.out, { recursive: true });
  for (const step of (kv.steps ?? 'knock,clatter,tumble').split(',')) {
    const hits = script(step, dist), seconds = hits[hits.length - 1]!.t + 0.1;
    for (const name of (kv.mats ?? Object.keys(mats).join(',')).split(',')) {
      if (!mats[name]) throw new Error(`unknown material ${name}`);
      const m = { ...tunedMaterial(mats[name]!, knobs), ...over } as SoundMaterial;
      const { L, R } = renderLadder(framesOf(hits, seconds), m, edge);
      let peak = 0;
      for (let i = 0; i < L.length; i++) peak = Math.max(peak, Math.abs(L[i]!), Math.abs(R[i]!));
      const g = peak > 0 ? 0.5 / peak : 1; // level-free: the ladder compares timbre
      for (let i = 0; i < L.length; i++) { L[i]! *= g; R[i]! *= g; }
      wav(`${kv.out}/${step}-${name}-${kv.name ?? set}.wav`, L, R);
      console.log(`${step} ${name} ${set}: ${hits.length} hits, peak ${peak.toExponential(2)}`);
    }
  }
}

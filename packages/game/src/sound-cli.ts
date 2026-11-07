// The game's collision sound, offline: plays each level's par line on the AVBD reference (which pins them; the GPU solver the page plays on matches it),
// taps one AudioFrame per step from the game's opening camera (viewOf) as the page does, and renders
// it through @tb/audio's collapse synth with the game's sound slots (sound-map.ts). Per level: the
// impacts per slot, the peak at volume 0 (the limiter's ceiling is 0.9), how much it limited, and the
// energy above 1 kHz. A capture is plain data, so a change to the synth is checked on the same frames.
// Also the loudness (ITU-R BS.1770, LUFS): how the game levels one material set against the other (sound-map.ts).
// Any built-in level (findLevel); its par line, else its showcase (ace), else shots= (writeShots text, e.g. a trial's).
// usage: tsx packages/game/src/sound-cli.ts [levels=L1,L2 wav=dir frames=dir (writes captures) from=dir (reads them) set=real|real1|classic db=(the set's level) shots=cannonball.0.16.0.20.100]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { type AudioFrame, BLOCK, CollapseEngine, FrameTap, type FrameRecord, framesFrom, FULL_SCALE, loudness, SOUND_SETS, type SoundSet } from '@tb/audio';
import { AMMO_KINDS, ammoBody, MATERIALS, AVBD_GAP_SLOP, AVBD_ITERATIONS, compileLevel, levelById, LEVELS, readShots, runSession, type Shot } from '@tb/keystone';
import type { PhysicsEngine } from '@tb/engine-api';
import { PRESET_NAMES } from '@tb/weapons';
import { eyeOf } from '@tb/render/camera';
import { gameSoundDb, slotSounds, SOUND_SLOTS, soundSlotOf } from './sound-map.ts';
import { viewOf } from './view.ts';

const kv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
for (const k of Object.keys(kv)) if (!['levels', 'wav', 'frames', 'from', 'db', 'set', 'shots'].includes(k)) throw new Error(`unknown option ${k}`);
const set = (kv.set ?? 'real') as SoundSet;
if (!(SOUND_SETS as readonly string[]).includes(set)) throw new Error(`set must be one of ${SOUND_SETS.join(', ')}: ${set}`);
const ids = (kv.levels ?? LEVELS.map((l) => l.id).join(',')).split(',');
const SR = 48000;

/** The frames the page's tap would post for this level's par line (one per step: the game steps once a 60 Hz frame). */
export async function capture(id: string, engine: PhysicsEngine = new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP }), given?: readonly Shot[]): Promise<{ frames: AudioFrame[]; slots: number[] }> {
  const def = levelById(id), shots = (given ?? def.solutions?.par ?? def.solutions?.ace ?? []) as Shot[];
  if (!shots.length) throw new Error(`${id} has no par or showcase line: give shots=`);
  const c = compileLevel(def);
  const o = viewOf(c), eye = eyeOf(o), f = [o.target[0] - eye[0], o.target[2] - eye[2]], l = Math.hypot(f[0]!, f[1]!);
  const tap = new FrameTap({ materials: SOUND_SLOTS, sectors: 4 }), frames: AudioFrame[] = [], slots = new Array<number>(SOUND_SLOTS).fill(0);
  let n = 0;
  await runSession(engine, c, shots, {
    perStep: (d) => {
      const s = d.snapshot;
      // Each body by its description, as the page does (driver.bodies: structure, ammo, and spawned debris such as ice's).
      for (; n < s.count; n++) tap.setMaterial(n, soundSlotOf(c, d.bodies[n] ?? (n < c.meta.n ? c.scene.bodies[n]! : ammoBody(shots[n - c.meta.n]!.ammo, c.frame.unit, [0, 0, 0], [0, 0, 0])), n, set !== 'classic'));
      const fr = tap.frame(s, { metres: 1, camera: { pos: eye, right: [-f[1]! / l, 0, f[0]! / l] }, dvMin: 0.25, dt: c.scene.dt, top: 8, slide: { gravity: [c.scene.gravity[0], c.scene.gravity[1], c.scene.gravity[2]] } });
      frames.push(fr);
      for (let i = 0; i < fr.counts.length; i++) slots[Math.floor(i / (fr.counts.length / SOUND_SLOTS))]! += fr.counts[i]!;
      return [];
    },
  });
  return { frames, slots };
}

/** Render frames through the level's slot sounds of a material set at the game's master gain (dB over @tb/audio's full scale; default the set's). */
export function render(id: string, frames: AudioFrame[], db?: number, set: SoundSet = 'real'): { L: Float32Array; R: Float32Array; minGain: number } {
  db ??= gameSoundDb(set);
  const c = compileLevel(levelById(id)), e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: FULL_SCALE / 10 ** (db / 20) });
  slotSounds(c, set).forEach((x, i) => e.setMaterial(i, x.material, x.edge));
  const n = Math.ceil((frames.reduce((s, f) => s + f.dt, 0) * SR) / BLOCK) + 160, L = new Float32Array(n * BLOCK), R = new Float32Array(n * BLOCK);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let due = 0, b = 0;
  const out = () => { e.render(l, r); L.set(l, b * BLOCK); R.set(r, b * BLOCK); b++; };
  for (const f of frames) { e.push(f); for (due += f.dt * SR; due >= BLOCK && b < n; due -= BLOCK) out(); }
  while (b < n) out();
  return { L, R, minGain: e.limiter.minGain };
}

function load(path: string): { frames: AudioFrame[]; slots: number[] } {
  const j = JSON.parse(readFileSync(path, 'utf8')) as { slots: number[]; frames: FrameRecord[] };
  return { slots: j.slots, frames: framesFrom(j.frames) };
}

function wav(path: string, L: Float32Array, R: Float32Array) {
  const n = L.length, buf = Buffer.alloc(44 + n * 4), q = (x: number) => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) { buf.writeInt16LE(q(L[i]!), 44 + 4 * i); buf.writeInt16LE(q(R[i]!), 46 + 4 * i); }
  writeFileSync(path, buf);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const names = [...MATERIALS.map((m) => m.name), ...AMMO_KINDS, 'ice pieces', ...PRESET_NAMES, 'kapla'];
  for (const dir of [kv.wav, kv.frames]) if (dir) mkdirSync(dir, { recursive: true });
  const rows = [];
  for (const id of ids) {
    const { frames, slots } = kv.from ? load(`${kv.from}/${id}.json`) : await capture(id, undefined, kv.shots === undefined ? undefined : readShots(kv.shots));
    if (kv.frames) writeFileSync(`${kv.frames}/${id}.json`, JSON.stringify({ slots, frames: frames.map((f) => ({ ...f, counts: [...f.counts], a2: [...f.a2], top: [...f.top], space: f.space ? [...f.space] : undefined, slide: f.slide ? [...f.slide] : undefined })) }));
    const v0 = render(id, frames, kv.db === undefined ? undefined : Number(kv.db), set);
    let peak = 0;
    for (let i = 0; i < v0.L.length; i++) peak = Math.max(peak, Math.abs(v0.L[i]!), Math.abs(v0.R[i]!));
    if (kv.wav) wav(`${kv.wav}/${id}.wav`, v0.L, v0.R);
    rows.push({ level: id, seconds: +(frames.length / 60).toFixed(1), impacts: Object.fromEntries(slots.map((x, i) => [names[i], x]).filter(([, x]) => x)), peak: +peak.toFixed(2), 'limited dB': +(20 * Math.log10(v0.minGain)).toFixed(1), LUFS: +loudness(v0.L, v0.R).toFixed(1) });
  }
  for (const r of rows) console.log(JSON.stringify(r));
}

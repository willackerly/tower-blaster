// Renders captured frames (sound-cli.ts frames=dir for L1-L5; @tb/audio capture-cli.ts for the viewer's
// city and kapla) with the materials changed, as WAVs for the realism judge (tools/sound-judge) and
// for listening. This is how the real set's values were picked (docs/sound.md, Realism).
//   set=real|classic   the material set (default real)
//   as=stone           slot 0 (plaster, the game's structure) or the viewer scene's material, from the set
//   only=0,6           only these slots sound (the game: 0-5 Keystone materials, 6-10 ammo)
//   m.<key>=<value>    a material key on every slot (m.roughDb=-12 m.eta=0.08 m.law=velocity)
//   a.<key>=<value>    a material key on the ammo slots only, after m. (a.roughDb=-60 a.Ec=2e9)
//   <knob>=<value>     the viewer's knobs over every slot (damping=2 ring=-6 rough=3 dense=-6 ...)
//   vol=0 edge=1       the viewer scenes: volume (dB over FULL_SCALE) and the block edge (m)
// usage: tsx packages/game/src/sound-sweep-cli.ts from=dir out=dir name=tag [levels=L1,L2,L3|city|kapla] [options]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { type AudioFrame, BLOCK, CollapseEngine, FULL_SCALE, SOUND_KNOBS, type SoundKnob, type SoundMaterial, soundMaterials, type SoundSet, tunedMaterial } from '@tb/audio';
import { compileLevel, LEVELS } from '@tb/keystone';
import { AMMO_SLOT, gameSoundDb, slotSounds } from './sound-map.ts';

const kv = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=') as [string, string]));
const KEYS = new Set(['from', 'out', 'name', 'levels', 'set', 'as', 'only', 'vol', 'edge', ...Object.keys(SOUND_KNOBS)]);
for (const k of Object.keys(kv)) if (!KEYS.has(k) && !k.startsWith('m.') && !k.startsWith('a.')) throw new Error(`unknown option ${k}`);
if (!kv.from || !kv.out || !kv.name) throw new Error('from=, out= and name= are required');
const set = (kv.set ?? 'real') as SoundSet;
if (set !== 'real' && set !== 'classic') throw new Error(`set must be real or classic: ${set}`);
const knobs = Object.fromEntries((['ring', 'click', 'grit', 'damping', 'pitch', 'spread', 'rough', 'dense'] as SoundKnob[]).map((k) => [k, kv[k] === undefined ? SOUND_KNOBS[k].def : Number(kv[k])])) as Record<SoundKnob, number>;
const keyed = (p: string) => Object.fromEntries(Object.entries(kv).filter(([k]) => k.startsWith(p)).map(([k, v]) => [k.slice(2), Number.isNaN(Number(v)) ? v : Number(v)]));
const over = keyed('m.'), ammoOver = keyed('a.');
const tune = (m: SoundMaterial, ammo = false): SoundMaterial => ({ ...tunedMaterial(m, knobs), ...over, ...(ammo ? ammoOver : {}) });
const mats = soundMaterials(set) as Record<string, SoundMaterial>, only = kv.only?.split(',').map(Number), SR = 48000;
if (kv.as && !mats[kv.as]) throw new Error(`as must be a sound material: ${kv.as}`);

function wav(path: string, L: Float32Array, R: Float32Array) {
  const n = L.length, buf = Buffer.alloc(44 + n * 8); // 32-bit float, stereo
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 8, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(3, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 8, 28); buf.writeUInt16LE(8, 32); buf.writeUInt16LE(32, 34); buf.write('data', 36); buf.writeUInt32LE(n * 8, 40);
  for (let i = 0; i < n; i++) { buf.writeFloatLE(L[i]!, 44 + 8 * i); buf.writeFloatLE(R[i]!, 48 + 8 * i); }
  writeFileSync(path, buf);
}

mkdirSync(kv.out, { recursive: true });
for (const id of (kv.levels ?? 'L1,L2,L3').split(',')) {
  const j = JSON.parse(readFileSync(`${kv.from}/${id}.json`, 'utf8')) as { frames: (Omit<AudioFrame, 'counts' | 'a2' | 'top'> & { counts: number[]; a2: number[]; top: number[] })[] };
  const frames: AudioFrame[] = j.frames.map((f) => ({ ...f, counts: Float32Array.from(f.counts), a2: Float32Array.from(f.a2), top: Float32Array.from(f.top) }));
  const viewer = id === 'city' || id === 'kapla';
  const e = new CollapseEngine({ sampleRate: SR, seed: 1, fullScale: FULL_SCALE / 10 ** ((viewer ? Number(kv.vol ?? 0) : gameSoundDb(set)) / 20) });
  if (viewer) e.setMaterial(0, tune(mats[kv.as ?? (id === 'kapla' ? 'pine' : 'acrylic')]!), Number(kv.edge ?? 1));
  else slotSounds(compileLevel(LEVELS.find((l) => l.id === id)!), set).forEach((x, i) =>
    e.setMaterial(i, only && !only.includes(i) ? null : tune(i === 0 && kv.as ? mats[kv.as]! : x.material, i >= AMMO_SLOT), x.edge));
  const n = Math.ceil((frames.reduce((s, f) => s + f.dt, 0) * SR) / BLOCK) + 160, L = new Float32Array(n * BLOCK), R = new Float32Array(n * BLOCK);
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let due = 0, b = 0;
  const out = () => { e.render(l, r); L.set(l, b * BLOCK); R.set(r, b * BLOCK); b++; };
  for (const f of frames) { e.push(f); for (due += f.dt * SR; due >= BLOCK && b < n; due -= BLOCK) out(); }
  while (b < n) out();
  wav(`${kv.out}/${id}-${kv.name}.wav`, L, R);
}

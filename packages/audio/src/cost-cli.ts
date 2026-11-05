// The audio thread's load on a capture (capture-cli.ts, or a game capture from @tb/game
// sound-cli.ts frames=dir): wall time CollapseEngine takes to push and render it, as a share of
// one core in real time (best of `reps`), with grit on and off. V8 runs the AudioWorklet the same
// way, so on a physical machine this is the synth's real cost; on a VM or CI it is a sanity check.
// usage: tsx packages/audio/src/cost-cli.ts frames.json [mat=stone edge=1 reps=5 set=real|classic]
import { readFileSync } from 'node:fs';
import { BLOCK, CollapseEngine } from './engine.ts';
import type { AudioFrame } from './frame.ts';
import { type SoundMaterial, soundMaterials, type SoundSet } from './material.ts';

const [file, ...kv] = process.argv.slice(2);
const o: Record<string, string> = { mat: 'stone', edge: '1', reps: '5', set: 'real' };
for (const a of kv) { const [k, v] = a.split('='); if (!(k! in o)) throw new Error(`unknown option ${k}`); o[k!] = v!; }
type Raw = { dt: number; materials?: number; sectors?: number; counts: number[]; a2: number[]; top: number[] };
const json = JSON.parse(readFileSync(file!, 'utf8')) as { frames: Raw[] };
if (o.set !== 'real' && o.set !== 'classic') throw new Error(`set must be real or classic: ${o.set}`);
const SR = 48000, base = (soundMaterials(o.set as SoundSet) as Record<string, SoundMaterial>)[o.mat!];
if (!base) throw new Error(`unknown material ${o.mat}`);
const frames: AudioFrame[] = json.frames.map((f) => ({ dt: f.dt, materials: f.materials ?? 1, sectors: f.sectors ?? 4, counts: Float32Array.from(f.counts), a2: Float32Array.from(f.a2), top: Float32Array.from(f.top) }));
const seconds = frames.reduce((s, f) => s + f.dt, 0), slots = frames[0]?.materials ?? 1;
let impacts = 0;
for (const f of frames) for (const c of f.counts) impacts += c;

function run(m: SoundMaterial): { ms: number; grains: number } {
  const e = new CollapseEngine({ sampleRate: SR, seed: 1 });
  for (let i = 0; i < slots; i++) e.setMaterial(i, m, +o.edge!); // a game capture: every slot the one material
  const l = new Float32Array(BLOCK), r = new Float32Array(BLOCK);
  let due = 0;
  const t0 = performance.now();
  for (const f of frames) { e.push(f); for (due += f.dt * SR; due >= BLOCK; due -= BLOCK) e.render(l, r); }
  return { ms: performance.now() - t0, grains: e.grains };
}

console.log(`${file}: ${seconds.toFixed(1)} s, ${impacts} impacts, ${slots} slot(s), ${o.mat} (${o.set}) at ${o.edge} m`);
for (const [name, m] of [['grit on', base], ['grit off', { ...base, gritDb: -Infinity }]] as const) {
  let best = Infinity, grains = 0;
  for (let i = 0; i < +o.reps!; i++) { const x = run(m); best = Math.min(best, x.ms); grains = x.grains; }
  console.log(`${name.padEnd(9)} ${(best / 10 / seconds).toFixed(1).padStart(5)}% of a core (best of ${o.reps}), ${(grains / seconds).toFixed(0)} grains/s`);
}

// The AudioFrames the viewer's tap would post while a ball knocks down a city (S5 on Rapier, real
// units: cubes of 1 m), one per 60 Hz step, heard from the viewer's default camera (yaw 36, pitch
// 12 degrees) at `dist` metres from the city's middle. levels-cli.ts renders them.
// usage: tsx packages/audio/src/capture-cli.ts out.json [N=10000 F=6 H=20 steps=420 dist=75]
import { writeFileSync } from 'node:fs';
import { RapierEngine } from '@tb/adapter-rapier';
import { buildScenario } from '@tb/scenarios';
import { FrameTap } from './tap.ts';

const [out = 'frames.json', ...kv] = process.argv.slice(2);
const o: Record<string, number> = { N: 10000, F: 6, H: 20, steps: 420, dist: 75 };
for (const a of kv) { const [k, v] = a.split('='); if (!(k! in o)) throw new Error(`unknown option ${k}`); o[k!] = Number(v); }
// The viewer's default ball (1.4 m across, 40 m/s, 8x a cube's density), fired at step 30.
const scene = buildScenario('S5', { N: o.N!, F: o.F!, H: o.H!, radius: 0.7, speed: 40, massRatio: 11.5, fireStep: 30 }, 1);
const n0 = scene.bodies.length, xs = scene.bodies.map((b) => b.pos[0]), zs = scene.bodies.map((b) => b.pos[2]);
const target = [(Math.min(...xs) + Math.max(...xs)) / 2, o.H! / 2, (Math.min(...zs) + Math.max(...zs)) / 2] as const;
const yaw = (36 * Math.PI) / 180, pitch = (12 * Math.PI) / 180, d = o.dist!;
const eye: [number, number, number] = [target[0] + d * Math.cos(pitch) * Math.sin(yaw), target[1] + d * Math.sin(pitch), target[2] + d * Math.cos(pitch) * Math.cos(yaw)];
const fx = target[0] - eye[0], fz = target[2] - eye[2], rl = Math.hypot(fx, fz);
const right: [number, number, number] = [-fz / rl, 0, fx / rl];
const eng = new RapierEngine();
await eng.init(scene);
const tap = new FrameTap({ materials: 1, sectors: 4 });
const frames: { dt: number; counts: number[]; a2: number[]; top: number[] }[] = [];
let slots = 0;
for (let s = 0; s < o.steps!; s++) {
  await eng.step();
  const snap = await eng.snapshot();
  for (; slots < snap.count; slots++) tap.setMaterial(slots, slots < n0 ? 0 : -1); // the ball is silent, as in the viewer
  const f = tap.frame(snap, { metres: 1, camera: { pos: eye, right }, dvMin: 0.25, dt: 1 / 60, top: 8 });
  frames.push({ dt: f.dt, counts: [...f.counts], a2: [...f.a2], top: [...f.top] });
}
writeFileSync(out, JSON.stringify({ bodies: n0, eye, frames }));
console.error(`${n0} bodies, ${frames.reduce((s, f) => s + f.counts.reduce((a, b) => a + b, 0), 0)} impacts in ${frames.length} frames -> ${out}`);
eng.dispose();

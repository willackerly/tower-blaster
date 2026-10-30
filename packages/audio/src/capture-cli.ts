// The AudioFrames the viewer's tap would post while a ball knocks something down on Rapier, about
// one per 60 Hz of real time, as the viewer hears it. levels-cli.ts renders them.
//   city   (S5) cubes of 1 m, heard from the viewer's default camera (yaw 36, pitch 12 degrees)
//          `dist` metres from the city's middle (75).
//   kapla  (S15) real Kapla planks (KAPLA_SCALE m a unit), heard standing (eye 1.7 m) `dist` metres
//          from the tower's foot (6). The scene runs in unit time, which is real time sped up by
//          k = sqrt(1 / KAPLA_SCALE); the tap reads every few steps and gets real speeds.
// usage: tsx packages/audio/src/capture-cli.ts out.json [scene=city|kapla N=10000 F=6 H=20 planks=3000 steps= dist=]
import { writeFileSync } from 'node:fs';
import { RapierEngine } from '@tb/adapter-rapier';
import { buildScenario, KAPLA_SCALE } from '@tb/scenarios';
import { FrameTap } from './tap.ts';

const [out = 'frames.json', ...kv] = process.argv.slice(2);
const kv2 = Object.fromEntries(kv.map((a) => a.split('=') as [string, string]));
const kapla = (kv2.scene ?? 'city') === 'kapla';
if (!['city', 'kapla'].includes(kv2.scene ?? 'city')) throw new Error(`scene must be city or kapla: ${kv2.scene}`);
const o: Record<string, number> = kapla ? { planks: 3000, steps: 1200, dist: 6 } : { N: 10000, F: 6, H: 20, steps: 420, dist: 75 };
for (const [k, v] of Object.entries(kv2)) { if (k === 'scene') continue; if (!(k in o)) throw new Error(`unknown option ${k}`); o[k] = Number(v); }
// city: the viewer's default ball (1.4 m across, 40 m/s, 8x a cube's density), fired at step 30. kapla: the scene's own topple.
const scene = kapla ? buildScenario('S15', { planks: o.planks! }, 1) : buildScenario('S5', { N: o.N!, F: o.F!, H: o.H!, radius: 0.7, speed: 40, massRatio: 11.5, fireStep: 30 }, 1);
const metres = kapla ? KAPLA_SCALE : 1, k = kapla ? Math.sqrt(1 / KAPLA_SCALE) : 1, every = Math.max(1, Math.round(k)); // steps a frame: ~60 Hz of real time
const n0 = scene.bodies.length, xs = scene.bodies.map((b) => b.pos[0]), zs = scene.bodies.map((b) => b.pos[2]);
let eye: [number, number, number], target: readonly [number, number, number];
if (kapla) {
  // In metres: the tower's foot, and the eye standing dist from it on the side the ball pushes it toward (+x).
  target = [0, 1.7, 0];
  eye = [o.dist!, 1.7, 0.3 * o.dist!];
} else {
  target = [(Math.min(...xs) + Math.max(...xs)) / 2, o.H! / 2, (Math.min(...zs) + Math.max(...zs)) / 2];
  const yaw = (36 * Math.PI) / 180, pitch = (12 * Math.PI) / 180, d = o.dist!;
  eye = [target[0] + d * Math.cos(pitch) * Math.sin(yaw), target[1] + d * Math.sin(pitch), target[2] + d * Math.cos(pitch) * Math.cos(yaw)];
}
const fx = target[0] - eye[0], fz = target[2] - eye[2], rl = Math.hypot(fx, fz);
const right: [number, number, number] = [-fz / rl, 0, fx / rl];
const eng = new RapierEngine();
await eng.init(scene);
const tap = new FrameTap({ materials: 1, sectors: 4 });
const frames: { dt: number; counts: number[]; a2: number[]; top: number[] }[] = [];
let slots = 0;
for (let s = 0; s < o.steps!; s++) {
  await eng.step();
  if ((s + 1) % every) continue;
  const snap = await eng.snapshot();
  for (; slots < snap.count; slots++) tap.setMaterial(slots, slots < n0 ? 0 : -1); // the ball is silent, as in the viewer
  // Real speeds (units/s x k; the tap's metres turn units into metres) over real time.
  const linVel = k === 1 ? snap.linVel : snap.linVel.map((v) => v * k);
  const f = tap.frame({ count: snap.count, pos: snap.pos, linVel }, { metres, camera: { pos: eye, right }, dvMin: 0.25, dt: every * scene.dt / k, top: 8 });
  frames.push({ dt: f.dt, counts: [...f.counts], a2: [...f.a2], top: [...f.top] });
}
writeFileSync(out, JSON.stringify({ bodies: n0, metres, eye, frames }));
console.error(`${n0} bodies, ${frames.reduce((s, f) => s + f.counts.reduce((a, b) => a + b, 0), 0)} impacts in ${frames.length} frames -> ${out}`);
eng.dispose();

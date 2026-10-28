// Scenes and measures for the restitution tests (engine-restitution*.test.ts),
// after physics-ref/test/restitution.test.ts: the same bodies and the same
// "at contact" rebound measure, taken from per-step snapshots so the GPU's
// runs (steppedRun in page.ts) and the reference's are measured alike.
import { expect } from 'vitest';
import { type BodyDesc, type CombineRule, inertiaOf, massOf, type SceneDesc, type Snapshot, type Vec3, spawnedBodies } from '@tb/engine-api';
import { rotate } from '@tb/geom';
import { type AvbdParams, AvbdReferenceEngine, type StepStats } from '@tb/physics-ref';
import { buildScenario } from '@tb/scenarios';
import type { GpuEngineOptions, GpuRestitutionStats } from '../src/index.ts';
import { call, toSnap } from './harness.ts';

export const G = 9.81, H = 1 / 60;
export const ON: Partial<AvbdParams> = { restitution: true };
export const rotZ = (a: number): [number, number, number, number] => [0, 0, -Math.sin(a / 2), Math.cos(a / 2)];
export const cube = (pos: Vec3, o: { e?: number; linVel?: Vec3; rot?: [number, number, number, number]; density?: number; friction?: number } = {}): BodyDesc => ({
  shape: { kind: 'box', half: [0.5, 0.5, 0.5] }, pos, rot: o.rot ?? [0, 0, 0, 1], linVel: o.linVel ?? [0, 0, 0], angVel: [0, 0, 0], density: o.density ?? 1, friction: o.friction ?? 0.6, restitution: o.e ?? 0, tag: 0,
});
export const ball = (pos: Vec3, o: { e?: number; linVel?: Vec3; mass?: number; radius?: number; friction?: number } = {}): BodyDesc => {
  const r = o.radius ?? 0.5;
  return {
    shape: { kind: 'sphere', radius: r }, pos, rot: [0, 0, 0, 1], linVel: o.linVel ?? [0, 0, 0], angVel: [0, 0, 0],
    density: (o.mass ?? 1) / ((4 / 3) * Math.PI * r ** 3), friction: o.friction ?? 0.6, restitution: o.e ?? 0, tag: -1,
  };
};
/** A scene on a ground of restitution groundE (undefined: unset, 0), or in zero g with no ground. */
export const sceneOf = (bodies: BodyDesc[], o: { gravity?: Vec3; ground?: boolean; groundE?: number; friction?: number; rule?: CombineRule } = {}): SceneDesc => ({
  id: 'test', params: {}, seed: 1, gravity: o.gravity ?? [0, -G, 0], dt: H,
  ground: o.ground === false ? null : { y: 0, friction: o.friction ?? 0.6, ...(o.groundE !== undefined ? { restitution: o.groundE } : {}) },
  sleep: false, ...(o.rule ? { restitutionCombine: o.rule } : {}), bodies, inputs: [],
});

/** Every body of the scene in body order, spawned ones included (the snapshot's order). */
const allBodies = (s: SceneDesc) => [...s.bodies, ...spawnedBodies([...s.inputs].sort((a, b) => a.step - b.step))];

/** Semi-implicit Euler's invariant energy of the bodies present: 1/2 m |v + g h/2|^2 - m g.x + 1/2 w.I w. */
export function shadowEnergy(scene: SceneDesc, s: Snapshot): number {
  const bodies = allBodies(scene), g = scene.gravity, h = scene.dt;
  let E = 0;
  for (let i = 0; i < s.count; i++) {
    const m = massOf(bodies[i]!), I = inertiaOf(bodies[i]!);
    const v = [0, 1, 2].map((k) => s.linVel[3 * i + k]! + g[k]! * h / 2);
    const q: [number, number, number, number] = [-s.rot[4 * i]!, -s.rot[4 * i + 1]!, -s.rot[4 * i + 2]!, s.rot[4 * i + 3]!];
    const wb = rotate(q, [s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!]);
    E += 0.5 * m * (v[0]! ** 2 + v[1]! ** 2 + v[2]! ** 2) + 0.5 * (I[0] * wb[0] ** 2 + I[1] * wb[1] ** 2 + I[2] * wb[2] ** 2);
    E -= m * (g[0] * s.pos[3 * i]! + g[1] * s.pos[3 * i + 1]! + g[2] * s.pos[3 * i + 2]!);
  }
  return E;
}
export const speed = (s: Snapshot, i: number) => Math.hypot(s.linVel[3 * i]!, s.linVel[3 * i + 1]!, s.linVel[3 * i + 2]!);
export const spin = (s: Snapshot, i: number) => Math.hypot(s.angVel[3 * i]!, s.angVel[3 * i + 1]!, s.angVel[3 * i + 2]!);
export const maxSpeed = (s: Snapshot) => { let m = 0; for (let i = 0; i < s.count; i++) m = Math.max(m, speed(s, i)); return m; };

export interface Run {
  snaps: Snapshot[];
  stats: Array<StepStats['restitution'] | null>;
  /** GPU runs with stats: GpuAvbdEngine.restitutionStats() after the last step. */
  live?: GpuRestitutionStats | null;
}
/** The reference's run, a snapshot after every step (snaps[0] the start) and its pass's stats. */
export async function refRun(scene: SceneDesc, steps: number, params: Partial<AvbdParams>): Promise<Run> {
  const e = new AvbdReferenceEngine(params);
  await e.init(scene);
  const snaps = [e.snapshot()], stats: Run['stats'] = [];
  for (let k = 0; k < steps; k++) {
    e.step();
    snaps.push(e.snapshot());
    stats.push(params.restitution ? structuredClone(e.world!.stats.restitution) : null);
  }
  return { snaps, stats };
}
/** The GPU's run (steppedRun), checked healthy; stats only if asked (each is a readback). */
export async function gpuRun(scene: SceneDesc, steps: number, params: Partial<AvbdParams>, opts: Omit<GpuEngineOptions, 'device'> = {}, stats = false): Promise<Run> {
  const r = await call('steppedRun', scene, steps, params, opts, stats);
  expect(r.error).toBeNull();
  expect(r.diagnostics.uncolored).toBe(0);
  expect(r.diagnostics.colorOverflow).toBe(0);
  expect(r.diagnostics.pairsRequired).toBeLessThanOrEqual(r.diagnostics.pairsWritten);
  return { snaps: r.snaps.map(toSnap), stats: r.stats.map((x) => (x ? { ...x, momentum: [NaN, NaN, NaN] } : null)), live: r.live };
}

/** The energy a run gains: the largest rise of the shadow energy over its start, relative to |E0| (or to `scale`), and the end over the start. */
export function gainOf(scene: SceneDesc, r: Run, scale?: number) {
  const E0 = shadowEnergy(scene, r.snaps[0]!);
  let eMax = E0;
  for (const s of r.snaps) eMax = Math.max(eMax, shadowEnergy(scene, s));
  return { gain: (eMax - E0) / (scale ?? Math.abs(E0)), end: shadowEnergy(scene, r.snaps.at(-1)!) / E0 };
}

export type Shape = 'sphere' | 'cube' | 'edge';
/**
 * The reference test's drop(): body 0 onto the ground at impact speed v; the ground's e is the body's unless
 * groundE says otherwise. Run for the fall and 30 steps more (the reference test runs 3x the fall and 60 more):
 * the rebound is measured on its first free step.
 */
export function dropScene(shape: Shape, v: number, e: number, o: { vt?: number; groundE?: number; rule?: CombineRule } = {}) {
  const vt = o.vt ?? 0, yc = shape === 'edge' ? Math.SQRT1_2 : 0.5, height = v * v / (2 * G);
  const pos: Vec3 = [0, yc + height, 0], linVel: Vec3 = [vt, 0, 0];
  const friction = vt ? 0 : 0.6;
  const body = shape === 'sphere' ? ball(pos, { e, linVel, friction }) : cube(pos, { e, linVel, rot: shape === 'edge' ? rotZ(Math.PI / 4) : undefined, friction });
  const scene = sceneOf([body], { friction, groundE: 'groundE' in o ? o.groundE : e, rule: o.rule });
  return { scene, yc, steps: Math.ceil(v / (G * H)) + 30 };
}
/**
 * The first bounce of body 0 (the reference test's measure): eV, the rebound over the impact speed at contact
 * (0 if it never left), the largest spin from the impact on, the largest energy over the start, the lowest
 * height under touching, and the tangential speed at the rebound.
 */
export function bounceOf(scene: SceneDesc, yc: number, r: Run) {
  const E0 = shadowEnergy(scene, r.snaps[0]!);
  const atContact = (y: number, vy: number) => Math.sqrt(Math.max(0, (vy - G * H / 2) ** 2 + 2 * G * (y - yc)));
  const at = (s: Snapshot) => ({ y: s.pos[1]!, vy: s.linVel[1]! });
  let prev = at(r.snaps[0]!), vIn = 0, vOut = 0, impact = false, spinMax = 0, eMax = E0, minY = Infinity, vtOut = NaN, impactStep = -1;
  for (let k = 1; k < r.snaps.length; k++) {
    const s = r.snaps[k]!, cur = at(s);
    eMax = Math.max(eMax, shadowEnergy(scene, s));
    const free = Math.abs(cur.vy - prev.vy + G * H) < 1e-4;
    if (!impact && !free) { impact = true; vIn = atContact(prev.y, prev.vy); impactStep = k; }
    if (impact) {
      spinMax = Math.max(spinMax, spin(s, 0));
      minY = Math.min(minY, cur.y);
      if (!vOut && prev.vy > 0 && free) { vOut = atContact(prev.y, prev.vy); vtOut = s.linVel[0]!; }
    }
    prev = cur;
  }
  return { eV: vIn ? vOut / vIn : 0, vIn, spinMax, eGain: (eMax - E0) / Math.abs(E0), minY: minY - yc, vtOut, impactStep };
}

/** A scene of these bodies with no gravity and no ground. */
export const zeroG = (bodies: BodyDesc[], rule?: CombineRule) => sceneOf(bodies, { gravity: [0, 0, 0], ground: false, rule });
/** Every body's (and spawned body's) restitution set to e, and the ground's. */
export const withE = (s: SceneDesc, e: number): SceneDesc => ({
  ...s, ground: s.ground && { ...s.ground, restitution: e },
  bodies: s.bodies.map((b) => ({ ...b, restitution: e })), inputs: s.inputs.map((ev) => (ev.kind === 'spawn' ? { ...ev, body: { ...ev.body, restitution: e } } : ev)),
});
/** An S5 knockdown: a ball at this speed into a 48-cube city. */
export const knock = (speed: number) => buildScenario('S5', { N: 48, F: 2, H: 12, fireStep: 0, speed, massRatio: 5, radius: 0.6 }, 1);
/** Every snapshot's floats, for bit-for-bit comparisons. */
export const floats = (r: Run) => r.snaps.map((s) => [...s.pos, ...s.rot, ...s.linVel, ...s.angVel]);
/** The same scene, steps and params on the GPU and on the reference. */
export const both = async (scene: SceneDesc, steps: number, params: Partial<AvbdParams>, stats = false) => ({ gpu: await gpuRun(scene, steps, params, {}, stats), ref: await refRun(scene, steps, params) });
/** A body dropped onto the ground at v (dropScene), and its rebound on both engines (bounceOf). */
export const drop = async (shape: Shape, v: number, e: number, params: Partial<AvbdParams> = ON, o: Parameters<typeof dropScene>[3] = {}) => {
  const { scene, yc, steps } = dropScene(shape, v, e, o);
  const r = await both(scene, steps, params);
  return { gpu: bounceOf(scene, yc, r.gpu), ref: bounceOf(scene, yc, r.ref) };
};

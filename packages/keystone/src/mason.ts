// Mason's Trial (M8, docs/game/masons-trial.md): build, then test. Time stops
// and the player places pieces from a budget (C9's build phase); then the
// level's test runs: a ball rolls over the bridge, debris falls on the
// shelter, boulders roll at the berm, a weight drops on the overhang, or the
// ground shakes. The build is judged in K worlds at once (C10 islands): world
// 0 is the build exactly as placed (the one the player watches), worlds 1 to
// K - 1 are jittered copies (every placed piece nudged across the ground, the
// test's probes nudged and their speed varied), and the score counts how many
// worlds pass. Only that count is read: an island is not bit for bit its solo
// run once bodies touch (docs/design/islands.md, decision 6).
//
// Everything here is pure and engine-agnostic: the level grammar (MasonDef),
// the worlds (masonWorld), the timeline, and the pass rule as observer
// predicates over displacements (masonQuestions, masonPasses), which are the
// same in every island's own frame. mason-judge.ts runs them on an engine.
import type { BodyDesc, FieldEvent, Pred, SceneDesc, SpawnEvent, Vec3 } from '@tb/engine-api';
import { checkField, quakeEvents, TAG_BALL } from '@tb/engine-api';
import { type CompiledLevel, type LevelDef, MASON_ITERATIONS, physicsOf, unitOf } from './level.ts';
import { MATERIALS, materialId, type MaterialName, ROLES } from './materials.ts';
import { obbOfBody, obbOverlap } from './placement.ts';
import { TOUCH } from './build.ts';
import { type QuakeDialValues, quakeAzimuth } from './quake.ts';

/** Worlds a build is judged in (C10; the roadmap's Daily Seventeen judge). */
export const MASON_WORLDS = 64;
/** Defaults for MasonDef.jitter: placed pieces up to 0.02 h across the ground, probes up to 0.1 h, speeds up to 10 %. */
export const MASON_JITTER = { place: 0.02, probe: 0.1, speed: 0.1 } as const;
/** Fixed-point exponent of the pass rule's displacements (2^-12 m, 0.24 mm): far finer than any threshold, and in range 1,000 m out. */
export const MASON_SCALE = 12;
/** Steps the build stands on its own before the test, when the level does not say (1 s). */
export const MASON_HOLD = 60;

/** A body the test throws at the build: spawned when the test starts, in h (positions) and h/s (velocity). */
export type MasonProbe =
  | { kind: 'ball'; at: Vec3; radius: number; vel?: Vec3; material: MaterialName }
  | { kind: 'box'; at: Vec3; half: Vec3; vel?: Vec3; material: MaterialName };

/**
 * One clause of the pass rule: how many of `who` (the level's heritage: what the build protects; or the
 * test's probes) satisfy the test, compared with `atMost` or `atLeast` (both may be given).
 * - moved: its centre moved more than d h (heritage from its authored pose, a probe from where it was spawned);
 * - dropped: it is more than d h below that;
 * - advanced: it went more than d h along `dir` (x or z, plus or minus).
 * Thresholds must sit away from resting heights (islands.md: a cube that drops one layer rests within
 * micrometres of 1 h, where f64 and the observer's fixed point split it): validateLevel's mason check refuses
 * a 'dropped' d within 0.05 h of a whole number of h.
 */
export interface MasonCheck {
  who: 'heritage' | 'probe';
  test: 'moved' | 'dropped' | 'advanced';
  d: number;
  dir?: '+x' | '-x' | '+z' | '-z';
  atMost?: number;
  atLeast?: number;
}

/** The ground shaking (C7 field events, engine-api quakeEvents): `peak` side load in g, at `hz`, for `seconds`, along x or z. */
export interface MasonQuake { peak: number; hz: number; seconds: number; axis: 'x' | 'z' }

/**
 * A quake in Aftershock's dial units (quake.ts QuakeDialValues: % g, 0.1 Hz, 0.1 s, degrees) as a Mason test's quake,
 * so the two modes share one profile (aftershock-levels.ts RETROFIT_QUAKE) and feel the same: masonField then gives
 * the keys Aftershock's shot path (quakeInputs) gives for that quake at the test step. Throws on an axis other than 0
 * (x) or 90 (z), the two a Mason test runs along.
 */
export function masonQuakeOf(f: QuakeDialValues): MasonQuake {
  const axis = f.axis === 0 ? 'x' : f.axis === 90 ? 'z' : null;
  if (!axis) throw new Error(`masonQuakeOf: a Mason quake runs along x (0 degrees) or z (90), not ${f.axis} degrees`);
  return { peak: f.peak / 100, hz: f.hz / 10, seconds: f.sec / 10, axis };
}

export const MASON_TESTS = ['roll', 'drop', 'flood', 'reach', 'quake'] as const;
export type MasonTest = (typeof MASON_TESTS)[number];

/** A Mason level's test (LevelDef.mason). Part of the level hash, the stars included (retuning them is a new record). */
export interface MasonDef {
  /** What the HUD calls the test. */
  test: MasonTest;
  /** Steps between the end of the pre-settle and the test (default MASON_HOLD): the build must stand on its own first. */
  hold?: number;
  /** Steps the test runs before it is judged. */
  run: number;
  probes: MasonProbe[];
  quake?: MasonQuake;
  pass: MasonCheck[];
  /** Jitter of worlds 1 to K - 1 (MASON_JITTER): `place` and `probe` in h across the ground, `speed` a fraction of each probe's speed. */
  jitter?: { place?: number; probe?: number; speed?: number };
  /** Worlds (default MASON_WORLDS). */
  worlds?: number;
  /** Points for two and three stars (rules.ts masonScore), from the author solutions (keystone-lab mason-solutions.ts). */
  stars: [number, number];
}

export const masonOf = (d: LevelDef): MasonDef | undefined => d.mason;
export const masonWorlds = (m: MasonDef): number => m.worlds ?? MASON_WORLDS;

/** When things happen, in engine steps from init: the pre-settle, the test's start (probes spawn, the quake begins) and the judging step. */
export interface MasonTimeline { presettle: number; test: number; end: number }

export function masonTimeline(c: CompiledLevel): MasonTimeline {
  const m = c.def.mason!, presettle = physicsOf(c.def).presettle, test = presettle + (m.hold ?? MASON_HOLD);
  return { presettle, test, end: test + m.run };
}

/** A seeded uniform in [-1, 1): mulberry32, integer arithmetic only, so every machine draws the same numbers. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (((t ^ (t >>> 14)) >>> 0) / 2 ** 31) - 1;
  };
}
const SEED = 0x6d41736f; // 'mAso'

/** Whether body i of the compiled level came from a part the player placed. */
export const isPlaced = (c: CompiledLevel, i: number): boolean => {
  const p = c.def.parts[c.meta.part[i]!]!;
  return 'placed' in p && p.placed === true;
};

/**
 * The structure of world k: the compiled bodies, with every placed one (unpinned) shifted across the ground by up
 * to jitter.place h on x and z (seeded by k; world 0 is not jittered). A shift that would push a piece into a
 * body it did not already touch that deeply (its neighbours as already shifted) is not made: that piece stays put.
 */
export function masonBodies(c: CompiledLevel, k: number): BodyDesc[] {
  const bodies = c.scene.bodies.map((b) => ({ ...b }));
  if (k === 0) return bodies;
  const m = c.def.mason!, h = unitOf(c.def), a = (m.jitter?.place ?? MASON_JITTER.place) * h, r = rng(SEED ^ Math.imul(k, 0x9e3779b1));
  if (a === 0) return bodies;
  const tol = TOUCH * h;
  for (let i = 0; i < bodies.length; i++) {
    if (!isPlaced(c, i) || bodies[i]!.pinned) continue;
    const dx = a * r(), dz = a * r(), b = bodies[i]!, moved: BodyDesc = { ...b, pos: [b.pos[0] + dx, b.pos[1], b.pos[2] + dz] };
    const ob = obbOfBody(b), om = obbOfBody(moved);
    let ok = true;
    for (let j = 0; j < bodies.length && ok; j++) {
      if (j === i) continue;
      const oj = obbOfBody(bodies[j]!);
      if (obbOverlap(om, oj) > Math.max(tol, obbOverlap(ob, oj))) ok = false;
    }
    if (ok) bodies[i] = moved;
  }
  return bodies;
}

/** The test's probes for world k as spawn events (metres, local frame), due at the test's start; jittered for k > 0. */
export function masonProbes(c: CompiledLevel, k: number): SpawnEvent[] {
  const m = c.def.mason!, h = unitOf(c.def), step = masonTimeline(c).test;
  const r = rng(SEED ^ 0x5bd1e995 ^ Math.imul(k, 0x85ebca6b));
  const pj = (m.jitter?.probe ?? MASON_JITTER.probe) * h, sj = m.jitter?.speed ?? MASON_JITTER.speed;
  return m.probes.map((p) => {
    const mat = MATERIALS[materialId(p.material)]!;
    const jx = k ? pj * r() : 0, jz = k ? pj * r() : 0, js = k ? 1 + sj * r() : 1;
    const vel = (p.vel ?? [0, 0, 0]).map((v) => v * h * js) as Vec3;
    const pos: Vec3 = [p.at[0] * h + jx, p.at[1] * h, p.at[2] * h + jz];
    const shape = p.kind === 'ball' ? { kind: 'sphere' as const, radius: p.radius * h } : { kind: 'box' as const, half: p.half.map((x) => x * h) as Vec3 };
    const body: BodyDesc = { shape, pos, rot: [0, 0, 0, 1], linVel: vel, angVel: [0, 0, 0], density: mat.density, friction: mat.friction, restitution: mat.restitution, tag: TAG_BALL };
    return { step, kind: 'spawn', body };
  });
}

/** The quake as field events (world-wide: every world shakes alike), or none. */
export function masonField(c: CompiledLevel): FieldEvent[] {
  const q = c.def.mason!.quake;
  if (!q) return [];
  const evs = quakeEvents({ step: masonTimeline(c).test, seconds: q.seconds, dt: c.scene.dt, peak: q.peak, hz: q.hz, azimuth: quakeAzimuth(q.axis === 'x' ? 0 : 90) }, c.scene.gravity);
  for (const e of evs) checkField(e);
  return evs;
}

/** World k as a scene of its own (origin frame): its jittered structure and its probes as inputs. Field events are world-wide (masonField). */
export function masonWorld(c: CompiledLevel, k: number): SceneDesc {
  return { ...c.scene, id: `${c.scene.id}#${k}`, bodies: masonBodies(c, k), inputs: masonProbes(c, k) };
}

/** Tag word 1 of a world's bodies: what the pass rule asks about (0 anything else). */
export const MASON_CLASS = { other: 0, heritage: 1, probe: 2 } as const;

/** Class of world-local body `local` of compiled level c (bodies past the structure are the probes, in order). */
export function masonClass(c: CompiledLevel, local: number): number {
  if (local >= c.meta.n) return MASON_CLASS.probe;
  return c.meta.role[local] === ROLES.indexOf('heritage') ? MASON_CLASS.heritage : MASON_CLASS.other;
}

/**
 * The pass rule's clauses as observer predicates, one per clause, in order: bodies of the clause's class (tag
 * word 1) whose displacement meets its test. Heritage displacements are from ref slot 0 (the world as it was
 * built, before the pre-settle), probes' from ref slot 1 (one step after they spawned). Translation-invariant,
 * so the same predicates count every island in its own frame.
 */
export function masonQuestions(c: CompiledLevel): Pred[] {
  const m = c.def.mason!, h = unitOf(c.def), s = MASON_SCALE;
  return m.pass.map((ck) => {
    const slot = ck.who === 'heritage' ? 0 : 1, k = Math.round(ck.d * h * 2 ** s), src = { disp: slot };
    const cls: Pred = { cmp: { tag: 1 }, op: '==', k: ck.who === 'heritage' ? MASON_CLASS.heritage : MASON_CLASS.probe };
    let test: Pred;
    if (ck.test === 'moved') test = { cmp: { norm2: src, s }, op: '>', k: k * k };
    else if (ck.test === 'dropped') test = { cmp: { comp: src, axis: 1, s }, op: '<', k: -k };
    else {
      const dir = ck.dir ?? '+x', axis = dir.endsWith('x') ? 0 : 2;
      test = dir.startsWith('+') ? { cmp: { comp: src, axis, s }, op: '>', k } : { cmp: { comp: src, axis, s }, op: '<', k: -k };
    }
    return { and: [cls, test] };
  });
}

/** Whether a world passes, from its count per clause (masonQuestions' order). */
export function masonPasses(m: MasonDef, counts: readonly number[]): boolean {
  return m.pass.every((ck, i) => {
    const n = counts[i]!;
    return (ck.atMost === undefined || n <= ck.atMost) && (ck.atLeast === undefined || n >= ck.atLeast);
  });
}

/** Why a Mason level is malformed, one message per problem (validateLevel reports them as 'mason'). */
export function masonIssues(def: LevelDef): string[] {
  const m = def.mason;
  if (!m) return [];
  const out: string[] = [];
  if (!(MASON_TESTS as readonly string[]).includes(m.test)) out.push(`mason.test must be one of ${MASON_TESTS.join(', ')}: ${m.test}`);
  if (def.physics?.iterations !== undefined && def.physics.iterations !== MASON_ITERATIONS) out.push(`a Mason level plays at ${MASON_ITERATIONS} iterations (probe X4); its physics block says ${def.physics.iterations}`);
  if (!def.build || def.build.budget === undefined || !(def.build.budget > 0)) out.push('a Mason level needs a build block with a budget above 0');
  if (!(Number.isInteger(m.run) && m.run > 0 && m.run <= 3600)) out.push(`mason.run must be a whole number of steps from 1 to 3600: ${m.run}`);
  if (m.hold !== undefined && !(Number.isInteger(m.hold) && m.hold >= 0 && m.hold <= 600)) out.push(`mason.hold must be a whole number of steps from 0 to 600: ${m.hold}`);
  const K = masonWorlds(m);
  if (!(Number.isInteger(K) && K >= 1 && K <= 256)) out.push(`mason.worlds must be a whole number from 1 to 256: ${K}`);
  if (!m.probes.length && !m.quake) out.push('a Mason test needs a probe or a quake');
  if (m.probes.length > 32) out.push(`at most 32 probes: ${m.probes.length}`);
  if (!m.pass.length) out.push('a Mason test needs a pass rule');
  if (m.pass.length > 8) out.push(`at most 8 pass clauses: ${m.pass.length}`);
  const roles = new Set<string>();
  for (const p of def.parts) if ('role' in p && p.role) roles.add(p.role);
  m.pass.forEach((ck, i) => {
    if (!(ck.d > 0)) out.push(`mason.pass.${i}.d must be above 0 h: ${ck.d}`);
    if (ck.atMost === undefined && ck.atLeast === undefined) out.push(`mason.pass.${i} needs atMost or atLeast`);
    if (ck.who === 'heritage' && !roles.has('heritage')) out.push(`mason.pass.${i} asks about heritage and the level has none`);
    if (ck.who === 'probe' && !m.probes.length) out.push(`mason.pass.${i} asks about probes and the test has none`);
    if (ck.test === 'advanced' && !ck.dir) out.push(`mason.pass.${i}: an advanced test needs a dir`);
    if (ck.test === 'dropped' && Math.abs(ck.d - Math.round(ck.d)) < 0.05) out.push(`mason.pass.${i}.d = ${ck.d} h sits on a resting height (a whole number of layers): move it off by at least 0.05 h`);
  });
  const [t2, t3] = m.stars;
  if (!(Number.isFinite(t2) && Number.isFinite(t3) && t2 > 0 && t2 <= t3 && t3 <= 1000)) out.push(`mason.stars must be 0 < t2 <= t3 <= 1000: ${JSON.stringify(m.stars)}`);
  if (m.quake) {
    const q = m.quake;
    if (!(q.peak > 0 && q.peak <= 2 && q.hz > 0 && q.hz <= 10 && q.seconds > 0 && q.seconds <= 30 && (q.axis === 'x' || q.axis === 'z'))) out.push(`mason.quake out of range (peak 0 to 2 g, hz 0 to 10, seconds 0 to 30, axis x or z): ${JSON.stringify(q)}`);
  }
  return out;
}

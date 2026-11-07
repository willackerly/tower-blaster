// Aftershock's verb (roadmap M7, docs/game/aftershock.md): the player designs a quake, and the ground
// shakes. A quake shot (shots.ts QuakeShot) is four integers; here it becomes engine input (C7 field
// events, engine-api field.ts), the energy it is charged, and the level's limits on it.
//
// Probe X6 found that friction stacks do not resonate: they rock as Housner blocks, the overturning load
// rising with frequency from the static g/n. Aftershock's design search (keystone-lab quake-search.ts) found
// what does separate towers: slenderness at low frequency, the axis against a tower's thin side, and duration,
// since a short quake at about 1 Hz fells short towers while tall ones ride it out (the rocking block's size
// effect). The quake's parameters are those four levers and nothing else.
import { type FieldEvent, onFieldGrid, quakeEvents, type QuakeSpec } from '@tb/engine-api';
import { GRAVITY } from './materials.ts';
import type { CompiledLevel, LevelDef } from './level.ts';
import { QUAKE_RANGE, type QuakeShot } from './shots.ts';

/**
 * What a level lets the player dial (LevelDef.quake). Units are QuakeShot's: peak in % g, hz in 0.1 Hz, sec in
 * 0.1 s. Absent fields take QUAKE_DEFAULTS.
 */
export interface QuakeRules {
  /** The strongest peak side load the dial goes to, % g. */
  peakMax?: number;
  /** The frequency range, 0.1 Hz: [lowest, highest]. */
  hz?: [number, number];
  /** The duration range, 0.1 s: [shortest, longest]. */
  sec?: [number, number];
  /** The energy a quake may spend (quakeEnergy), J; absent: no budget. */
  budget?: number;
  /** The axes the dial snaps to, degrees (the game's step; any axis is legal in a line). */
  axisStep?: number;
  /**
   * The level's own quake (an Aftershock retrofit, M7b: the quake is coming and the player braces for it): the dial
   * is locked to it, and no other quake goes in. The ranges above then hold only it.
   */
  fixed?: QuakeDialValues;
}

/** A quake's four dial values, QuakeShot's units (peak % g, hz 0.1 Hz, sec 0.1 s, axis degrees). */
export type QuakeDialValues = Pick<QuakeShot, 'peak' | 'hz' | 'sec' | 'axis'>;

/**
 * The default dial: up to 0.8 g, 0.3 to 3 Hz, 0.5 to 12 s, axis in 15 degree steps. 0.8 g is past plaster's
 * friction (0.6): beyond it a quake slides blocks more than it rocks them, so the top of the dial is brute force.
 */
export const QUAKE_DEFAULTS = { peakMax: 80, hz: [3, 30], sec: [5, 120], axisStep: 15 } as const satisfies QuakeRules;

export interface ResolvedQuakeRules { peakMax: number; hz: [number, number]; sec: [number, number]; budget?: number; axisStep: number; fixed?: QuakeDialValues }

export function quakeRulesOf(d: Pick<LevelDef, 'quake'>): ResolvedQuakeRules {
  const q = d.quake ?? {};
  const f = q.fixed;
  if (f) return { peakMax: f.peak, hz: [f.hz, f.hz], sec: [f.sec, f.sec], axisStep: QUAKE_DEFAULTS.axisStep, fixed: { peak: f.peak, hz: f.hz, sec: f.sec, axis: f.axis }, ...(q.budget !== undefined ? { budget: q.budget } : {}) };
  return {
    peakMax: q.peakMax ?? QUAKE_DEFAULTS.peakMax, hz: q.hz ?? [...QUAKE_DEFAULTS.hz], sec: q.sec ?? [...QUAKE_DEFAULTS.sec],
    axisStep: q.axisStep ?? QUAKE_DEFAULTS.axisStep, ...(q.budget !== undefined ? { budget: q.budget } : {}),
  };
}

/** Throws unless a level's quake rules are in range (QUAKE_RANGE), naming the field. */
export function checkQuakeRules(q: QuakeRules, where = 'quake'): void {
  const intIn = (v: number, k: string, lo: number, hi: number) => { if (!(Number.isInteger(v) && v >= lo && v <= hi)) throw new Error(`${where}.${k} must be a whole number from ${lo} to ${hi}: ${v}`); };
  if (q.peakMax !== undefined) intIn(q.peakMax, 'peakMax', QUAKE_RANGE.peak[0], QUAKE_RANGE.peak[1]);
  for (const k of ['hz', 'sec'] as const) {
    const r = q[k];
    if (r === undefined) continue;
    if (!Array.isArray(r) || r.length !== 2) throw new Error(`${where}.${k} must be [lowest, highest]`);
    intIn(r[0], `${k}.0`, QUAKE_RANGE[k][0], QUAKE_RANGE[k][1]); intIn(r[1], `${k}.1`, QUAKE_RANGE[k][0], QUAKE_RANGE[k][1]);
    if (r[0] > r[1]) throw new Error(`${where}.${k}: ${r[0]} is above ${r[1]}`);
  }
  if (q.budget !== undefined && !(Number.isFinite(q.budget) && q.budget > 0)) throw new Error(`${where}.budget must be a positive number of joules: ${q.budget}`);
  if (q.axisStep !== undefined) intIn(q.axisStep, 'axisStep', 1, 90);
  if (q.fixed !== undefined) {
    const f = q.fixed as unknown as Record<string, unknown>;
    if (typeof f !== 'object' || f === null) throw new Error(`${where}.fixed must be {peak, hz, sec, axis}`);
    const known = new Set(['peak', 'hz', 'sec', 'axis']);
    for (const k of Object.keys(f)) if (!known.has(k)) throw new Error(`${where}.fixed.${k} is not a quake field (peak, hz, sec, axis)`);
    for (const k of ['peak', 'hz', 'sec', 'axis'] as const) intIn(f[k] as number, `fixed.${k}`, QUAKE_RANGE[k][0], QUAKE_RANGE[k][1]);
    // The ranges would only contradict it: a fixed quake is the whole dial.
    for (const k of ['peakMax', 'hz', 'sec', 'axisStep'] as const) if (q[k] !== undefined) throw new Error(`${where}: a fixed quake takes no ${k} (the dial is locked to it)`);
  }
}

/** The engine steps a quake shakes for (its last field key, restoring gravity, is due then). */
export const quakeSteps = (shot: Pick<QuakeShot, 'sec'>, dt: number): number => Math.round(shot.sec / 10 / dt);

/** The engine-api quake a shot fired at `step` is. */
export function quakeSpecOf(shot: QuakeShot, step: number, dt: number): QuakeSpec {
  return { step, seconds: shot.sec / 10, dt, peak: shot.peak / 100, hz: shot.hz / 10, azimuth: (shot.axis * Math.PI) / 180 };
}

/**
 * The field events of a quake fired at engine step `step`: one quantised gravity key per step that changes it
 * (engine-api quakeEvents, exact arithmetic), the last restoring the level's gravity. The level's gravity is on
 * the field grid (compileLevel quantises it when the rack holds a quake), so the restore is exact.
 */
export function quakeInputs(c: CompiledLevel, shot: QuakeShot, step: number): FieldEvent[] {
  const g = c.scene.gravity;
  if (!g.every(onFieldGrid)) throw new Error(`quakeInputs: ${c.def.id}'s gravity is not on the field grid (a level whose rack holds a quake compiles it there)`);
  return quakeEvents(quakeSpecOf(shot, step, c.scene.dt), g);
}

/** The structure's mass that can move (pinned bodies excluded), kg. */
export function movingMass(c: CompiledLevel): number {
  let m = 0;
  c.scene.bodies.forEach((b, i) => { if (b.pinned !== true) m += c.meta.mass[i]!; });
  return m;
}

/**
 * The energy a quake is charged, J: half the moving structure's mass times the ground's peak speed squared, per
 * effective cycle. The ground's peak speed is V = A g / (2 pi f) (the side load A g at frequency f), and the
 * envelope's quarter ramps leave 2/3 of the duration T at full strength in the mean square, so
 * E = 1/2 M V^2 f (2T/3) = M (A g)^2 T / (12 pi^2 f). Low, strong, long quakes cost the most: the brute force of
 * the dial is the expensive end of it. Leverage divides the structure's drop by this, as it does a shot's energy.
 */
export function quakeEnergy(c: CompiledLevel, shot: Pick<QuakeShot, 'peak' | 'hz' | 'sec'>): number {
  const a = (shot.peak / 100) * GRAVITY, f = shot.hz / 10, T = shot.sec / 10;
  return (movingMass(c) * a * a * T) / (12 * Math.PI * Math.PI * f);
}

/** Why a quake cannot go in on level `c`, or null if it can: inside the level's dial and, with a budget, within it. */
export function quakeRefusal(c: CompiledLevel, shot: QuakeShot): string | null {
  const r = quakeRulesOf(c.def), f = r.fixed;
  if (f && (shot.peak !== f.peak || shot.hz !== f.hz || shot.sec !== f.sec || shot.axis !== f.axis)) return `this level's quake is fixed: ${f.peak}% g, ${f.hz / 10} Hz, ${f.sec / 10} s at ${f.axis} degrees`;
  if (shot.peak > r.peakMax) return `peak ${shot.peak}% g is over the level's ${r.peakMax}%`;
  if (shot.hz < r.hz[0] || shot.hz > r.hz[1]) return `${shot.hz / 10} Hz is outside the level's ${r.hz[0] / 10} to ${r.hz[1] / 10} Hz`;
  if (shot.sec < r.sec[0] || shot.sec > r.sec[1]) return `${shot.sec / 10} s is outside the level's ${r.sec[0] / 10} to ${r.sec[1] / 10} s`;
  if (r.budget !== undefined) {
    const e = quakeEnergy(c, shot);
    // 1e-9 relative: the budget is set from a quake's own energy, and the same quake must fit it.
    if (e > r.budget * (1 + 1e-9)) return `the quake needs ${Math.round(e)} J, over the level's budget of ${Math.round(r.budget)} J`;
  }
  return null;
}

/**
 * The brute-force quake: the dial's strongest peak at its lowest frequency, for its longest duration, along +x.
 * Ignores the budget (it is what the budget is there to stop). A level with a fixed quake has only that one. Aftershock's gate (quake-search.ts) passes a level
 * only if this quake fails it.
 */
export function naiveQuake(c: CompiledLevel): QuakeShot {
  const r = quakeRulesOf(c.def);
  if (r.fixed) return { ammo: 'quake', ...r.fixed };
  return { ammo: 'quake', peak: r.peakMax, hz: r.hz[0], sec: r.sec[1], axis: 0 };
}

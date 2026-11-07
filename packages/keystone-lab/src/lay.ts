// Wavefront's Lay bot (M6, docs/game/wavefront.md): a Lay level's parts par is
// the cheapest build a bot finds by perturbing authored solutions, the way a
// player's hand would draw them a little differently. Every candidate is built
// through BuildSession (rube.ts build: the brush's own clash and budget rules)
// and played with the level's plunger on Rapier, then held to the nudge gate:
// a clear that holds only on the level as authored, and not on nudged builds,
// is luck and does not set par.
import { RapierEngine } from '@tb/adapter-rapier';
import type { PhysicsEngine } from '@tb/engine-api';
import { compileLevel, type LevelDef, nudgedLevel, type P2, rubePlay } from '@tb/keystone';
import { build, type BuildStep } from './rube.ts';

/** An authored solution: the strokes a designer drew (control points, h), each smoothed by the brush as a player's would be. */
export interface LaySolution {
  label: string;
  strokes: P2[][];
  /** Per stroke, the control points perturbed() keeps (default: the first and the last, which a hand lines up by eye on the ghost). */
  held?: number[][];
}

/** A seeded stream in [0, 1) (mulberry32): the same perturbations on every machine. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A solution as a different hand draws it: every control point moved up to `amp` h in x and z (uniform, from
 * `seed`) but the held ones: by default each stroke's first and last, where the push arrives or a branch forks off
 * and the bell it runs to, which a player lines up by eye on the ghost. The route between is what varies from hand
 * to hand. Rounded to 1e-3 h so a level file of the build reads short.
 */
export function perturbed(s: LaySolution, amp: number, seed: number): LaySolution {
  const r = seeded(seed), j = () => Math.round((2 * r() - 1) * amp * 1e3) / 1e3;
  return {
    ...s, label: `${s.label}~${seed}`,
    strokes: s.strokes.map((p, k) => p.map(([x, z], i): P2 => ((s.held?.[k] ?? [0, p.length - 1]).includes(i) ? [x, z] : [x + j(), z + j()]))),
  };
}

export const steps = (s: LaySolution): BuildStep[] => s.strokes.map((stroke) => ({ stroke }));

/** Plays a built Lay level with its plunger on `make()` (default Rapier); whether every bell rang. */
export async function layClears(def: LevelDef, nudge = 0, make: () => PhysicsEngine = () => new RapierEngine()): Promise<boolean> {
  const e = make();
  try { return (await rubePlay(e, nudgedLevel(compileLevel(def), nudge), { maxSteps: 3600 })).cleared; } finally { e.dispose(); }
}

/** How many of nudges 0..n-1 of `def` (built) clear. */
export async function nudgeClears(def: LevelDef, n: number): Promise<number> {
  let ok = 0;
  for (let k = 0; k < n; k++) if (await layClears(def, k)) ok++;
  return ok;
}

export interface LayFound { label: string; spent: number }
export interface LayPar { par: number; best: LayFound; clears: LayFound[]; refused: number; failed: number; luck: number }

/**
 * The parts par: the cheapest build, over the authored solutions and `samples` perturbations of each (up to `amp`
 * h), that clears as built and on every one of `gate` nudges. Clears that fail a nudge count as luck.
 */
export async function layPar(def: LevelDef, solutions: readonly LaySolution[], opts: { samples: number; amp: number; gate: number }): Promise<LayPar> {
  const clears: LayFound[] = [];
  let refused = 0, failed = 0, luck = 0;
  for (const s of solutions) {
    for (let k = 0; k <= opts.samples; k++) {
      const cand = k === 0 ? s : perturbed(s, opts.amp, k);
      const b = build(def, steps(cand));
      if (!b) { refused++; continue; }
      if (!(await layClears(b.def))) { failed++; continue; }
      if ((await nudgeClears(b.def, opts.gate)) < opts.gate) { luck++; continue; }
      clears.push({ label: cand.label, spent: b.spent });
    }
  }
  if (!clears.length) throw new Error(`layPar ${def.id}: nothing clears`);
  const best = clears.reduce((a, c) => (c.spent < a.spent ? c : a));
  return { par: best.spent, best, clears, refused, failed, luck };
}

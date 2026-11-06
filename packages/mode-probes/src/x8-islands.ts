// X8: do islands behave like solo worlds? (modes-roadmap.md section 7 and
// claim 11; gates C10, many worlds in one solve, which M8's robustness judge,
// M9 Chorus and cheap casts build on.)
//
// The level: a 5 x 5 x 6 block of 0.5 m plaster cubes on the game's lattice
// (150 bodies, as S14 builds a building), struck at mid-height by the weapons'
// wrecking ball at 15 m/s. The first full run used the cannonball at 45 m/s,
// which moved nothing in 61 of 64 worlds: two near-constant distributions
// always pass a KS test, so the rule could not fail. A shot must now move the
// block in most worlds (a checked condition of the verdict); the wrecking
// ball moves 0.8 to 0.97 of it and throws debris up to 21 m (SwiftShader, 16
// worlds), so the islands sit ISLAND_GAP = 60 m apart and the verdict checks
// that nothing ends outside its own island's cell. Shot k is
// jittered from its own seed (speed +-10 %,
// aim +-0.4 m across and +-0.3 m up) and so is the block (every cube +-1 mm,
// +-0.2 deg of yaw). The same K shots run three ways:
//   islands   all K worlds in one scene, ISLAND_GAP m apart on a square grid
//             centred on the origin (C10: they share the solve, the
//             colouring and the broadphase, never a contact);
//   solo      each world alone at the origin (what a cast runs today);
//   solo-far  each world alone at its island's position (the same f32
//             coordinates as in the islands run, without the others).
// Outcome per world, read 4 s after the shot (2 s at CI size): down, the share of cubes more
// than one cell below where they stood, and moved, the share whose centre
// moved more than 0.1 m. The rule compares the islands' outcome distribution
// with the solo runs' (two-sample KS, p > 0.05); solo-far separates "sharing
// the solve" from "far from the origin in f32". The cost half of the rule
// (per body within 10 % of a solo 9.6k scene) is a timing, so it is read only
// off a Metal run: the full size adds a 9.6k-cube block (S14-like, 40 x 40 x 6)
// to time against, and the table reports both ms per body-step.
import type { BodyDesc, InputEvent, Snapshot, Vec3 } from '@tb/engine-api';
import { PROJECTILE_PRESETS } from '@tb/weapons';
import { ball, box, GAME_PARAMS, gameScene, ks2, rng, sym, yaw } from './scene.ts';
import type { CaseRun, Check, Meter, Probe, RunSpec, Size, Verdict } from './probe.ts';

export const CELL = 0.5;
export const PITCH = 1.02 * CELL;
export const ISLAND_GAP = 60;
export const SHOT_STEP = 30;
/** The shot every world takes (see the header). */
export const SHOT_NAME = 'wreckingball' as const;
const SHOT = PROJECTILE_PRESETS[SHOT_NAME];
/** The verdict needs the shot to move the block in at least this share of the islands, or the KS test has nothing to compare. */
export const MIN_MOVED_WORLDS = 0.75;

export interface Level { W: number; D: number; H: number }
export type Arm = 'islands' | 'solo' | 'solo-far' | 'block';
export interface X8Case { arm: Arm; level: Level; K: number; world: number; presettle: number; readAfter: number }

/** Island k's offset: a square grid of side ceil(sqrt K), ISLAND_GAP apart, centred on the origin. */
export function islandOffset(k: number, K: number): Vec3 {
  const side = Math.ceil(Math.sqrt(K)), c = (side - 1) / 2;
  return [((k % side) - c) * ISLAND_GAP, 0, (Math.floor(k / side) - c) * ISLAND_GAP];
}

/** World k: the block and its shot (spawned at SHOT_STEP), placed at `at`. */
export function world(level: Level, k: number, at: Vec3, presettle: number): { bodies: BodyDesc[]; shot: InputEvent } {
  const r = rng(8000 + k), j = (s: number) => sym(r) * s, bodies: BodyDesc[] = [];
  const x0 = -((level.W - 1) / 2) * PITCH, z0 = -((level.D - 1) / 2) * PITCH;
  for (let y = 0; y < level.H; y++) for (let i = 0; i < level.W; i++) for (let l = 0; l < level.D; l++) {
    bodies.push(box([at[0] + x0 + i * PITCH + j(1e-3), CELL / 2 + y * CELL, at[2] + z0 + l * PITCH + j(1e-3)], [CELL / 2, CELL / 2, CELL / 2], yaw(j((0.2 * Math.PI) / 180))));
  }
  // The shot 3 m in front of the west face, at mid-height, flying +x.
  const speed = SHOT.speed * (1 + 0.1 * sym(r)), dz = 0.4 * sym(r), dy = 0.3 * sym(r);
  const shot = ball([at[0] + x0 - CELL / 2 - 3 - SHOT.diameter / 2, (level.H * CELL) / 2 + dy, at[2] + dz], SHOT.diameter / 2, [speed, 0, 0], { density: SHOT.density, friction: SHOT.friction });
  return { bodies, shot: { kind: 'spawn', step: presettle + SHOT_STEP, body: shot } };
}

/** The bodies of every world in the case, and where each world's block starts in the body list. */
export function x8World(c: X8Case): { bodies: BodyDesc[]; inputs: InputEvent[]; firsts: number[]; perWorld: number } {
  const perWorld = c.level.W * c.level.D * c.level.H;
  if (c.arm === 'block') {
    const bodies = world({ W: 40, D: 40, H: 6 }, 0, [0, 0, 0], c.presettle).bodies;
    return { bodies, inputs: [], firsts: [0], perWorld: bodies.length };
  }
  const ks = c.arm === 'islands' ? Array.from({ length: c.K }, (_, k) => k) : [c.world];
  const bodies: BodyDesc[] = [], inputs: InputEvent[] = [], firsts: number[] = [];
  for (const k of ks) {
    const at: Vec3 = c.arm === 'solo' ? [0, 0, 0] : islandOffset(k, c.K), w = world(c.level, k, at, c.presettle);
    firsts.push(bodies.length);
    bodies.push(...w.bodies);
    inputs.push(w.shot);
  }
  return { bodies, inputs, firsts, perWorld };
}

export function x8Spec(c: X8Case): RunSpec {
  const w = x8World(c), spawned = w.inputs.length;
  const scene = gameScene(`X8-${c.arm}`, { arm: c.arm, W: c.level.W, D: c.level.D, H: c.level.H, K: c.K, world: c.world }, w.bodies, w.inputs);
  const steps = c.arm === 'block' ? c.presettle + 300 : c.presettle + SHOT_STEP + c.readAfter;
  return { scene, steps, params: GAME_PARAMS, opts: { capacity: w.bodies.length + spawned, pairsPerBody: 24, boxBroadphase: true } };
}

export interface WorldOutcome {
  world: number; down: number; moved: number;
  /** Bodies of this world (its block and its shot) that ended outside its island's cell (ISLAND_GAP / 2 from its offset): they could have reached another world. */
  escaped: number;
  /** How far out its farthest body ended (the larger of |x| and |z| from its offset), m. */
  reach: number;
  /** The sum of the block's end positions relative to its island's offset (m); over the body count, its centroid. */
  sig: Vec3;
}
export interface X8Result { outcomes: WorldOutcome[]; bodies: number; stepMs: number }

function x8Meter(c: X8Case, spec: RunSpec): Meter<X8Result> {
  const w = x8World(c), ks = c.arm === 'islands' ? Array.from({ length: c.K }, (_, k) => k) : [c.world];
  let start: ArrayLike<number> | null = null, outcomes: WorldOutcome[] = [], t0 = 0, s0 = 0, stepMs = NaN;
  const shotAt = c.presettle + SHOT_STEP;
  return {
    every: 30,
    sample(step, s: Snapshot) {
      // The block's pose just before the shot is the one to compare with (after the pre-settle).
      if (step >= shotAt - 30 && !start) { start = s.pos.slice(); t0 = performance.now(); s0 = step; }
      if (step < spec.steps) return;
      stepMs = (performance.now() - t0) / Math.max(1, step - s0);
      if (c.arm === 'block' || !start) return;
      const p0 = start;
      outcomes = ks.map((k, wi) => {
        let down = 0, moved = 0, escaped = 0, reach = 0;
        const at: Vec3 = c.arm === 'solo' ? [0, 0, 0] : islandOffset(k, c.K), sig: Vec3 = [0, 0, 0];
        const out = (i: number) => { const d = Math.max(Math.abs(s.pos[3 * i]! - at[0]), Math.abs(s.pos[3 * i + 2]! - at[2])); reach = Math.max(reach, d); return d > ISLAND_GAP / 2; };
        // The shots are spawned after every block, in world order.
        if (w.bodies.length + wi < s.count && out(w.bodies.length + wi)) escaped++;
        for (let i = w.firsts[wi]!; i < w.firsts[wi]! + w.perWorld; i++) {
          for (let a = 0; a < 3; a++) sig[a] = sig[a]! + s.pos[3 * i + a]! - at[a]!;
          if (p0[3 * i + 1]! - s.pos[3 * i + 1]! > CELL) down++;
          if (Math.hypot(s.pos[3 * i]! - p0[3 * i]!, s.pos[3 * i + 1]! - p0[3 * i + 1]!, s.pos[3 * i + 2]! - p0[3 * i + 2]!) > 0.1) moved++;
          if (out(i)) escaped++;
        }
        return { world: k, down: down / w.perWorld, moved: moved / w.perWorld, escaped, reach, sig };
      });
    },
    result: () => ({ outcomes, bodies: w.bodies.length, stepMs }),
  };
}

const LEVELS: Record<Size, { level: Level; K: number }> = { ci: { level: { W: 3, D: 3, H: 4 }, K: 3 }, full: { level: { W: 5, D: 5, H: 6 }, K: 64 } };

function x8Cases(size: Size): X8Case[] {
  const { level, K } = LEVELS[size], full = size === 'full', presettle = full ? 300 : 30, readAfter = full ? 240 : 90;
  const out: X8Case[] = [{ arm: 'islands', level, K, world: -1, presettle, readAfter }];
  for (const arm of ['solo', 'solo-far'] as const) for (let k = 0; k < K; k++) out.push({ arm, level, K, world: k, presettle, readAfter });
  if (full) out.push({ arm: 'block', level, K, world: -1, presettle, readAfter });
  return out;
}

function x8Verdict(runs: CaseRun<X8Case, X8Result>[], size: Size): Verdict {
  const table: string[] = [], checks: Check[] = [];
  const arm = (a: Arm) => runs.filter((r) => r.c.arm === a).flatMap((r) => r.result.outcomes).sort((p, q) => p.world - q.world);
  const isl = arm('islands'), solo = arm('solo'), far = arm('solo-far'), perWorld = LEVELS[size].level.W * LEVELS[size].level.D * LEVELS[size].level.H;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  table.push('| arm | worlds | down mean | moved mean | same outcome as its island (down and moved) | largest shift of the block centroid from the island run, m |', '|---|---|---|---|---|---|');
  for (const [name, xs] of [['islands', isl], ['solo', solo], ['solo-far', far]] as const) {
    const same = xs.filter((o) => { const i = isl.find((q) => q.world === o.world); return i && i.down === o.down && i.moved === o.moved; }).length;
    const dsig = Math.max(0, ...xs.map((o) => { const i = isl.find((q) => q.world === o.world); return i ? Math.hypot(o.sig[0] - i.sig[0], o.sig[1] - i.sig[1], o.sig[2] - i.sig[2]) / perWorld : NaN; }));
    table.push(`| ${name} | ${xs.length} | ${mean(xs.map((o) => o.down)).toFixed(3)} | ${mean(xs.map((o) => o.moved)).toFixed(3)} | ${same}/${xs.length} | ${dsig.toExponential(2)} |`);
  }
  let ok = true;
  for (const [name, other] of [['solo', solo], ['solo-far', far]] as const) for (const m of ['down', 'moved'] as const) {
    const t = ks2(isl.map((o) => o[m]), other.map((o) => o[m]));
    const pass = t.p > 0.05;
    if (name === 'solo') ok &&= pass;
    checks.push({ name: `${name === 'solo' ? '' : '(diagnostic) '}islands vs ${name}: the ${m} distributions agree (KS p > 0.05)`, pass, detail: `D ${t.D.toFixed(3)}, p ${t.p.toFixed(3)}, ${isl.length} vs ${other.length} worlds` });
  }
  // Power: two near-constant distributions always agree, so the shot must move most blocks for the KS test to mean anything.
  const movedShare = isl.filter((o) => o.moved > 0).length / Math.max(1, isl.length);
  const power = movedShare >= MIN_MOVED_WORLDS;
  checks.push({ name: `the shot moves the block in at least ${100 * MIN_MOVED_WORLDS}% of the islands (else the KS test cannot fail)`, pass: power, detail: `${isl.filter((o) => o.moved > 0).length}/${isl.length} moved; moved takes ${new Set(isl.map((o) => o.moved)).size} distinct values` });
  const escaped = [...isl, ...solo, ...far].reduce((a, o) => a + o.escaped, 0);
  checks.push({ name: 'no body leaves its island\'s cell (no world could reach another)', pass: escaped === 0, detail: `${escaped} bodies outside their cell` });
  ok &&= power && escaped === 0;
  const isRun = runs.find((r) => r.c.arm === 'islands'), block = runs.find((r) => r.c.arm === 'block');
  const soloMs = mean(runs.filter((r) => r.c.arm === 'solo').map((r) => r.result.stepMs / r.result.bodies));
  table.push('', '| timing (Metal only; SwiftShader times are not results) | bodies | ms per step | us per body-step |', '|---|---|---|---|');
  for (const r of [isRun, block].filter(Boolean) as CaseRun<X8Case, X8Result>[]) table.push(`| ${r.c.arm} | ${r.result.bodies} | ${r.result.stepMs.toFixed(2)} | ${((1000 * r.result.stepMs) / r.result.bodies).toFixed(3)} |`);
  table.push(`| solo (mean of ${solo.length}) | ${runs.find((r) => r.c.arm === 'solo')?.result.bodies ?? 0} | - | ${(1000 * soloMs).toFixed(3)} |`);
  if (isRun && block) {
    const ratio = (isRun.result.stepMs / isRun.result.bodies) / (block.result.stepMs / block.result.bodies);
    checks.push({ name: '(reported; decided on Metal only) islands cost per body within 10% of the 9.6k block', pass: ratio <= 1.1, detail: `ratio ${ratio.toFixed(3)}` });
  }
  checks.push({ name: 'every world was read', pass: isl.length === LEVELS[size].K && solo.length === LEVELS[size].K && far.length === LEVELS[size].K, detail: `${isl.length} / ${solo.length} / ${far.length}` });
  checks.push({ name: 'no engine limit hit', pass: runs.every((r) => r.limits.length === 0), detail: runs.flatMap((r) => r.limits)[0] ?? 'none' });
  return { pass: size === 'full' ? ok && runs.every((r) => r.limits.length === 0) : null, checks, table };
}

export const X8: Probe<X8Case, X8Result> = {
  id: 'X8',
  title: 'Islands behave like solo worlds',
  question: 'Do K copies of a small level, far apart in one solve, give the same outcome distribution as K solo runs of the same jittered shots?',
  rule: 'Outcome distributions match (two-sample KS, p > 0.05; here on down and moved); cost per body within 10% of a solo 9.6k scene (read off a Metal run only).',
  cases: x8Cases,
  label: (c) => (c.arm === 'islands' ? `islands x${c.K}` : c.arm === 'block' ? 'block 9.6k' : `${c.arm} world ${c.world}`),
  spec: x8Spec,
  meter: x8Meter,
  verdict: x8Verdict,
};

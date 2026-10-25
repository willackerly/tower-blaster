// Solvability bot. Generates candidate shots against every face of every
// block at every few courses, plays each on a real engine, and keeps the ones
// that clear the level. The chaos audit then nudges a solution over the probe
// grid: a par solution counts only if most of its neighbourhood also clears.
import { type BlockPart, type LevelDef, type Shot } from '@tb/keystone';
import { aimCells, RAPIER_SUBSTEPS } from './cases.ts';
import { engineSubsteps } from './engines.ts';
import { runProbe, type ProbeResult } from './probe.ts';
import type { Runner } from './runner.ts';

export interface Candidate { label: string; shot: Shot }

/**
 * Launch shots at every cell of the four side faces of each block, every
 * `every` courses, plus anvil drops over every top cell of blocks and slabs.
 * Launch shots are aimed for an engine with `substeps` substeps per step.
 */
export function candidates(level: LevelDef, opts: { every?: number; powers?: number[]; substeps?: number } = {}): Candidate[] {
  const every = opts.every ?? 2, powers = opts.powers ?? [60, 100], substeps = opts.substeps ?? RAPIER_SUBSTEPS;
  const out: Candidate[] = [];
  const launch = [...new Set(level.rack.filter((a): a is 'marble' | 'cannonball' => a === 'marble' || a === 'cannonball'))];
  level.parts.forEach((p, pi) => {
    if (level.rack.includes('drop')) {
      const [x0, z0, nx, nz] = p.kind === 'block' ? [p.at[0], p.at[2], p.size[0], p.size[2]] : [p.at[0] - p.half[0], p.at[2] - p.half[2], 2 * p.half[0], 2 * p.half[2]];
      for (let i = 0; i < Math.round(nx); i++) for (let j = 0; j < Math.round(nz); j++) {
        out.push({ label: `part${pi} drop cell ${i},${j}`, shot: { ammo: 'drop', x: Math.round(4 * (x0 + i + 0.5)), z: Math.round(4 * (z0 + j + 0.5)) } });
      }
    }
    if (p.kind !== 'block') return;
    const b = p as BlockPart;
    const [x0, y0, z0] = b.at, [nx, ny, nz] = b.size;
    // Face points (one per cell along the face) and the launcher azimuth (0.5 deg units) facing them.
    const faces: Array<[string, Array<[number, number]>, number]> = [
      ['-x', Array.from({ length: nz }, (_, j) => [x0, z0 + j + 0.5]), 360],
      ['+x', Array.from({ length: nz }, (_, j) => [x0 + nx, z0 + j + 0.5]), 0],
      ['-z', Array.from({ length: nx }, (_, i) => [x0 + i + 0.5, z0]), 540],
      ['+z', Array.from({ length: nx }, (_, i) => [x0 + i + 0.5, z0 + nz]), 180],
    ];
    const courses = [...new Set([...Array.from({ length: Math.ceil(ny / every) }, (_, k) => k * every), ny - 1])];
    for (const k of courses) for (const [fname, points] of faces) points.forEach(([fx, fz], cell) => {
      for (const ammo of launch) for (const power of powers) {
        out.push({ label: `part${pi} ${fname}[${cell}] course ${y0 + k} ${ammo} ${power}%`, shot: aimCells(level, ammo, az(fname), [fx, y0 + k + 0.5, fz], power, 8, substeps) });
      }
    });
    function az(f: string) { return faces.find((x) => x[0] === f)![2]; }
  });
  return out;
}

export interface Solution { label: string; shot: Shot; leverage: number; heritage: number; stars: number }

/** Solutions of up to `maxShots` shots (greedy: extend the best few partial attempts), best first. */
export async function solve(level: LevelDef, runner: Runner, opts: { maxShots?: number; beam?: number; every?: number } = {}): Promise<{ tried: number; solutions: Array<Solution & { shots: Shot[] }> }> {
  const cands = candidates(level, { every: opts.every ?? 2, substeps: engineSubsteps(runner.spec) });
  const maxShots = Math.min(opts.maxShots ?? level.par, level.rack.length), beam = opts.beam ?? 3;
  const solutions: Array<Solution & { shots: Shot[] }> = [];
  let frontier: Shot[][] = [[]], tried = 0;
  for (let depth = 1; depth <= maxShots && frontier.length; depth++) {
    const partial: Array<{ shots: Shot[]; crowns: number; heritage: number }> = [];
    const attempts: Array<{ cand: Candidate; shots: Shot[] }> = [];
    for (const prefix of frontier) for (const cand of cands) {
      const rack = [...level.rack];
      if ([...prefix, cand.shot].every((s) => { const i = rack.indexOf(s.ammo); if (i < 0) return false; rack.splice(i, 1); return true; })) attempts.push({ cand, shots: [...prefix, cand.shot] });
    }
    tried += attempts.length;
    // All of a depth's attempts at once, then judged in order: the result does not depend on the runner.
    const results = await Promise.all(attempts.map((a) => runner.play(level, a.shots)));
    for (const [k, { cand, shots }] of attempts.entries()) {
      const r = results[k]!;
      if (r.session.outcomes.length < shots.length) continue; // an earlier shot already ended the level
      const crowns = r.session.crownDown.reduce((a, x) => a + x, 0), heritage = r.session.heritageBroken.reduce((a, x) => a + x, 0);
      if (r.session.phase === 'cleared') solutions.push({ label: cand.label, shot: cand.shot, shots, leverage: r.session.score!.leverage, heritage, stars: r.session.score!.stars });
      else partial.push({ shots, crowns, heritage });
    }
    partial.sort((a, b) => a.heritage - b.heritage || b.crowns - a.crowns);
    frontier = partial.slice(0, beam).map((p) => p.shots);
  }
  solutions.sort((a, b) => a.shots.length - b.shots.length || a.heritage - b.heritage || b.leverage - a.leverage);
  return { tried, solutions };
}

/** One-shot solutions, best first (fewest heritage broken, then most leverage). */
export async function solveOneShot(level: LevelDef, runner: Runner, cands = candidates(level, { substeps: engineSubsteps(runner.spec) })): Promise<{ tried: number; solutions: Solution[]; best: { label: string; crowns: number } }> {
  const solutions: Solution[] = [];
  let best = { label: '', crowns: -1 };
  const usable = cands.filter((cand) => level.rack.includes(cand.shot.ammo));
  const results = await Promise.all(usable.map((cand) => runner.play(level, [cand.shot])));
  for (const [k, cand] of usable.entries()) {
    const r = results[k]!;
    const crowns = r.session.crownDown.reduce((a, x) => a + x, 0);
    if (crowns > best.crowns) best = { label: cand.label, crowns };
    if (r.session.phase !== 'cleared') continue;
    const o = r.session.outcomes[0]!;
    solutions.push({ label: cand.label, shot: cand.shot, leverage: o.leverage, heritage: o.heritageNew, stars: r.session.score!.stars });
  }
  solutions.sort((a, b) => a.heritage - b.heritage || b.leverage - a.leverage);
  return { tried: cands.length, solutions, best };
}

/** The probe grid around the last shot of a solution, succeeding when the level clears with no heritage broken. */
export function audit(level: LevelDef, shots: Shot[], runner: Runner): Promise<ProbeResult> {
  return runProbe({ id: level.id, title: `${level.name} par audit`, level, shots: () => shots, success: (r) => r.session.phase === 'cleared' && r.session.heritageBroken.every((x) => !x) }, runner);
}

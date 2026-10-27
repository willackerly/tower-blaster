// Mechanics probe and solvability checks. A "case" is a level, a nominal
// shot and a success predicate; the probe fires the shot over a grid of small
// nudges (yaw x power, or position x power) and reports how much of the grid
// still succeeds. A behaviour a puzzle can rely on must survive the nudges a
// player can't control: that is the difference between a puzzle and a lottery.
import { compileLevel, type CompiledLevel, type LevelDef, type Shot } from '@tb/keystone';
import { engineSubsteps } from './engines.ts';
import type { PlayResult, Runner } from './runner.ts';

export interface ProbeCase {
  id: string;
  title: string;
  level: LevelDef;
  /** Shots fired in order, aimed for an engine with this many substeps; only the last is nudged. */
  shots(substeps: number): Shot[];
  success(r: PlayResult, c: CompiledLevel): boolean;
  /** A number to record for each successful attempt (the bot's audit: the session's leverage). */
  value?(r: PlayResult): number;
}

/** Nudge offsets: yaw +-0.6 deg (7 values) by power +-3 % (5 values). */
export const YAW_NUDGES = [-6, -4, -2, 0, 2, 4, 6];
export const POWER_NUDGES = [-3, -2, 0, 2, 3];

/**
 * A nudged copy of a shot. Launch shots move in yaw (0.1 deg) and power;
 * cues move sideways and in power; drops move in x and z.
 */
export function nudge(s: Shot, a: number, power: number): Shot {
  const clampP = (p: number) => Math.max(0, Math.min(100, p + power));
  // Cues and drops snap to a face or cell centre in the UI, so position error
  // is at most one quarter cell; the outer grid columns use it.
  const q = Math.abs(a) >= 4 ? Math.sign(a) : 0, qp = Math.abs(power) >= 3 ? Math.sign(power) : 0;
  if (s.ammo === 'drop') return { ...s, x: s.x + q, z: s.z + qp };
  if (s.ammo === 'cue') return s.dir < 2 ? { ...s, z: s.z + q, power: clampP(s.power) } : { ...s, x: s.x + q, power: clampP(s.power) };
  return { ...s, yaw: s.yaw + a, power: clampP(s.power) };
}

export interface ProbeResult {
  id: string; title: string; nominal: boolean; successRate: number; grid: boolean[][]; ms: number;
  /** pc.value of each successful attempt, grid order; empty without pc.value. */
  values: number[];
}

export async function runProbe(pc: ProbeCase, runner: Runner): Promise<ProbeResult> {
  const c = compileLevel(pc.level);
  const t0 = performance.now();
  const shots = pc.shots(engineSubsteps(runner.spec)), lastIdx = shots.length - 1;
  const attempt = async (s: Shot) => {
    const r = await runner.play(pc.level, [...shots.slice(0, lastIdx), s]);
    const ok = pc.success(r, c);
    return { ok, value: ok && pc.value ? pc.value(r) : null };
  };
  const cells = await Promise.all(YAW_NUDGES.map((a) => Promise.all(POWER_NUDGES.map((p) => attempt(nudge(shots[lastIdx]!, a, p))))));
  const grid = cells.map((row) => row.map((x) => x.ok)), flat = grid.flat();
  const values = cells.flat().flatMap((x) => (x.value === null ? [] : [x.value]));
  return { id: pc.id, title: pc.title, nominal: grid[3]![2]!, successRate: flat.filter(Boolean).length / flat.length, grid, ms: performance.now() - t0, values };
}

/** The q-quantile of xs (linear between order statistics); NaN when empty. */
export function quantile(xs: readonly number[], q: number): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b), i = q * (s.length - 1), lo = Math.floor(i);
  return lo + 1 < s.length ? s[lo]! + (i - lo) * (s[lo + 1]! - s[lo]!) : s[lo]!;
}

export function gridText(g: boolean[][]): string {
  return g.map((row) => row.map((x) => (x ? '#' : '.')).join('')).join('\n');
}

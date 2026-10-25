// Mechanics probe and solvability checks. A "case" is a level, a nominal
// shot and a success predicate; the probe fires the shot over a grid of small
// nudges (yaw x power, or position x power) and reports how much of the grid
// still succeeds. A behaviour a puzzle can rely on must survive the nudges a
// player can't control: that is the difference between a puzzle and a lottery.
import type { PhysicsEngine } from '@tb/engine-api';
import { compileLevel, type CompiledLevel, type LevelDef, runSession, type SessionResult, type Shot } from '@tb/keystone';

/** One session on a fresh engine, freed afterwards (WASM engines leak otherwise). */
export async function play(engine: () => PhysicsEngine, c: CompiledLevel, shots: Shot[]): Promise<SessionResult> {
  const e = engine();
  try { return await runSession(e, c, shots); } finally { e.dispose(); }
}

export interface ProbeCase {
  id: string;
  title: string;
  level: LevelDef;
  /** Shots fired in order; only the last is nudged. */
  shots: Shot[];
  success(r: SessionResult, c: CompiledLevel): boolean;
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

export interface ProbeResult { id: string; title: string; nominal: boolean; successRate: number; grid: boolean[][]; ms: number }

export async function runProbe(pc: ProbeCase, engine: () => PhysicsEngine): Promise<ProbeResult> {
  const c = compileLevel(pc.level);
  const t0 = performance.now();
  const lastIdx = pc.shots.length - 1;
  const attempt = async (s: Shot) => pc.success(await play(engine, c, [...pc.shots.slice(0, lastIdx), s]), c);
  const grid: boolean[][] = [];
  for (const a of YAW_NUDGES) {
    const row: boolean[] = [];
    for (const p of POWER_NUDGES) row.push(await attempt(nudge(pc.shots[lastIdx]!, a, p)));
    grid.push(row);
  }
  const flat = grid.flat();
  return { id: pc.id, title: pc.title, nominal: grid[3]![2]!, successRate: flat.filter(Boolean).length / flat.length, grid, ms: performance.now() - t0 };
}

export function gridText(g: boolean[][]): string {
  return g.map((row) => row.map((x) => (x ? '#' : '.')).join('')).join('\n');
}

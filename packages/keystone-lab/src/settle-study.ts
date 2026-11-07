// How long shots take to settle, and what an earlier settle would cost (agent playtest PT6).
// Replays recorded lines (a playtest report's shots, or any (level, shots) list) on a lab engine
// and records, per step of each shot, the collapse D and the reductions the settle rules read, so
// a candidate rule can be scored on the very states the current one saw, then checked with a
// full replay under it (the shots after an earlier settle fire on a world still moving).
import { type LevelDef, type SettleRule, runSession, type Shot } from '@tb/keystone';
import { type EngineSpec, makeEngine } from './engines.ts';

export interface StepRow {
  step: number;
  /** Collapse fraction D (Session.liveCollapse) after this step. */
  d: number;
  maxSpeed: number;
  nMoving: number;
  displaced: number;
  nAwake: number;
}

export interface ShotTrace {
  fired: number;
  /** The step it settled at (or was cut / the line ended). */
  settled: number;
  /** D when it settled. */
  d: number;
  rows: StepRow[];
}

export interface LineTrace {
  level: string;
  rule: SettleRule;
  shots: ShotTrace[];
  /** The collapse D at the end of the line (the last settle). */
  finalD: number;
  steps: number;
  wallMs: number;
}

/** Plays `shots` on `level` under `rule` (the level's own when absent) and traces every running step. */
export async function traceLine(spec: EngineSpec, level: LevelDef, shots: Shot[], rule?: SettleRule, now: () => number = () => 0): Promise<LineTrace> {
  const def: LevelDef = rule ? { ...level, settle: rule } : level;
  const { compileLevel } = await import('@tb/keystone');
  const c = compileLevel(def), e = makeEngine(spec), t0 = now();
  const out: ShotTrace[] = [];
  let cur: ShotTrace | null = null;
  try {
    const r = await runSession(e, c, shots, {
      bank: false,
      perStep: (d) => {
        const s = d.session, o = d.observed;
        if (s.phase === 'running' && o) {
          const k = s.inputs.length - 1;
          if (!out[k]) { cur = { fired: s.inputs[k]!.step, settled: -1, d: 0, rows: [] }; out[k] = cur; }
          cur!.rows.push({ step: o.step, d: s.liveCollapse, maxSpeed: o.red.maxSpeed, nMoving: o.red.nMoving, displaced: o.red.displaced, nAwake: o.red.nAwake });
        }
        return [];
      },
    });
    r.session.outcomes.forEach((oc, k) => {
      if (!out[k]) out[k] = { fired: oc.spawnStep, settled: oc.settleStep, d: 0, rows: [] };
      out[k]!.settled = oc.settleStep;
      out[k]!.d = r.session.collapse(oc.pe_mJ);
    });
    const finalD = out.at(-1)?.d ?? 0;
    return { level: level.id, rule: rule ?? (def.settle ?? 'v3'), shots: out, finalD, steps: r.steps, wallMs: now() - t0 };
  } finally {
    e.dispose();
  }
}

/**
 * Where settle v4's steady run (rules.ts STEADY_D, STEADY_STEPS) would end one shot's trace: the first
 * step at least `minSteps` after the launch where D has stayed within `eps` of where a run began for
 * `window` steps, or null when the trace never gets there (the rule that ran ended it first).
 */
export function steadyAt(t: ShotTrace, window: number, eps: number, minSteps = 20): number | null {
  let since = -1, d0 = 0;
  for (const row of t.rows) {
    if (since < 0 || Math.abs(row.d - d0) >= eps) { since = row.step; d0 = row.d; }
    if (row.step - t.fired >= minSteps && row.step - since + 1 >= window) return row.step;
  }
  return null;
}

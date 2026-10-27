// The brief's quality protocol Q1-Q5 (perf-competition brief §Q) for engine
// variants, and whether a variant is equivalent to its base: pnpm
// bench:quality runs it on the GPU in a real browser (quality-cli.ts), so a
// variant's M5 gate is the same physics check as on the dev VM, not bit
// identity, which Metal's relaxed math does not promise. Node side: it reads
// runs made by quality-run.ts.
import { emptySnapshot, freeFlight, type SceneDesc } from '@tb/engine-api';
import { drift, penetration } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { aboveHole, readColumn, rodRock, rodToppleTime, tippingAngle } from '@tb/testkit';
import type { CaseRun } from './quality-run.ts';

export type CaseId = 'Q1' | 'Q2' | 'Q3' | 'Q4' | 'Q5';
export interface QualityCase { id: CaseId; scenario: string; params: Record<string, number>; steps: number; every: number; what: string }

/** The brief's cases, with its step counts (Q3's 440 as round 1 ran it). */
export const QUALITY_CASES: readonly QualityCase[] = [
  { id: 'Q1', scenario: 'S13', params: { H: 20, deg: 4 }, steps: 330, every: 5, what: 'S13 H=20 at 4 deg: topples like the rigid column' },
  { id: 'Q2', scenario: 'S13', params: { H: 20, deg: 2 }, steps: 300, every: 5, what: 'S13 H=20 at 2 deg: rocks back past upright, no further than the rigid column' },
  { id: 'Q3', scenario: 'S13', params: { H: 30, deg: 3 }, steps: 440, every: 5, what: 'S13 H=30 at 3 deg: the topple error (reported)' },
  { id: 'Q4', scenario: 'S12', params: {}, steps: 30, every: 30, what: 'S12: the cubes above the hole fall freely, the rest stay' },
  { id: 'Q5', scenario: 'S1', params: { F: 4, H: 20 }, steps: 300, every: 300, what: 'S1 4x4x20 at rest: max penetration and drift (reported)' },
];
export const caseScene = (c: QualityCase): SceneDesc => buildScenario(c.scenario, c.params, 1);

export interface CaseMetrics {
  id: CaseId;
  /** Column cases: crossing times (s) and leans (deg) from readColumn, and against the rigid column; tipping, the column's tipping angle (deg). Past it, the topple; inside it, the rock. */
  tipping?: number;
  topple?: number | null; toppleErr?: number | null; bend?: number;
  upright?: number | null; uprightErr?: number | null; before?: number; farSide?: number; farRatio?: number; turned?: boolean;
  /** Q4: the worst above-hole cube's fall as a fraction of free fall, and the most any other cube moved (m). */
  fallRatio?: number; restMove?: number;
  /** Q5: max penetration (m) and max horizontal drift (m) over the run's end state. */
  penetration?: number; drift?: number;
  /** Non-finite position components at the end. */
  nonFinite: number;
}

export function evaluate(c: QualityCase, run: CaseRun): CaseMetrics {
  const scene = caseScene(c);
  const nonFinite = run.last.pos.filter((x) => !Number.isFinite(x)).length;
  if (c.scenario === 'S13') {
    const H = c.params.H!, col = readColumn(run.samples.map((s) => ({ t: s.step * scene.dt, pos: s.pos })), H);
    const deg = c.params.deg!, tipping = tippingAngle(H);
    if (deg >= tipping) {
      const rod = rodToppleTime(H, deg, 30);
      return { id: c.id, nonFinite, tipping, topple: col.topple, toppleErr: col.topple === null ? null : col.topple / rod - 1, bend: col.bend };
    }
    const rock = rodRock(H, deg);
    return {
      id: c.id, nonFinite, tipping, upright: col.upright, uprightErr: col.upright === null ? null : col.upright / rock.upright - 1, before: col.before,
      farSide: col.farSide, farRatio: col.farSide / rock.farSide, turned: col.turned,
    };
  }
  if (c.scenario === 'S12') {
    const above = aboveHole(scene);
    let fallRatio = Infinity, restMove = 0;
    scene.bodies.forEach((b, i) => {
      const p = run.last.pos;
      if (above.includes(i)) {
        const free = freeFlight(b.pos, [0, 0, 0], scene.gravity, scene.dt, 1, c.steps).pos[1];
        fallRatio = Math.min(fallRatio, (b.pos[1] - p[3 * i + 1]!) / (b.pos[1] - free));
      } else restMove = Math.max(restMove, Math.hypot(p[3 * i]! - b.pos[0], p[3 * i + 1]! - b.pos[1], p[3 * i + 2]! - b.pos[2]));
    });
    return { id: c.id, nonFinite, fallRatio, restMove };
  }
  const snap = (s: CaseRun['first']) => {
    const out = emptySnapshot(s.pos.length / 3);
    out.pos.set(s.pos); out.rot.set(s.rot); out.awake.fill(1);
    return out;
  };
  const s0 = snap(run.first), s1 = snap(run.last);
  return { id: c.id, nonFinite, penetration: penetration(scene.bodies, s1, scene.ground?.y ?? 0).max, drift: drift(s0, s1) };
}

/**
 * The pass conditions. At 20 iterations or more, the brief's (Q1: within 3%
 * of the rigid column, bend < 0.1 m; Q2: upright within 3%, far side / rigid
 * in (0.85, 1.02), turned, never past tipping before); at 10-19 the repo's
 * 10-iteration gates (engine.test.ts S13: 12%; 15%, far side above 0.58).
 * Q3 and Q5 have no bound in the brief, only a finite state; equivalent()
 * compares them with the base. null: a gate that does not apply at this I.
 */
export function gates(m: CaseMetrics, iterations: number): Record<string, boolean | null> {
  const brief = iterations >= 20, gated = iterations >= 10;
  const g: Record<string, boolean | null> = { finite: m.nonFinite === 0 };
  if (m.id === 'Q1') {
    g.topples = m.topple != null;
    g.toppleTime = gated && m.toppleErr != null ? Math.abs(m.toppleErr) < (brief ? 0.03 : 0.12) : null;
    g.bend = brief ? m.bend! < 0.1 : null;
  } else if (m.id === 'Q2') {
    g.crossesUpright = m.upright != null;
    g.uprightTime = gated && m.uprightErr != null ? Math.abs(m.uprightErr) < (brief ? 0.03 : 0.15) : null;
    g.farSide = gated ? m.farRatio! > (brief ? 0.85 : 0.58) && m.farRatio! < 1.02 : null;
    g.turned = m.turned!;
    g.beforeTipping = m.before! < m.tipping!;
  } else if (m.id === 'Q4') {
    g.freeFall = m.fallRatio! >= 0.99;
    g.restStays = m.restMove! < 0.03;
  }
  return g;
}

/**
 * A variant against its base, case by case. Q1-Q3: the crossing times within
 * 0.02 s, and Q2's far side within -0.07/+0.04 deg: the bounds the GPU-vs-f64
 * tests use, which follow the spread a 1e-6 m change of the start positions
 * makes (engine.test.ts S13 notes), i.e. rounding, not physics. Q4: the same
 * gates pass. Q5: no softer than the base, 10% plus 5e-5 m of penetration and
 * 1e-4 m of drift (1/20000 and 1/10000 of a cube's edge). Every gate the base
 * passes, the variant must pass.
 */
export function equivalent(base: CaseMetrics, arm: CaseMetrics, iterations: number): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  const near = (a: number | null | undefined, b: number | null | undefined, tol: number) => (a == null || b == null ? a == b : Math.abs(a - b) <= tol);
  if (base.id === 'Q1' || base.id === 'Q3') out.toppleWithin002s = near(arm.topple, base.topple, 0.02);
  if (base.id === 'Q2') {
    out.uprightWithin002s = near(arm.upright, base.upright, 0.02);
    const d = arm.farSide! - base.farSide!;
    out.farSideWithinSpread = d >= -0.07 && d <= 0.04;
    out.turnedSame = arm.turned === base.turned;
  }
  if (base.id === 'Q5') {
    out.noSofter = arm.penetration! <= 1.1 * base.penetration! + 5e-5;
    out.noMoreDrift = arm.drift! <= 1.1 * base.drift! + 1e-4;
  }
  const gb = gates(base, iterations), ga = gates(arm, iterations);
  out.passesWhatBasePasses = Object.keys(gb).every((k) => gb[k] !== true || ga[k] === true);
  return out;
}

export interface ArmResult { spec: string; backend: string; cases: Array<{ id: CaseId; metrics: CaseMetrics | null; error: string | null; gates: Record<string, boolean | null>; equivalent: Record<string, boolean> | null }> }

/** Whether an arm (other than the base) is equivalent on every case it ran. */
export const armOk = (a: ArmResult) => a.cases.every((c) => c.error === null && (c.equivalent === null || Object.values(c.equivalent).every(Boolean)));

const n = (x: number | null | undefined, d = 4) => (x == null ? '–' : Number.isFinite(x) ? x.toFixed(d) : String(x));
const pct = (x: number | null | undefined) => (x == null ? '–' : `${(100 * x).toFixed(2)}%`);
const failed = (r: Record<string, boolean | null> | null) => (r ? Object.entries(r).filter(([, v]) => v === false).map(([k]) => k) : []);

export function qualityMarkdown(arms: ArmResult[], iterations: number, header: string): string {
  const L = [header, '', `Cases: the brief's Q protocol at ${iterations} iterations. Gates: ${iterations >= 20 ? "the brief's (20 iterations)" : iterations >= 10 ? 'the 10-iteration gates of engine.test.ts' : 'none at this I (reported only)'}. Every arm after the first is compared with the first (quality.ts equivalent()).`, ''];
  L.push('| Arm | Case | Metrics | Gates failed | Not equivalent |', '|---|---|---|---|---|');
  for (const a of arms) {
    for (const c of a.cases) {
      const m = c.metrics;
      const text = !m ? `error: ${c.error?.split('\n')[0]}`
        : m.id === 'Q4' ? `fall ${n(m.fallRatio)} of free, rest moved ${n(m.restMove)} m`
          : m.id === 'Q5' ? `penetration ${m.penetration!.toExponential(2)} m, drift ${m.drift!.toExponential(2)} m`
            : m.id === 'Q2' ? `upright ${n(m.upright, 3)} s (${pct(m.uprightErr)}), far ${n(m.farSide, 3)} deg = ${n(m.farRatio, 3)} of rigid, turned ${m.turned}, before ${n(m.before, 3)} deg`
              : `topple ${n(m.topple, 3)} s (${pct(m.toppleErr)}), bend ${n(m.bend, 3)} m`;
      L.push(`| ${a.spec} | ${c.id} | ${text} | ${failed(c.gates).join(', ') || 'none'} | ${c.equivalent ? failed(c.equivalent).join(', ') || 'none' : '(base)'} |`);
    }
  }
  L.push('');
  for (const a of arms.slice(1)) L.push(`- **${a.spec}**: ${armOk(a) ? 'equivalent to the base on every case' : 'NOT equivalent to the base'}.`);
  const baseFails = arms[0]?.cases.filter((c) => failed(c.gates).length) ?? [];
  if (baseFails.length) L.push(`- The base itself fails ${baseFails.map((c) => `${c.id} (${failed(c.gates).join(', ')})`).join('; ')}: not the variants' doing.`);
  return L.join('\n');
}

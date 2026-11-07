// One play of a line for the star cast (docs/game/spectacle-mode.md, section 6,
// "Casting thresholds"): the session from the level's start with every shot of
// the line, sampled at each settle as if the player banked there, so every
// settle is a sample of each star metric. Engine-agnostic and clock-free, so
// the Node lab (reference, Rapier) and the GPU cast page play it the same way.
import { limitProblems, type PhysicsEngine } from '@tb/engine-api';
import { type DriverOptions, type PerStep, runSession, snapshotHash } from './driver.ts';
import type { CompiledLevel, StarMetric } from './level.ts';
import { metricValue, outcomeScore } from './outcome.ts';
import type { Session } from './session.ts';
import { type ChorusJudgement, chorusRound } from './chorus.ts';
import type { Shot } from './shots.ts';

/** What the level would score banked at one settle: each star metric's value, and whether the objective is met. */
export interface CastSample {
  /** Shots settled so far (1 after the first shot). */
  shots: number;
  /** Engine step of the settle. */
  step: number;
  met: boolean;
  collapse: number;
  crowns: number;
  skyline: number;
  /** The outcome tally's total banked here (outcomeTally, no cast stars needed). */
  score: number;
  /** Heritage bodies broken so far (three stars need none). */
  heritage: number;
  /** Share of the structure's mass pulled (Undercut). */
  pulled: number;
}

/** One played line: a sample at every settle (the last is the end), the engine steps, the end state's hash and any engine limit hit. */
export interface CastPlay {
  samples: CastSample[];
  /** Every shot of the line was fired and settled (false: the step budget ran out first). */
  complete: boolean;
  steps: number;
  hash: string;
  /** Sentences naming each engine limit that changed the physics (engine-api limitProblems); empty when none or the engine has no health(). */
  limits: string[];
  /** A Chorus level (chorus.ts): every world's outcome at the end. */
  chorus?: ChorusJudgement;
}

/** Each star metric's value in a sample. */
export const sampleValue = (s: CastSample, metric: StarMetric): number => (metric === 'collapse' ? s.collapse : metric === 'crowns' ? s.crowns : metric === 'skyline' ? s.skyline : metric === 'pulled' ? s.pulled : s.score);

/** The sample of a session as it stands at its last settle, banked there. */
export function sampleOf(session: Session, step: number): CastSample {
  const f = session.outcomeFacts(), score = outcomeScore(f, undefined);
  return { shots: session.outcomes.length, step, met: f.met, collapse: f.collapse, crowns: metricValue('crowns', f, 0), skyline: f.skylineRatio, score: score.total, heritage: f.heritageBroken, pulled: f.pulled };
}

export interface CastPlayOptions extends DriverOptions {
  maxSteps?: number;
  /** The per-step hook the level's page uses live (the game's), if any. */
  perStep?: PerStep;
}

/**
 * Plays `shots` on `engine` from the level's start (Driver.reset, so its pre-settle) and samples
 * each settle. Outcome levels only: a par level ends at its clear and has no bank points.
 */
export async function castPlay(engine: PhysicsEngine, c: CompiledLevel, shots: Shot[], opts: CastPlayOptions = {}): Promise<CastPlay> {
  if ((c.def.scoring ?? 'par') !== 'outcome') throw new Error(`castPlay: ${c.def.id} is a par level; stars are cast for outcome levels`);
  const samples: CastSample[] = [];
  const r = await runSession(engine, c, shots, {
    pipelined: opts.pipelined, maxSteps: opts.maxSteps, perStep: opts.perStep,
    // Aiming before shot `next`: shot next - 1 has settled, and the player could bank now.
    onAiming: (d) => { samples.push(sampleOf(d.session, d.snapshotStep)); },
  });
  const settled = r.session.outcomes.length;
  if (settled > samples.length) samples.push(sampleOf(r.session, r.session.outcomes[settled - 1]!.settleStep));
  const health = engine.health ? await engine.health() : null;
  const round = chorusRound(engine);
  return { samples, complete: settled === shots.length, steps: r.steps, hash: snapshotHash(r.snapshot), limits: limitProblems(health, engine.info.name), ...(round ? { chorus: round.judge() } : {}) };
}

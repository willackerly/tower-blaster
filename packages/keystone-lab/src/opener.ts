// Choosing a level's pre-aimed opener (the agent playtest's PT13): the shot a first visit is offered on the
// door's Fire button should win the level alone, so the first minute is a win. A cast already played hundreds of
// competent lines on the players' engine, each sampled at its first settle; their first shots are the
// candidates. Each candidate is played alone, exactly and as `n` nudges (nudgeLine: the cast's hand noise), on
// every engine asked for, and judged on its worst engine's lower quartile, so a pick does not hang on one lucky
// play or on one engine (the M5's GPU solver decides; Rapier, the smoke and CPU-fallback engine, must agree, as
// the door e2e plays on it). An opener counts only if every play settled within the promise (20 s of sim).
import { type LevelDef, physicsOf, readShots, sampleValue, type Shot, type StarMetric } from '@tb/keystone';
import { type CastPlayer, nudgeLine, rng, streamSeed } from './cast.ts';

/** The first-minute promise: the opener's collapse within this many seconds of sim (60 steps a second). */
export const OPENER_PROMISE_S = 20;

export interface OpenerCandidate { shot: string; /** The best first-settle value the source cast recorded for it. */ recorded: number }

/** One candidate on one engine: its first settle's metric value and settle time (s of sim after the fire), exact play first. */
export interface OpenerTrial { engine: string; adapter: string; values: number[]; settleS: number[]; limits: string[] }

export interface OpenerJudgement {
  shot: string;
  recorded: number;
  trials: OpenerTrial[];
  /** The lower quartile of the values on the engine where it is lowest. */
  score: number;
  /** Every play on every engine settled within OPENER_PROMISE_S with no limit hit and met the objective's minimum, and the score reached the floor. */
  wins: boolean;
}

interface CastJson { level: string; metric: StarMetric; lines: Array<{ shots: string; samples: Array<Record<string, number | boolean>> }> }

/** The `k` first shots of a level's cast lines (several casts pooled) with the highest first-settle metric, each once. */
export function openerCandidates(casts: CastJson[], k: number): OpenerCandidate[] {
  const best = new Map<string, number>();
  for (const cast of casts) for (const line of cast.lines) {
    const first = line.samples[0];
    if (!first) continue;
    const shot = line.shots.split('_')[0]!, v = Number(first[cast.metric]);
    if (!(best.get(shot)! >= v)) best.set(shot, v);
  }
  return [...best].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, k).map(([shot, recorded]) => ({ shot, recorded }));
}

/** The q-quantile of xs (nearest rank, lower). */
const lowerQuantile = (xs: number[], q: number) => [...xs].sort((a, b) => a - b)[Math.floor(q * (xs.length - 1))]!;

/**
 * Plays every candidate alone on every player (exactly, then `n` nudges seeded from `seed` and the shot), and
 * ranks them: winners first, then by score. The objective's minimum is the level's (collapse levels). `floor` is
 * the margin a winner's score (its worst engine's lower quartile) must reach; by default the objective's minimum.
 * PT13's second pass asks 0.45 of B1 (objective 0.4): two GPU adapters running the same solver spread about 0.05
 * (the door e2e measured the old opener 0.374 on SwiftShader against 0.427 on Metal).
 */
export async function judgeOpeners(level: LevelDef, candidates: OpenerCandidate[], players: CastPlayer[], n: number, seed: number, metric: StarMetric = 'collapse', floor?: number): Promise<OpenerJudgement[]> {
  const need = level.objective?.kind === 'collapse' ? level.objective.min : -Infinity, presettle = physicsOf(level).presettle;
  const out: OpenerJudgement[] = [];
  for (const cand of candidates) {
    const shot = readShots(cand.shot), r = rng(streamSeed(seed, 'opener', cand.shot));
    const lines: Shot[][] = [shot, ...Array.from({ length: n }, () => nudgeLine(shot, r))];
    const trials: OpenerTrial[] = [];
    for (const p of players) {
      const plays = await p.play(level, lines);
      trials.push({
        engine: p.engine, adapter: p.adapter,
        values: plays.map((x) => (x.samples[0] ? sampleValue(x.samples[0], metric) : 0)),
        settleS: plays.map((x) => (x.samples[0] ? (x.samples[0].step - presettle) / 60 : Infinity)),
        limits: plays.flatMap((x) => x.limits),
      });
    }
    const score = Math.min(...trials.map((t) => lowerQuantile(t.values, 0.25)));
    const wins = score >= (floor ?? need) && trials.every((t) => t.limits.length === 0 && t.values.every((v) => v >= need) && t.settleS.every((s) => s <= OPENER_PROMISE_S));
    out.push({ shot: cand.shot, recorded: cand.recorded, trials, score, wins });
  }
  return out.sort((a, b) => Number(b.wins) - Number(a.wins) || b.score - a.score);
}

/** The judgement as a markdown table, best first. */
export function openerMarkdown(level: LevelDef, judged: OpenerJudgement[], n: number, floor?: number): string {
  const engines = judged[0]?.trials.map((t) => `${t.engine} (${t.adapter})`) ?? [];
  const head = `| opener | recorded | ${engines.map((e) => `${e}: exact, min, p25, median, slowest settle`).join(' | ')} | score | wins |`;
  const rows = judged.map((j) => `| \`${j.shot}\` | ${j.recorded.toFixed(3)} | ${j.trials.map((t) => {
    const v = [...t.values].sort((a, b) => a - b);
    return `${t.values[0]!.toFixed(3)}, ${v[0]!.toFixed(3)}, ${lowerQuantile(v, 0.25).toFixed(3)}, ${lowerQuantile(v, 0.5).toFixed(3)}, ${Math.max(...t.settleS).toFixed(1)} s${t.limits.length ? ' LIMIT' : ''}`;
  }).join(' | ')} | ${j.score.toFixed(3)} | ${j.wins ? 'yes' : 'no'} |`);
  const pick = judged[0];
  return [
    `# ${level.id} opener (PT13)`, '',
    `Each candidate alone, exactly and as ${n} nudges, on ${engines.join(' and ')}. Score: the lower quartile on the engine where it is lowest. Wins: every play met the objective within ${OPENER_PROMISE_S} s of sim with no limit hit${floor === undefined ? '' : `, and the score reached ${floor}`}.`, '',
    head, `|${' --- |'.repeat(3 + engines.length)}---|`, ...rows, '',
    pick?.wins ? `Pick: \`${pick.shot}\` (solutions.opener: readShots('${pick.shot}')[0]).` : 'No candidate wins on every engine: keep the opener and route a first visit through L1 (PT13\'s fallback).',
    '',
  ].join('\n');
}

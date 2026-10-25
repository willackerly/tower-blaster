// pnpm tiers:compare [--scenario S5] [--steps 180] [--param k=v ...] [--seed 1] [--friction mu] [--runs 4] [--perturb 0.01] [--no-sleep]
// Runs plain Rapier and the tiered engine on Rapier over the same scene and
// prints the differential comparison and step times (CPU, this machine).
// With --runs K, both engines also run K perturbed copies (every input body
// nudged by k * --perturb (default 1%) relative speed), so the tiered result can be judged
// against the reference's own chaotic spread instead of a single run.
import { RapierEngine, RapierHost } from '@tb/adapter-rapier';
import type { SceneDesc } from '@tb/engine-api';
import { median, quantile } from '@tb/metrics';
import { buildScenario } from '@tb/scenarios';
import { compare, compareBonds, trace } from './compare.ts';
import { TieredEngine } from './tiered.ts';

const args = process.argv.slice(2);
const opt = (k: string, d: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1]! : d; };
const params: Record<string, number | boolean> = {};
args.forEach((a, i) => { if (a === '--param') { const [k, v] = args[i + 1]!.split('='); params[k!] = v === 'true' ? true : v === 'false' ? false : Number(v); } });
const base = buildScenario(opt('scenario', 'S5'), params, Number(opt('seed', '1')));
if (args.includes('--no-sleep')) base.sleep = false;
const fr = opt('friction', '');
if (fr !== '') {
  const mu = Number(fr);
  base.bodies.forEach((b) => { b.friction = mu; });
  base.inputs.forEach((ev) => { ev.body.friction = mu; });
  if (base.ground) base.ground.friction = mu;
}
const steps = Number(opt('steps', '180'));
const runs = Number(opt("runs", "0"));
const perturb = Number(opt("perturb", "0.01"));

function perturbed(k: number): SceneDesc {
  const s: SceneDesc = structuredClone(base);
  for (const ev of s.inputs) ev.body.linVel = ev.body.linVel.map((v) => v * (1 + perturb * k)) as typeof ev.body.linVel;
  return s;
}

const stat = (xs: number[]) => ({ mean: +(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(3), sd: +Math.sqrt(xs.reduce((a, b) => a + b * b, 0) / xs.length - (xs.reduce((a, b) => a + b, 0) / xs.length) ** 2).toFixed(3) });
const bondsOf = (b: ReturnType<typeof compareBonds>) => ({ brokenTest: b.brokenTest, brokenJaccard: b.jaccard });
type Run = ReturnType<typeof compare> & ReturnType<typeof bondsOf>;
const summary = (cs: Run[]) => ({
  jaccardToRef0: stat(cs.map((c) => c.jaccard)), moved: stat(cs.map((c) => c.movedTest)), spread: stat(cs.map((c) => c.spreadTest)),
  broken: stat(cs.map((c) => c.brokenTest)), brokenJaccardToRef0: stat(cs.map((c) => c.brokenJaccard)),
});

const ref0 = await trace(new RapierEngine(), base, steps);
const tiered = new TieredEngine(new RapierHost());
const test0 = await trace(tiered, base, steps);
const ms = (t: number[]) => ({ median: +median(t).toFixed(3), p90: +quantile(t, 0.9).toFixed(3), p99: +quantile(t, 0.99).toFixed(3), max: +Math.max(...t).toFixed(3) });
const out: Record<string, unknown> = {
  scenario: base.id, params: base.params, steps,
  comparison: compare(base, ref0.final, test0.final),
  bonds: compareBonds(base, ref0.final, test0.final),
  momentumX: { refFinal: ref0.momentumX.at(-1), testFinal: test0.momentumX.at(-1) },
  stepMs: { ref: ms(ref0.stepMs), tiered: ms(test0.stepMs) },
  tierStats: tiered.stats,
};
if (runs > 0) {
  const refs: Run[] = [], tests: Run[] = [];
  for (let k = 1; k <= runs; k++) {
    const s = perturbed(k);
    const r = (await trace(new RapierEngine(), s, steps)).final, t = (await trace(new TieredEngine(new RapierHost()), s, steps)).final;
    refs.push({ ...compare(base, ref0.final, r), ...bondsOf(compareBonds(base, ref0.final, r)) });
    tests.push({ ...compare(base, ref0.final, t), ...bondsOf(compareBonds(base, ref0.final, t)) });
  }
  out.perturbed = {
    runs,
    reference: summary(refs),
    tiered: summary(tests),
  };
}
console.log(JSON.stringify(out, null, 2));

// pnpm bench <command> [flags]
//   scenarios                         list scenarios and their parameters
//   run --engine E --scenario S [--param k=v ...] [--quality] [timing flags]
//   compare --a E1 --b E2 --scenario S [--param k=v ...] [timing flags]
//   selfcheck                         A/A and injected 10% slowdown (gate G1)
// Timing flags: --warmup N --block-steps N --blocks N --no-sleep --seed N --out file.jsonl
import { execSync } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname } from 'node:path';
import type { SceneDesc } from '@tb/engine-api';
import { buildScenario, SCENARIOS, type Params } from '@tb/scenarios';
import { makeEngine, SlowedEngine } from './engines.ts';
import { compareBlocks, DEFAULT_TIMING, qualityGates, qualityRun, timeInterleaved, timingSummary, type TimingOptions } from './run.ts';

interface Args { _: string[]; flags: Record<string, string | true>; params: Params }

function parseArgs(argv: string[]): Args {
  const out: Args = { _: [], flags: {}, params: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
    if (key === 'param') {
      if (value === true) throw new Error('--param needs k=v');
      const [k, v] = value.split('=');
      if (!k || v === undefined) throw new Error(`bad --param ${value}`);
      out.params[k] = v === 'true' ? true : v === 'false' ? false : Number(v);
    } else out.flags[key] = value;
  }
  return out;
}

const int = (a: Args, k: string, d: number) => (typeof a.flags[k] === 'string' ? Number(a.flags[k]) : d);

function timingOpts(a: Args, d: TimingOptions = DEFAULT_TIMING): TimingOptions {
  return { warmup: int(a, 'warmup', d.warmup), blockSteps: int(a, 'block-steps', d.blockSteps), blocks: int(a, 'blocks', d.blocks) };
}

function sceneFrom(a: Args): SceneDesc {
  const id = a.flags.scenario;
  if (typeof id !== 'string') throw new Error('--scenario is required');
  const s = buildScenario(id, a.params, int(a, 'seed', 1));
  if (a.flags['no-sleep']) s.sleep = false;
  return s;
}

function env() {
  let git = 'unknown';
  try { git = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { /* not a checkout */ }
  return { git, node: process.version, platform: `${platform()} ${release()}`, cpu: cpus()[0]?.model ?? 'unknown', cores: cpus().length, time: new Date().toISOString() };
}

function emit(a: Args, record: object): void {
  const line = JSON.stringify(record);
  console.log(JSON.stringify(record, null, 2));
  if (typeof a.flags.out === 'string') {
    mkdirSync(dirname(a.flags.out), { recursive: true });
    appendFileSync(a.flags.out, line + '\n');
  }
}

const sceneKey = (s: SceneDesc) => ({ id: s.id, params: s.params, seed: s.seed, sleep: s.sleep, bodies: s.bodies.length, inputs: s.inputs.length });

async function cmdRun(a: Args) {
  const scene = sceneFrom(a);
  const engine = makeEngine(String(a.flags.engine ?? 'rapier'));
  const [blocks] = await timeInterleaved([engine], scene, timingOpts(a));
  const record: Record<string, unknown> = { schema: 1, kind: 'run', env: env(), engine: engine.info, scene: sceneKey(scene), timing: timingSummary(blocks!) };
  if (a.flags.quality) {
    const steps = int(a, 'quality-steps', 600);
    const q = qualityRun(engine, scene, { steps, sampleEvery: int(a, 'sample-every', 30) });
    const report = await q;
    const untouched = scene.inputs.length === 0;
    record.quality = { ...report, series: undefined, gates: qualityGates(report, untouched) };
  }
  engine.dispose();
  emit(a, record);
}

async function cmdCompare(a: Args) {
  const scene = sceneFrom(a);
  const ea = makeEngine(String(a.flags.a ?? 'rapier')), eb = makeEngine(String(a.flags.b ?? 'rapier'));
  const [ba, bb] = await timeInterleaved([ea, eb], scene, timingOpts(a));
  const cmp = compareBlocks(ba!, bb!, Number(a.flags.threshold ?? 0.02));
  emit(a, { schema: 1, kind: 'compare', env: env(), a: ea.info, b: eb.info, scene: sceneKey(scene), timingA: timingSummary(ba!), timingB: timingSummary(bb!), comparison: cmp });
  ea.dispose(); eb.dispose();
}

/**
 * Gate G1. On a steady CPU workload: two identical engines must show no
 * difference beyond 3%, and a copy slowed by exactly 10% must be detected.
 */
async function cmdSelfcheck(a: Args) {
  const scene = buildScenario('S1', { F: 5, H: 8, gap: 0.02 });
  scene.sleep = false;
  const opts = timingOpts(a, { warmup: 60, blockSteps: 20, blocks: 40 });
  const [a1, a2] = await timeInterleaved([makeEngine('rapier'), makeEngine('rapier')], scene, opts);
  const aa = compareBlocks(a1!, a2!, 0.03);
  const [s1, s2] = await timeInterleaved([makeEngine('rapier'), new SlowedEngine(makeEngine('rapier'), 0.1)], scene, opts);
  const slow = compareBlocks(s1!, s2!, 0.03);
  const checks = {
    aaNoDifference: aa.verdict === 'no-difference',
    slowdownDetected: slow.verdict === 'slower',
    slowdownEstimateSane: slow.diff.estimate > 0.05 && slow.diff.estimate < 0.2,
  };
  const pass = Object.values(checks).every(Boolean);
  emit(a, { schema: 1, kind: 'selfcheck', env: env(), scene: sceneKey(scene), aa: aa.diff, slowdown: slow.diff, checks, pass, medianStepMs: timingSummary(a1!).wallMs.median });
  if (!pass) process.exitCode = 1;
}

function cmdScenarios() {
  for (const s of Object.values(SCENARIOS)) console.log(`${s.id.padEnd(4)} ${s.title.padEnd(22)} ${JSON.stringify(s.defaults)}  catches: ${s.catches}`);
}

const args = parseArgs(process.argv.slice(2));
const commands: Record<string, (a: Args) => unknown> = { run: cmdRun, compare: cmdCompare, selfcheck: cmdSelfcheck, scenarios: cmdScenarios };
const cmd = commands[args._[0] ?? ''];
if (!cmd) {
  console.error(`usage: pnpm bench <${Object.keys(commands).join('|')}> [flags]`);
  process.exitCode = 2;
} else {
  Promise.resolve(cmd(args)).catch((e: unknown) => { console.error(e); process.exitCode = 1; });
}

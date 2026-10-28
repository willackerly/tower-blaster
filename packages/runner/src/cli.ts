// pnpm bench:browser --engines rapier --scenario S4 --param N=10000 [--headed] [--channel chrome]
//   [--warmup N --block-steps N --blocks N --timing-mode latency|throughput --sleep true|false --bounce e --seed N --quality-steps N --out f.jsonl]
//   [--allow-invalid] [--allow-limits]
// --bounce e puts every body, spawn and the ground at restitution e (0-1), for engines with restitution=true.
// Runs the benchmark in a real browser tab. Exits 3 if the timing
// environment is not trustworthy (no isolation, coarse timer, software GPU)
// unless --allow-invalid is given, and 4 (first) if an engine hit a limit that
// changed its physics, e.g. the GPU pair buffer dropped contacts, unless
// --allow-limits is given: the record (limitProblems) says which and the fix.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { exitNow } from '@tb/testkit';
import { exitCodeFor, parseConfig } from './config.ts';
import { openRunner } from './orchestrate.ts';

const argv = process.argv.slice(2);
const flags: Record<string, string | true> = {};
const q = new URLSearchParams();
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
  const key = a.slice(2);
  const next = argv[i + 1];
  const value = next !== undefined && !next.startsWith('--') ? (i++, next) : true;
  if (key === 'param') {
    if (value === true) throw new Error('--param needs k=v');
    const [k, v] = value.split('=');
    q.set(`param.${k}`, v ?? '');
  } else flags[key] = value;
}
const map: Record<string, string> = { engines: 'engines', engine: 'engines', scenario: 'scenario', seed: 'seed', sleep: 'sleep', bounce: 'bounce', warmup: 'warmup', 'block-steps': 'blockSteps', blocks: 'blocks', 'timing-mode': 'timingMode', 'quality-steps': 'qualitySteps' };
for (const [k, v] of Object.entries(flags)) if (map[k] && typeof v === 'string') q.set(map[k]!, v);

const config = parseConfig(`?${q.toString()}`);
const runner = await openRunner({
  headed: flags.headed === true,
  ...(typeof flags.channel === 'string' ? { channel: flags.channel } : {}),
});
let stuck: string[] = [];
try {
  const result = await runner.run(config);
  // Reported before teardown, which can hang (see closeWithin).
  console.log(JSON.stringify(result, null, 2));
  if (typeof flags.out === 'string') {
    mkdirSync(dirname(flags.out), { recursive: true });
    appendFileSync(flags.out, JSON.stringify(result) + '\n');
  }
  const limits = result.limitProblems as string[];
  if (!result.timingValid) console.error(`timing not valid here: ${(result.timingProblems as string[]).join('; ')}`);
  if (limits.length) console.error(`the physics hit an engine limit, so this timed a different simulation:\n${limits.map((l) => `  ${l}`).join('\n')}`);
  process.exitCode = exitCodeFor([{ valid: result.timingValid === true, limitProblems: limits }], { invalid: !!flags['allow-invalid'], limits: !!flags['allow-limits'] });
} finally {
  stuck = await runner.close();
}
// A browser or server that did not close keeps Node alive.
if (stuck.length) await exitNow();

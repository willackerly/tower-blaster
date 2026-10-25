// pnpm bench:browser --engines rapier --scenario S4 --param N=10000 [--headed] [--channel chrome]
//   [--warmup N --block-steps N --blocks N --sleep true|false --seed N --quality-steps N --out f.jsonl]
// Runs the benchmark in a real browser tab. Exits non-zero if the timing
// environment is not trustworthy (no isolation, coarse timer, software GPU)
// unless --allow-invalid is given.
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseConfig } from './config.ts';
import { runInBrowser } from './orchestrate.ts';

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
const map: Record<string, string> = { engines: 'engines', engine: 'engines', scenario: 'scenario', seed: 'seed', sleep: 'sleep', warmup: 'warmup', 'block-steps': 'blockSteps', blocks: 'blocks', 'quality-steps': 'qualitySteps' };
for (const [k, v] of Object.entries(flags)) if (map[k] && typeof v === 'string') q.set(map[k]!, v);

const config = parseConfig(`?${q.toString()}`);
const result = await runInBrowser(config, {
  headed: flags.headed === true,
  ...(typeof flags.channel === 'string' ? { channel: flags.channel } : {}),
});
console.log(JSON.stringify(result, null, 2));
if (typeof flags.out === 'string') {
  mkdirSync(dirname(flags.out), { recursive: true });
  appendFileSync(flags.out, JSON.stringify(result) + '\n');
}
if (!result.timingValid && !flags['allow-invalid']) {
  console.error(`timing not valid here: ${(result.timingProblems as string[]).join('; ')}`);
  process.exitCode = 3;
}

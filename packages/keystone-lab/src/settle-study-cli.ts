// pnpm keystone:settle-study <report.json> [--engine ref|rapier] [--rule v3|v4] [--only B1,T-S4] [--max-bodies N] [--part k/N] [--out file.jsonl]
// Replays an agent playtest report's lines (shots with a recorded aim; a HUD opener is skipped) and
// writes one JSON line per line: each shot's fire-to-settle steps and D, the line's final D, and the
// trace of D per step (settle-study.ts). Lines that repeat (same level, same shots) run once.
import { appendFileSync, readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { checkSettle, compileLevel, findLevel, type Shot } from '@tb/keystone';
import { labArgs } from './engines.ts';
import { traceLine } from './settle-study.ts';

interface ReportRun { scenario: string; url: string; shots: Array<{ shot: Shot | null }> }

const { spec, flags, ids } = labArgs(process.argv.slice(2), 1);
const report = JSON.parse(readFileSync(ids[0]!, 'utf8')) as ReportRun[];
const only = flags.get('only')?.split(',');
const rule = flags.has('rule') ? checkSettle(flags.get('rule'), '--rule') : undefined;
const [k, N] = (flags.get('part') ?? '0/1').split('/').map(Number) as [number, number];
const out = flags.get('out');
const maxBodies = Number(flags.get('max-bodies') ?? Infinity);

const seen = new Set<string>(), lines: Array<{ id: string; scenario: string; shots: Shot[] }> = [];
for (const run of report) {
  const id = new URLSearchParams(run.url.replace(/^\?/, '')).get('level');
  if (!id || !findLevel(id) || (only && !only.some((p) => id === p || id.startsWith(`${p}-`)))) continue;
  if (new URLSearchParams(run.url.replace(/^\?/, '')).has('keystone.freeze')) continue;
  if (compileLevel(findLevel(id)!).meta.n > maxBodies) continue;
  const shots = run.shots.map((s) => s.shot).filter((s): s is Shot => s !== null);
  if (!shots.length) continue;
  const key = `${id} ${JSON.stringify(shots)}`;
  if (seen.has(key)) continue;
  seen.add(key);
  lines.push({ id, scenario: run.scenario, shots });
}
const mine = lines.filter((_, i) => i % N === k);
console.error(`${lines.length} lines, part ${k}/${N}: ${mine.length}`);
for (const l of mine) {
  const t = await traceLine(spec, findLevel(l.id)!, l.shots, rule, () => performance.now());
  const row = JSON.stringify({ scenario: l.scenario, shotsIn: l.shots, ...t });
  if (out) appendFileSync(out, `${row}\n`);
  console.error(`${l.scenario} ${l.id}: ${t.shots.map((s) => `${((s.settled - s.fired) / 60).toFixed(1)}s D ${s.d.toFixed(3)}`).join(' | ')} final ${t.finalD.toFixed(4)} (${(t.wallMs / 1000).toFixed(0)} s wall)`);
}

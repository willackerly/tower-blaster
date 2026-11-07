// Test files split into CI shards of about equal time. vitest's own --shard
// cuts the file list sorted by path hash into equal counts, which puts most
// of the time in whichever shard draws the few GPU files that take minutes.
// planShards balances recorded durations instead (vitest.durations.json,
// written by `pnpm test:durations`); stale or missing numbers only make the
// shards less even, never skip or repeat a file.

/** Seconds per test file, keyed by its path relative to the repo root. */
export type Durations = Record<string, number>;

/**
 * Longest processing time first: each file, longest first, goes to the shard
 * with the least time so far (ties: the lower index; equal files: by path),
 * so the result depends only on the inputs. A file without a recorded
 * duration counts as the median recorded one (most new files are unit
 * tests). Every file lands in exactly one shard; shards may be empty.
 */
export function planShards(files: readonly string[], durations: Durations, count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error(`planShards: count must be a positive integer, got ${count}`);
  const fallback = median(Object.values(durations));
  const cost = (f: string) => durations[f] ?? fallback;
  const order = [...new Set(files)].sort((a, b) => cost(b) - cost(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: count }, () => ({ files: [] as string[], load: 0 }));
  for (const f of order) {
    let best = shards[0]!;
    for (const s of shards) if (s.load < best.load) best = s;
    best.files.push(f);
    best.load += cost(f);
  }
  return shards.map((s) => s.files);
}

/** A shard's recorded seconds (unknown files at the median), for the log line. */
export function shardLoad(files: readonly string[], durations: Durations): number {
  const fallback = median(Object.values(durations));
  return files.reduce((t, f) => t + (durations[f] ?? fallback), 0);
}

/**
 * vitest's workers in one shard: os.availableParallelism() - 1 on the 4-vCPU
 * runners. The suite is CPU-bound, so a shard's wall time is its recorded
 * file-seconds over the workers: main's run 806 took 2.85-2.95x less wall
 * time than file time on every one of its 8 shards.
 */
export const SHARD_WORKERS = 3;

/** A shard's wall-time estimate in seconds: its files spread over the workers, and never under its longest file. */
export function shardWall(files: readonly string[], durations: Durations, workers = SHARD_WORKERS): number {
  const fallback = median(Object.values(durations));
  const times = files.map((f) => durations[f] ?? fallback);
  return Math.max(times.reduce((a, b) => a + b, 0) / workers, ...times, 0);
}

export interface ShardLimits {
  /** Most seconds a shard's wall estimate may reach. */
  shard: number;
  /** Most recorded seconds one file may take (a file runs on one worker). */
  file: number;
}

export interface ShardProblem {
  /** stale: the durations file and the test files disagree; file: one file over its limit; shard: a shard estimated over its limit. */
  kind: 'stale' | 'file' | 'shard';
  message: string;
}

/**
 * What is wrong with the durations file and the shard plan (empty when
 * nothing is): test files with no recorded time and times for files that no
 * longer exist, files over the per-file limit, and shards whose wall
 * estimate passes the limit. `files` are the files the shards run; `known`
 * (default `files`) every test file, so a file left out of the shards on
 * purpose is not counted stale.
 */
export function checkShards(files: readonly string[], durations: Durations, count: number, limits: ShardLimits, known: readonly string[] = files): ShardProblem[] {
  const problems: ShardProblem[] = [];
  const all = new Set(known);
  for (const f of [...all].sort()) if (!(f in durations)) problems.push({ kind: 'stale', message: `${f} has no recorded time` });
  for (const f of Object.keys(durations).sort()) if (!all.has(f)) problems.push({ kind: 'stale', message: `${f} has a recorded time but is not a test file` });
  for (const f of [...files].sort()) {
    const t = durations[f];
    if (t !== undefined && t > limits.file) problems.push({ kind: 'file', message: `${f}: ${t} s recorded, over the ${limits.file} s one file may take` });
  }
  planShards(files, durations, count).forEach((s, i) => {
    const wall = shardWall(s, durations);
    if (wall > limits.shard) problems.push({ kind: 'shard', message: `shard ${i + 1}/${count}: ~${Math.round(wall / 6) / 10} min estimated, over ${limits.shard / 60} min` });
  });
  return problems;
}

function median(x: number[]): number {
  if (x.length === 0) return 1;
  const s = [...x].sort((a, b) => a - b);
  return s[s.length >> 1]!;
}

/** Durations from a vitest JSON report (--reporter=json): each file's wall time, rounded to 0.1 s. */
export function durationsFromReport(report: { testResults: Array<{ name: string; startTime: number; endTime: number }> }, root: string): Durations {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  const out: Durations = {};
  for (const r of [...report.testResults].sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const name = r.name.startsWith(prefix) ? r.name.slice(prefix.length) : r.name;
    out[name] = Math.round((r.endTime - r.startTime) / 100) / 10;
  }
  return out;
}

/** The times in CI shard logs: every `vitest-durations {...}` line ("Shard file times" step), later lines winning. */
export function durationsFromLog(text: string): Durations {
  const out: Durations = {};
  for (const m of text.matchAll(/vitest-durations (\{.*\})/g)) Object.assign(out, JSON.parse(m[1]!) as Durations);
  return out;
}

/** New times over old ones, keeping only files that still exist, sorted by path. */
export function mergeDurations(old: Durations, measured: Durations, exists: (file: string) => boolean): Durations {
  return Object.fromEntries(Object.entries({ ...old, ...measured }).filter(([f]) => exists(f)).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Files that took over half again their recorded time and a minute more: the shard plan is off by that much. */
export function drifted(measured: Durations, recorded: Durations): Array<{ file: string; took: number; recorded: number }> {
  return Object.entries(measured).flatMap(([file, took]) => {
    const r = recorded[file];
    return r !== undefined && took > 1.5 * r && took - r > 60 ? [{ file, took, recorded: r }] : [];
  }).sort((a, b) => (a.file < b.file ? -1 : 1));
}

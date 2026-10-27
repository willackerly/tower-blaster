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

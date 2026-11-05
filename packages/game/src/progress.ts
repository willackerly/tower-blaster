// Progress kept in the browser (roadmap G7): each level's best play and how
// many times it was played, so the front door can show stars earned and the
// next level to try. Pure functions over a small JSON record, plus a store on
// a key-value interface (localStorage on the page, a Map in tests).
//
// Records are per level id AND level hash: a level re-authored since (its
// structure, rack, physics or rules: anything in the hash) is a new level, so
// its old best is not shown as if earned on it. Custom runs (URL overrides,
// another engine than the cast's) are not recorded: "custom: stars not
// recorded", as the HUD says.
import { atLeast, type LevelScore, type OutcomeScore, type StarMetric } from '@tb/keystone';

/** The localStorage key; the version in it changes only with an incompatible record shape. */
export const PROGRESS_KEY = 'tb.progress.v1';

/** A level's record: its best play (stars, then the star metric, then the total) and plays so far. */
export interface LevelRecord {
  /** The level hash the record was earned on (CompiledLevel.hash). */
  hash: string;
  plays: number;
  stars: 0 | 1 | 2 | 3;
  total: number;
  /** Outcome levels: the star metric and its value in the best play, and the collapse fraction then. */
  metric?: StarMetric;
  value?: number;
  collapse?: number;
  /** Outcome levels: the best play beat the best bot play. */
  beatBot?: boolean;
  /** ISO time of the best play. */
  at: string;
  /** Lot sheet goals (goals.ts ids) met on any play of this hash, in the order first met. Absent: none yet. */
  goals?: string[];
}

export interface Progress { version: 1; levels: Record<string, LevelRecord> }

export const emptyProgress = (): Progress => ({ version: 1, levels: {} });

const isRecord = (r: unknown): r is LevelRecord => {
  if (typeof r !== 'object' || r === null) return false;
  const o = r as Record<string, unknown>;
  return typeof o.hash === 'string' && Number.isInteger(o.plays) && (o.plays as number) >= 1 && [0, 1, 2, 3].includes(o.stars as number) && typeof o.total === 'number' && typeof o.at === 'string'
    && (o.goals === undefined || (Array.isArray(o.goals) && o.goals.every((g) => typeof g === 'string')));
};

/** Progress from stored text: anything unreadable (absent, not JSON, another version) is empty, and bad records are dropped. */
export function parseProgress(text: string | null): Progress {
  if (!text) return emptyProgress();
  try {
    const p = JSON.parse(text) as Partial<Progress>;
    if (p.version !== 1 || typeof p.levels !== 'object' || p.levels === null) return emptyProgress();
    return { version: 1, levels: Object.fromEntries(Object.entries(p.levels).filter(([, r]) => isRecord(r))) };
  } catch {
    return emptyProgress();
  }
}

/** a is a better play than b: more stars; then, on the same metric, a better value; then a higher total. */
export function betterPlay(a: Omit<LevelRecord, 'plays' | 'at' | 'hash'>, b: Omit<LevelRecord, 'plays' | 'at' | 'hash'>): boolean {
  if (a.stars !== b.stars) return a.stars > b.stars;
  if (a.metric !== undefined && a.metric === b.metric && a.value !== undefined && b.value !== undefined && a.value !== b.value) return atLeast(a.metric, a.value, b.value);
  return a.total > b.total;
}

/** What a finished play contributes to a record. */
export function playOf(score: LevelScore): Omit<LevelRecord, 'plays' | 'at' | 'hash'> {
  const o = (score as Partial<OutcomeScore>).outcome;
  return { stars: score.stars, total: score.total, ...(o ? { metric: o.metric, value: o.value, collapse: o.collapse, beatBot: o.beatBot } : {}) };
}

/**
 * p with one finished play of level `id` (hash `hash`) recorded; p itself is unchanged. A play on another hash starts the record over.
 * `goals`: the lot sheet goals this play met, added to those met before on the same hash (goals are kept whichever play was best).
 */
export function recordPlay(p: Progress, id: string, hash: string, score: LevelScore, now: Date = new Date(), goals: readonly string[] = []): Progress {
  const old = p.levels[id], play = playOf(score);
  const same = old && old.hash === hash ? old : null;
  const next: LevelRecord = same && !betterPlay(play, same) ? { ...same, plays: same.plays + 1 } : { hash, plays: (same?.plays ?? 0) + 1, ...play, at: now.toISOString() };
  const met = [...(same?.goals ?? [])];
  for (const g of goals) if (!met.includes(g)) met.push(g);
  if (met.length) next.goals = met; else delete next.goals;
  return { version: 1, levels: { ...p.levels, [id]: next } };
}

/** Level id's record if it was earned on this hash, else null (never played, or played before the level changed). */
export function bestFor(p: Progress, id: string, hash: string): LevelRecord | null {
  const r = p.levels[id];
  return r && r.hash === hash ? r : null;
}

/** The part of Storage the stores use: localStorage, or a Map-backed stand-in in tests. */
export interface KeyValue { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

/** A Map-backed KeyValue: tests, and the page when storage is off or unavailable (private windows can throw). */
export function memoryKeyValue(init: Record<string, string> = {}): KeyValue {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** The page's localStorage if it can be read and written here, else null. */
export function browserKeyValue(): KeyValue | null {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = '__tb_probe';
    s.setItem(probe, '1');
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}

/**
 * Progress on a KeyValue. Reads once, writes after every record; a write that throws (quota, a
 * private window) keeps the progress in memory for the rest of the visit.
 */
export class ProgressStore {
  private p: Progress;
  constructor(private readonly kv: KeyValue, private readonly key = PROGRESS_KEY) {
    let text: string | null = null;
    try { text = kv.getItem(key); } catch { /* unreadable: start empty */ }
    this.p = parseProgress(text);
  }
  get progress(): Progress { return this.p; }
  best(id: string, hash: string): LevelRecord | null { return bestFor(this.p, id, hash); }
  record(id: string, hash: string, score: LevelScore, now?: Date, goals?: readonly string[]): LevelRecord {
    this.p = recordPlay(this.p, id, hash, score, now, goals);
    this.save();
    return this.p.levels[id]!;
  }
  reset(): void {
    this.p = emptyProgress();
    try { this.kv.removeItem(this.key); } catch { /* memory only */ }
  }
  private save(): void {
    try { this.kv.setItem(this.key, JSON.stringify(this.p)); } catch { /* memory only */ }
  }
}

/** ?progress=off keeps progress for this visit only (tests, demos); absent or on uses the browser's storage. */
export function progressStore(q: URLSearchParams, kv: KeyValue | null = browserKeyValue()): ProgressStore {
  const v = q.get('progress') ?? 'on';
  if (v !== 'on' && v !== 'off') throw new Error(`progress must be on or off: ${v}`);
  return new ProgressStore(v === 'on' && kv ? kv : memoryKeyValue());
}

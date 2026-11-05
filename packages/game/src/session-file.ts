// A saved play session (roadmap G8: the playtest's "Save session" button):
// what a tester sends back so a round can be replayed and looked at. It holds
// the level (id and hash), the shots as a line (@tb/keystone writeShots), the
// engine and adapter it ran on, the score, and a replay link that plays the
// same line on the game page. The GPU solver is deterministic per device, so
// the link replays to the same score on the same kind of machine (and exactly
// on Rapier); on another GPU it replays close to it.
import { type LevelScore, type Shot, writeShots } from '@tb/keystone';

export const SESSION_KIND = 'keystone-session';

export interface SessionFile {
  kind: typeof SESSION_KIND;
  version: 1;
  level: string;
  hash: string;
  custom: boolean;
  engine: string;
  /** The GPU adapter (vendor, architecture), or '' for a CPU engine. */
  adapter: string;
  /** The shots in order, as a keystone.shots line; a rapid-fire shot ends `@after` (steps after the shot before: @tb/keystone Shot.after). */
  shots: string;
  /** The round ended at a bank (the replay banks once the line has settled: keystone.bank=1). */
  banked: boolean;
  score: LevelScore;
  /** The build it was played on (the playtest's build.json commit), when known. */
  build: string;
  savedAt: string;
  /** The game page link that replays the round. */
  replay: string;
}

export interface SessionFacts {
  level: string;
  hash: string;
  custom: boolean;
  engine: string;
  adapter: string;
  shots: readonly Shot[];
  banked: boolean;
  score: LevelScore;
  build?: string;
}

/**
 * The replay link: the page's own URL with the level and line set, a bank after the line when the round
 * ended at one, and the front door off (the link is for watching the round, not choosing a level).
 */
export function replayUrl(pageUrl: string, f: Pick<SessionFacts, 'level' | 'shots' | 'banked'>): string {
  const u = new URL(pageUrl);
  const q = u.searchParams;
  q.set('level', f.level);
  q.set('keystone.shots', writeShots(f.shots));
  if (f.banked) q.set('keystone.bank', '1');
  else q.delete('keystone.bank');
  q.delete('door');
  u.hash = '';
  return u.toString();
}

export function sessionFile(f: SessionFacts, pageUrl: string, now: Date = new Date()): SessionFile {
  if (!f.shots.length) throw new Error('sessionFile: no shots to save');
  return {
    kind: SESSION_KIND, version: 1, level: f.level, hash: f.hash, custom: f.custom, engine: f.engine, adapter: f.adapter,
    shots: writeShots(f.shots), banked: f.banked, score: f.score, build: f.build ?? '', savedAt: now.toISOString(),
    replay: replayUrl(pageUrl, f),
  };
}

/** The file's name: keystone-B1-2026-11-02T03-04-05.json. */
export const sessionFileName = (s: SessionFile) => `keystone-${s.level}-${s.savedAt.slice(0, 19).replace(/:/g, '-')}.json`;

/** ?keystone.bank=1: bank once ?keystone.shots has played and settled, if the level is still open (a saved session that banked). */
export function bankAfterLine(q: URLSearchParams): boolean {
  const v = q.get('keystone.bank');
  if (v !== null && v !== '0' && v !== '1') throw new Error(`keystone.bank must be 0 or 1: ${v}`);
  return v === '1';
}

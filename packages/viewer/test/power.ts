// The Mac's power state, for benches whose timings mean nothing on a throttled
// GPU. E7 round 2 (23c0df8, 2026-11-06) ran with Low Power Mode on: every 10k
// step cost about 1.8x what it did the day before (39 ms against 22-24 ms) and
// no frame gate could be judged, an hour of the M5 lost. So the G4 probe
// records this in every summary line and refuses to start in Low Power Mode.
import { execFileSync } from 'node:child_process';

export interface PowerState {
  /** Low Power Mode is on now: `lowpowermode 1`, or Energy Mode Low (`powermode 1`) on Macs that have that setting. */
  lowPower: boolean;
  /** On AC power (pmset -g ps); null when pmset did not say. */
  ac: boolean | null;
  /** The raw settings read, for the record: lowpowermode, powermode. */
  raw: Record<string, number>;
}

/**
 * The power state from `pmset -g` (its "Currently in use" settings, which are the current power
 * source's) and `pmset -g ps`. Pure, for tests.
 */
export function parsePmset(settings: string, ps: string): PowerState {
  const raw: Record<string, number> = {};
  for (const m of settings.matchAll(/^\s*(lowpowermode|powermode)\s+(\d+)\s*$/gm)) raw[m[1]!] = Number(m[2]);
  const lowPower = raw.lowpowermode === 1 || raw.powermode === 1;
  const ac = /'AC Power'/.test(ps) ? true : /'Battery Power'/.test(ps) ? false : null;
  return { lowPower, ac, raw };
}

/** The power state on macOS; null elsewhere or when pmset fails. */
export function powerState(): PowerState | null {
  if (process.platform !== 'darwin') return null;
  try {
    const run = (args: string[]) => execFileSync('pmset', args, { encoding: 'utf8', timeout: 5000 });
    return parsePmset(run(['-g']), run(['-g', 'ps']));
  } catch {
    return null;
  }
}

// Weapon fun check (weapons plan steps 5 and 6: "at least one new built-in
// weapon per step that is fun on L1-L5"). For each level and each launch item,
// one shot of it alone at every candidate the par bot aims (bot.ts candidates:
// every cell of every side face, every other course, two powers), played to
// rest on a real engine. What a shot does is summed up as:
//   cleared   the level's objective met by that one shot;
//   crowns    crowns down (mean, and the best shot's);
//   moved     structure bodies more than half a cell from home (mean share):
//             how much a shot does at all, the spectacle;
//   lively    the share of shots that move at least one body: how forgiving the
//             item is to aim;
//   heritage  heritage bodies broken (mean).
// None of this is a star line; it is the comparison a designer reads to say
// whether a new weapon plays differently from the marble and the cannonball
// (docs/game/weapon-trials.md).
import { compileLevel, type LaunchItem, type LevelDef } from '@tb/keystone';
import { candidates } from './bot.ts';
import { engineSubsteps } from './engines.ts';
import type { Runner } from './runner.ts';

export interface FunRow {
  level: string;
  item: LaunchItem;
  shots: number;
  cleared: number;
  crowns: number;
  bestCrowns: number;
  moved: number;
  lively: number;
  heritage: number;
}

/** One row per level and item: `item` alone in the rack, fired at every candidate (every `every` courses). */
export async function weaponFun(levels: readonly LevelDef[], items: readonly LaunchItem[], runner: Runner, opts: { every?: number; powers?: number[] } = {}): Promise<FunRow[]> {
  const rows: FunRow[] = [];
  for (const base of levels) for (const item of items) {
    const level: LevelDef = { ...base, rack: [item] };
    const c = compileLevel(level), n = c.meta.home.length / 3, cell = c.frame.unit * c.frame.pitch;
    const cands = candidates(level, { every: opts.every ?? 2, powers: opts.powers, substeps: engineSubsteps(runner.spec), ammo: [item] });
    const results = await Promise.all(cands.map((k) => runner.play(level, [k.shot])));
    let cleared = 0, crowns = 0, bestCrowns = 0, moved = 0, lively = 0, heritage = 0;
    for (const r of results) {
      const s = r.session, down = s.crownDown.reduce((a, x) => a + x, 0);
      let m = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(r.snapshot.pos[3 * i]! - s.home[3 * i]!, r.snapshot.pos[3 * i + 1]! - s.home[3 * i + 1]!, r.snapshot.pos[3 * i + 2]! - s.home[3 * i + 2]!);
        if (d > 0.5 * cell) m++;
      }
      if (s.phase === 'cleared') cleared++;
      crowns += down;
      bestCrowns = Math.max(bestCrowns, down);
      moved += m / n;
      if (m > 0) lively++;
      heritage += s.heritageBroken.reduce((a, x) => a + x, 0);
    }
    const k = Math.max(1, results.length);
    rows.push({ level: base.id, item, shots: results.length, cleared: cleared / k, crowns: crowns / k, bestCrowns, moved: moved / k, lively: lively / k, heritage: heritage / k });
  }
  return rows;
}

/** The rows as a Markdown table. */
export function funTable(rows: readonly FunRow[]): string {
  const pct = (x: number) => `${Math.round(100 * x)}%`;
  return [
    '| Level | Item | Shots | Cleared in one | Crowns (mean / best) | Moved (mean share) | Lively | Heritage broken (mean) |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.level} | ${r.item} | ${r.shots} | ${pct(r.cleared)} | ${r.crowns.toFixed(2)} / ${r.bestCrowns} | ${pct(r.moved)} | ${pct(r.lively)} | ${r.heritage.toFixed(2)} |`),
  ].join('\n');
}

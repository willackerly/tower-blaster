// pnpm keystone:stars [L1 ...] [--launch level,high] [--every N] [--powers 60,100] [--engine ref|rapier] [--jobs N] [--json out.json]
// The par levels' star audit (docs/game/stars.md): every one-shot clear the bot's candidates find,
// from each launcher height, scored under the star rule before 2026-11-06 (par plus leverage over the
// level's gold line for the third star) and under parStars (three for a clear in par with heritage
// intact). Prints, per level and height: how many candidates cleared in one shot, how many of those
// broke heritage, the leverage spread against lGold, and the stars each rule gives them.
import { availableParallelism } from 'node:os';
import { writeFileSync } from 'node:fs';
import { DEFAULT_GOLD, LEVELS } from '@tb/keystone';
import { candidates } from './bot.ts';
import { engineLabel, engineSubsteps, labArgs } from './engines.ts';
import { quantile } from './probe.ts';
import { makeRunner } from './runner.ts';
import { launchHeights, oldParStars } from './stars-audit.ts';

const { spec, jobs, flags, ids } = labArgs(process.argv.slice(2), availableParallelism());
const launches = (flags.get('launch') ?? 'level,high').split(',') as Array<'level' | 'high'>;
const every = Number(flags.get('every') ?? 4), powers = (flags.get('powers') ?? '100').split(',').map(Number);
const runner = makeRunner(spec, jobs);
console.log(`engine ${engineLabel(spec)}, ${runner.jobs} job(s), every ${every} courses, powers ${powers.join('/')}`);
const rows: unknown[] = [];
const hist = (xs: number[]) => [0, 1, 2, 3].map((k) => xs.filter((x) => x === k).length).join('/');
try {
  for (const def of LEVELS.filter((l) => !ids.length || ids.includes(l.id))) {
    const gold = def.lGold ?? DEFAULT_GOLD, heights = launchHeights(def);
    for (const launch of launches) {
      const y = heights[launch];
      // A drop does not use the launcher: count it once, under the level's own height.
      const cands = candidates(def, { every, powers, substeps: engineSubsteps(spec), y }).filter((k) => def.rack.includes(k.shot.ammo) && (launch === 'level' || k.shot.ammo !== 'drop'));
      const t0 = Date.now();
      const results = await Promise.all(cands.map((k) => runner.play(def, [k.shot])));
      const clears = cands.flatMap((k, i) => {
        const r = results[i]!;
        if (r.session.phase !== 'cleared') return [];
        const broken = r.session.heritageBroken.reduce((a, x) => a + x, 0), L = r.session.score!.leverage;
        return [{ label: k.label, broken, L, old: oldParStars(true, 1, def.par, broken, L, gold), now: r.session.score!.stars, gold: r.session.score!.gold ?? false }];
      });
      const Ls = clears.filter((x) => !x.broken).map((x) => x.L);
      const line = `${def.id} par ${def.par}, launch ${launch} (y ${y / 4} h): ${clears.length}/${cands.length} clear in one shot, ${clears.filter((x) => x.broken).length} breaking heritage;`
        + ` clean leverage P25/P50/P75 ${[0.25, 0.5, 0.75].map((q) => (Ls.length ? quantile(Ls, q).toFixed(2) : '-')).join('/')} vs lGold ${gold};`
        + ` stars 0/1/2/3 old ${hist(clears.map((x) => x.old))}, new ${hist(clears.map((x) => x.now))}; gold badge ${clears.filter((x) => x.gold).length}; ${((Date.now() - t0) / 1000).toFixed(0)} s`;
      console.log(line);
      rows.push({ level: def.id, par: def.par, lGold: gold, launch, y, candidates: cands.length, clears });
    }
  }
} finally {
  await runner.close();
}
const out = flags.get('json');
if (out) writeFileSync(out, JSON.stringify({ engine: engineLabel(spec), every, powers, rows }, null, 1));

// pnpm keystone:goals <level> --explore N [--seed S] [--items a,b] [--engine ref] [--jobs N]
// pnpm keystone:goals [<level> ...] [--sheet file.json] [--nudges 8] [--engine ref] [--jobs N]
//
// Lot sheets in the lab (docs/game/lot-sheets.md). --explore plays N competent lines and prints one
// JSON line of facts per play (the raw material a goal is written from). Otherwise it proves each
// level's sheet (the committed one, or --sheet): replays each goal's proof line and --nudges nudged
// copies of it, and says whether the goal meets the roadmap's margin (6 of 8 nudges).
import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { checkLotSheet, compileLevel, levelById, LOT_SHEETS, type LotSheet, type RackItem } from '@tb/keystone';
import { engineLabel, labArgs } from './engines.ts';
import { exploreGoals, marginOk, proveSheet } from './goal-lab.ts';
import { makeRunner } from './runner.ts';

const { spec, jobs, flags, ids } = labArgs(process.argv.slice(2), availableParallelism());
const whole = (name: string, fallback: number): number => {
  const v = flags.get(name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`--${name} needs a whole number, got ${v}`);
  return n;
};
const runner = makeRunner(spec, jobs);
console.error(`engine ${engineLabel(spec)}, ${runner.jobs} job(s)`);
try {
  if (flags.has('explore')) {
    if (ids.length !== 1) throw new Error('--explore takes one level');
    const id = ids[0]!, n = whole('explore', 8), seed = whole('seed', 1), itemsText = flags.get('items');
    const items = itemsText ? (itemsText.split(',') as RackItem[]) : undefined, t0 = Date.now();
    const out = await exploreGoals(levelById(id), {}, runner, n, seed, items);
    console.error(`${id} ${itemsText ?? 'rack'} seed ${seed}: ${n} plays in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    for (const e of out) console.log(JSON.stringify({ level: id, items: itemsText ?? 'rack', seed, ...e.facts.round, line: e.shots, used: e.facts.used, per: e.facts.shots.map((o) => [o.crownsDown, +o.leverage.toFixed(2), o.heritageNew, o.displaced]) }));
  } else {
    const file = flags.get('sheet');
    const sheets: LotSheet[] = file ? [JSON.parse(readFileSync(file, 'utf8')) as LotSheet] : Object.values(LOT_SHEETS).filter((s) => !ids.length || ids.includes(s.level));
    const nudges = whole('nudges', 8);
    let bad = 0;
    for (const sheet of sheets) {
      const level = levelById(sheet.level), t0 = Date.now();
      checkLotSheet(compileLevel(level), sheet);
      const proofs = await proveSheet(level, sheet, runner, nudges);
      console.log(`${sheet.level} (${sheet.engine} sheet), ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      for (const p of proofs) {
        const ok = !p.proven || marginOk(p);
        if (!ok) bad++;
        console.log(`  ${p.id.padEnd(24)} ${p.proven ? `${p.met ? 'meets' : 'MISSES'}, nudges ${p.nudgedMet}/${p.nudged}${ok ? '' : '  BELOW MARGIN'}` : 'unproven'}`);
      }
    }
    if (bad) process.exitCode = 1;
  }
} finally {
  await runner.close();
}

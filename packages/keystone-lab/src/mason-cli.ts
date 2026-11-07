// pnpm mason:judge [MT1 ...] [--worlds K] [--knife] [--wrong] [--solo] [--match text]
// Runs Mason's Trial's recorded builds through the robustness judge on the f64
// reference (keystone mason-judge.ts) and prints each one's passes, cost and
// points, and the star points its tier authors give (mason-solutions.ts). With
// --solo it also plays every world alone and prints the comparison the judge's
// verify makes (islands against solo runs: Fisher's exact test on the passes).
import { compileLevel, judgeMason, MASON_WORLDS, soloMason } from '@tb/keystone';
import { AvbdReferenceEngine } from '@tb/physics-ref';
import { MASON_KNIFE, MASON_LEVEL_DEFS, MASON_SOLUTIONS, MASON_WRONG, type MasonBuild, masonBuild, masonPointsOf, masonStarsFrom } from './mason-solutions.ts';
import { fisherExact } from './mason-stats.ts';
import { AVBD_GAP_SLOP, AVBD_ITERATIONS } from '@tb/keystone';

const args = process.argv.slice(2), flags = new Set(args.filter((a) => a.startsWith('--')));
const kAt = args.indexOf('--worlds'), K = kAt >= 0 ? Number(args[kAt + 1]) : MASON_WORLDS;
const mAt = args.indexOf('--match'), match = mAt >= 0 ? args[mAt + 1]! : '';
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--worlds' && args[i - 1] !== '--match');
const ref = () => new AvbdReferenceEngine({ iterations: AVBD_ITERATIONS, gapSlop: AVBD_GAP_SLOP });
const worlds = Array.from({ length: K }, (_, k) => k);

for (const def of MASON_LEVEL_DEFS.filter((d) => !ids.length || ids.includes(d.id))) {
  const list: MasonBuild[] = [...MASON_SOLUTIONS[def.id]!, ...(flags.has('--knife') ? [MASON_KNIFE[def.id]!] : []), ...(flags.has('--wrong') ? MASON_WRONG[def.id]! : [])];
  let fromRecords: string;
  try { fromRecords = JSON.stringify(masonStarsFrom(def, MASON_SOLUTIONS[def.id]!)); } catch (e) { fromRecords = `none yet (${(e as Error).message})`; } // a level being tuned has no records
  console.log(`${def.id} ${def.name}: stars ${JSON.stringify(def.mason!.stars)}, from the authors' records ${fromRecords}`);
  for (const b of list.filter((x) => x.label.includes(match))) {
    const built = masonBuild(def, b.steps);
    if ('refused' in built) { console.log(`  ${b.label}: REFUSED ${built.refused}`); continue; }
    const c = compileLevel(built.def), t0 = performance.now();
    const v = await judgeMason(ref(), c, worlds);
    const line = `  ${b.tier ? `T${b.tier} ` : ''}${b.label}: ${v.passes}/${K}, spent ${built.spent}, points ${masonPointsOf(def, v.passes, built.spent, K)}, leaks ${v.leaks}, ${((performance.now() - t0) / 1000).toFixed(0)} s${b.measured ? ` (recorded ${b.measured.passes}/64, spent ${b.measured.spent})` : ''}`;
    console.log(line);
    if (flags.has('--solo')) {
      const t1 = performance.now();
      let solo = 0, agree = 0;
      for (const k of worlds) { const p = await soloMason(ref(), c, k); solo += p ? 1 : 0; agree += p === v.pass[k] ? 1 : 0; }
      console.log(`    solo ${solo}/${K}, same verdict in ${agree} of ${K} worlds, Fisher p ${fisherExact(v.passes, K - v.passes, solo, K - solo).toFixed(3)}, ${((performance.now() - t1) / 1000).toFixed(0)} s`);
    }
  }
}

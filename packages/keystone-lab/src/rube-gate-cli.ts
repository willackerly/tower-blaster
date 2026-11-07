// pnpm rube:gate [RL1 RL2 RL3]: runs the Rube Lab gate search (rube-gate.ts) on the reference and prints
// each puzzle's robust clears by family, its cheapest clear and its wrong builds. --json FILE writes the rows.
import { writeFileSync } from 'node:fs';
import { gatePuzzles, NUDGES, ROBUST, runPuzzle } from './rube-gate.ts';

const args = process.argv.slice(2), ji = args.indexOf('--json'), json = ji >= 0 ? args.splice(ji, 2)[1] : undefined;
const want = new Set(args);
const out: Record<string, unknown> = {};
for (const p of gatePuzzles()) {
  if (want.size && !want.has(p.def.id)) continue;
  const t0 = performance.now();
  console.log(`${p.def.id} ${p.def.name}: ${p.cands.length} candidates`);
  const r = await runPuzzle(p, console.log);
  const robust = r.rows.filter((x) => x.robust >= ROBUST), fam = new Map<string, number>();
  for (const x of robust) fam.set(x.family, Math.min(fam.get(x.family) ?? Infinity, x.spent));
  console.log(`${p.def.id}: ${r.played} builds played (${r.refused} refused by the build tool), ${r.rows.length} clear, ${robust.length} robust (>= ${ROBUST}/${NUDGES})`);
  console.log(`  families (cheapest): ${[...fam].map(([f, c]) => `${f} ${c}`).join('; ') || 'none'}`);
  for (const w of r.wrong) console.log(`  wrong build "${w.label}": ${w.refused ? "REFUSED by the build tool (proves nothing)" : w.cleared ? "CLEARS (bad)" : "fails"}`);
  console.log(`  ${((performance.now() - t0) / 1000).toFixed(0)} s`);
  out[p.def.id] = { ...r, families: Object.fromEntries(fam) };
}
if (json) writeFileSync(json, JSON.stringify(out, null, 1));

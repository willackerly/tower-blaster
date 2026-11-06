// pnpm keystone:cast <level> [--engine gpu|ref|rapier] [--channel chrome] [--headed]
//   [--seed N] [--metric collapse|crowns|skyline|score] [--recipe short|full|C,L,M,K,N]
//   [--out cast.json] [--md cast.md] [--compare other.json] [--max-steps N] [--explore N]
//   [--cloud-of cast.json [--n 16]] [--budget-min 60] [--pool a.json,b.json]
//   [--stars-into packages/keystone/src/stars.json] [--replay cast.json [--phase cloud] [--n 16]]
//   [--extend cast.json [--n 50]] [--pool a.json,b.json [--t3 pooled|best]]
// <level>: a built-in level id, or --level-file path.json (a LevelDef), or
// --scenario S3 --param W=50 ... (the automatic scenario level), or --draft B1a
// (keystone-lab drafts.ts). --explore N plays N competent lines only and
// reports collapse, crowns and heritage after each shot (exploreLevel), for
// designing a level before casting it. --cloud-of cast.json plays --n (default
// 16) nudges of that cast's best line here and runs the cross-device gate on
// them (cloudCheck): the spec's SwiftShader check of a Metal cast at small N,
// advisory since 2026-11-01 (exit 2 only for incomplete plays, 4 for limits).
// Casts an outcome level's stars (roadmap G5.1, spectacle-mode.md section 6):
// the GPU engine through the game's cast page by default (SwiftShader here,
// Metal with --channel chrome on a Mac); ref and rapier play in this thread.
// Prints the thresholds and gates, writes the whole cast as JSON (--out) and
// its summary as markdown (--md). --compare runs the recast and cross-device
// gates against an earlier cast's JSON. --pool a.json,b.json plays nothing: it
// pools casts of the level (a cast and its recasts) into one set of stars
// (poolCasts) and prints them as the LevelDef's stars. --budget-min raises the budget gate's
// 60 min for a level whose cast cannot fit it (10k levels: about 3 h), and the
// gate's note records the raise. --stars-into stars.json sets the level's stars
// in the game's stars file (one line per level, the rest kept) once every gate
// passed, or from --pool: the drop-in that makes new stars show in the game. Exits 2 when a gate fails, 4 when a
// play hit an engine limit (as bench:browser does). --replay cast.json plays the first --n (16)
// recorded lines of --phase (cloud) exactly again here and reports which end bit for bit as
// recorded (same adapter: all should; exit 2 when any differs there). --extend cast.json plays
// --n (50) more nudges of that cast's best line on the same device and judges its stars again
// (extendCloud: the stable gate's fix). --t3 best pools T3 from the best line of the casts
// instead of every cloud together (poolCasts).
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { compileLevel, type LevelDef, levelById, scenarioLevel, STAR_METRICS, type StarMetric, type StarsDef } from '@tb/keystone';
import { exitNow } from '@tb/testkit';
import { CAST_BUDGET_MS, castLevel, castMarkdown, cloudCheck, exploreLevel, extendCloud, type PoolT3, replayCast, explorationMarkdown, type CastPlayer, type CastRecipe, type CastResult, compareCasts, FULL_RECIPE, mergeStarsFile, nodeCastPlayer, playsOf, poolCasts, SHORT_RECIPE, withWallTime } from './cast.ts';
import { openBrowserCastPlayer } from './cast-browser.ts';
import { draftByName } from './drafts.ts';

const argv = process.argv.slice(2), flags = new Map<string, string>(), params: Record<string, number | boolean> = {}, ids: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith('--')) { ids.push(a); continue; }
  const key = a.slice(2), next = argv[i + 1];
  const value = next !== undefined && !next.startsWith('--') ? (i++, next) : 'true';
  if (key === 'param') { const [k, v] = value.split('='); params[k!] = v === 'true' ? true : v === 'false' ? false : Number(v); }
  else flags.set(key, value);
}

function level(): LevelDef {
  if (flags.has('level-file')) return JSON.parse(readFileSync(flags.get('level-file')!, 'utf8')) as LevelDef;
  if (flags.has('draft')) return draftByName(flags.get('draft')!);
  if (flags.has('scenario')) return scenarioLevel(flags.get('scenario')!, params, Number(flags.get('seed-scene') ?? 1));
  if (ids.length !== 1) throw new Error('name one level: an id, --level-file path.json, or --scenario S3 --param k=v');
  return levelById(ids[0]!);
}

function recipe(): CastRecipe {
  const r = flags.get('recipe') ?? 'short';
  if (r === 'short') return SHORT_RECIPE;
  if (r === 'full') return FULL_RECIPE;
  const n = r.split(',').map(Number);
  if ((n.length !== 5 && n.length !== 7) || !n.every((x) => Number.isInteger(x) && x >= 0) || n[0]! < 1 || n[4]! < 1) throw new Error(`--recipe is short, full, or competent,climbLines,climbMoves,climbNudges,cloud[,confirmLines,confirmNudges] (whole numbers): ${r}`);
  return { competent: n[0]!, climbLines: n[1]!, climbMoves: n[2]!, climbNudges: n[3]!, cloud: n[4]!, confirmLines: n[5] ?? 0, confirmNudges: n[6] ?? 0 };
}

const def = level(), rec = recipe(), engine = flags.get('engine') ?? 'gpu';
const metric = flags.get('metric') as StarMetric | undefined;
if (metric !== undefined && !(STAR_METRICS as readonly string[]).includes(metric)) throw new Error(`--metric is one of ${STAR_METRICS.join(', ')}`);
const budgetMin = Number(flags.get('budget-min') ?? CAST_BUDGET_MS / 60_000);
if (!(budgetMin > 0)) throw new Error(`--budget-min needs a positive number of minutes: ${flags.get('budget-min')}`);
const budgetMs = budgetMin * 60_000;
if (flags.has('pool')) {
  const casts = flags.get('pool')!.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')) as CastResult);
  const t3From = (flags.get('t3') ?? 'pooled') as PoolT3;
  if (t3From !== 'pooled' && t3From !== 'best') throw new Error(`--t3 is pooled or best: ${t3From}`);
  const p = poolCasts(casts, t3From), hash = compileLevel(def).hash;
  if (p.stars.hash !== hash) throw new Error(`pool: the casts are of ${def.id} hash ${p.stars.hash}, but it hashes ${hash} now: recast`);
  const f3 = (x: number) => x.toFixed(3), row = (name: string, x: typeof p.cloud) => `| ${name} | ${x.n} | ${[x.min, x.p10, x.p25, x.p50, x.p75, x.p90, x.max].map(f3).join(' | ')} |`;
  const md = [
    `### ${def.id} stars pooled from seeds ${p.seeds.join(', ')} on ${p.stars.castOn} (${p.stars.engine}), ${p.stars.n} plays`,
    '',
    `T2 ${f3(p.stars.t2)} (median of every competent end, raw ${f3(p.raw.t2)}), T3 ${f3(p.stars.t3)} (lower quartile of ${p.t3From === 'best' ? `seed ${p.t3Seed}'s nudge cloud, the best line of the casts` : 'every nudge cloud'}, raw ${f3(p.raw.t3)}), beat the bot above ${f3(p.raw.best)}. Per seed: ${casts.map((r) => `seed ${r.seed} T2 ${f3(r.raw.t2)} T3 ${f3(r.raw.t3)}`).join('; ')}.`,
    '',
    '| Cloud | n | min | P10 | P25 | P50 | P75 | P90 | max |',
    '|---|---|---|---|---|---|---|---|---|',
    row('competent ends', p.competent),
    row('nudge cloud ends', p.cloud),
    '',
    '| Gate | Result | Value | Need | What |',
    '|---|---|---|---|---|',
    ...Object.entries(p.gates).map(([k, g]) => `| ${k} | ${g.pass ? 'pass' : '**fail**'} | ${f3(g.value)} | ${f3(g.need)} | ${g.note} |`),
  ].join('\n');
  console.log(md);
  console.log(`stars: ${JSON.stringify(p.stars)}`);
  if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(p, null, 1));
  if (flags.has('md')) writeFileSync(flags.get('md')!, md);
  const passed = Object.values(p.gates).every((g) => g.pass);
  if (passed) intoStarsFile(def.id, p.stars);
  else if (flags.has('stars-into')) console.log('--stars-into: not written, a pooled gate failed');
  process.exit(passed ? 0 : 2);
}
/** --stars-into path.json: set this level's stars in a stars file (@tb/keystone stars.json), keeping the rest. */
function intoStarsFile(id: string, stars: StarsDef): void {
  const file = flags.get('stars-into');
  if (!file) return;
  writeFileSync(file, mergeStarsFile(existsSync(file) ? readFileSync(file, 'utf8') : null, id, stars));
  console.log(`stars for ${id} written to ${file}`);
}
const maxSteps = flags.has('max-steps') ? Number(flags.get('max-steps')) : undefined;
let player: CastPlayer, close = async (): Promise<string[]> => [];
// Pages lost mid-batch and reopened (cast-browser.ts): listed after the cast so a recovered cast says so.
let reopens: readonly string[] = [];
const reopenNote = () => reopens.length ? `\n\nThe cast page was lost and reopened ${reopens.length} time(s); each batch it lost was replayed whole on the new page:\n${reopens.map((r) => `- ${r}`).join('\n')}\n` : '';
if (engine === 'gpu' || engine === 'gpu-rapier') {
  const p = await openBrowserCastPlayer({ engine: engine === 'gpu' ? 'gpu' : 'rapier', ...(flags.has('channel') ? { channel: flags.get('channel')! } : {}), headed: flags.has('headed'), ...(maxSteps !== undefined ? { maxSteps } : {}) });
  player = p; close = p.close; reopens = p.reopens;
  if (p.software) console.log(`note: ${p.adapter} is a software adapter: the cast is valid, its timings are not performance results`);
} else if (engine === 'ref' || engine === 'rapier') player = nodeCastPlayer({ kind: engine });
else throw new Error(`--engine is gpu, gpu-rapier (Rapier in the page), ref or rapier: ${engine}`);

if (flags.has('explore')) {
  const n = Number(flags.get('explore'));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--explore needs a whole number of plays: ${flags.get('explore')}`);
  console.log(`explore ${def.id} on ${player.adapter} (${player.engine}): ${n} competent plays`);
  let stuck: string[] = [];
  try {
    const t0 = performance.now(), e = await exploreLevel(def, player, n, Number(flags.get('seed') ?? 1));
    const ms = performance.now() - t0, playMs = 'playMs' in player ? (player.playMs as number[]) : [];
    const stepMs = playMs.length ? playMs.reduce((a, x) => a + x, 0) / e.lines.reduce((a, l) => a + l.steps, 0) : NaN;
    const md = explorationMarkdown(e, `; ${(ms / 60_000).toFixed(1)} min, ${stepMs.toFixed(2)} ms per step in the page (pre-settle included${'software' in player && player.software ? '; software adapter, not a performance result' : ''})`);
    console.log(md);
    if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify({ ...e, ms, stepMs, def }, null, 1));
    if (flags.has('md')) writeFileSync(flags.get('md')!, md);
    process.exitCode = e.limited ? 4 : 0;
  } finally {
    stuck = await close();
  }
  if (stuck.length) await exitNow();
  process.exit();
}
if (flags.has('extend')) {
  const cast = JSON.parse(readFileSync(flags.get('extend')!, 'utf8')) as CastResult, n = Number(flags.get('n') ?? 50);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n needs a whole number of plays: ${flags.get('n')}`);
  console.log(`extend ${def.id} on ${player.adapter} (${player.engine}): ${n} more nudges of seed ${cast.seed}'s best line ${cast.bestLine.shots}`);
  let stuck: string[] = [];
  try {
    const t0 = performance.now(), r = await extendCloud(def, player, cast, n);
    const md = castMarkdown({ ...r, wallMs: cast.wallMs }) + `\n\nCloud extended by ${n} nudges in ${((performance.now() - t0) / 60_000).toFixed(1)} min (budget gate as the cast had it).\n` + reopenNote();
    console.log(md);
    console.log(`stars: ${JSON.stringify(r.stars)}`);
    if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(reopens.length ? { ...r, reopens } : r, null, 1));
    if (flags.has('md')) writeFileSync(flags.get('md')!, md);
    const failed = Object.values(r.gates).some((g) => g && !g.pass), limited = !r.gates.limits.pass;
    if (!failed) intoStarsFile(def.id, r.stars);
    process.exitCode = limited ? 4 : failed ? 2 : 0;
  } finally {
    stuck = await close();
  }
  if (stuck.length) await exitNow();
  process.exit();
}
if (flags.has('replay')) {
  const cast = JSON.parse(readFileSync(flags.get('replay')!, 'utf8')) as CastResult, n = Number(flags.get('n') ?? 16);
  const phase = (flags.get('phase') ?? 'cloud') as 'competent' | 'climb' | 'cloud';
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n needs a whole number of plays: ${flags.get('n')}`);
  if (!['competent', 'climb', 'cloud'].includes(phase)) throw new Error(`--phase is competent, climb or cloud: ${phase}`);
  console.log(`replay ${def.id} on ${player.adapter} (${player.engine}): the first ${n} ${phase} plays of seed ${cast.seed}'s cast on ${cast.adapter} (${cast.engine}), exactly`);
  let stuck: string[] = [];
  try {
    const t0 = performance.now(), k = await replayCast(def, player, cast, phase, n);
    const sameDevice = k.adapter === cast.adapter && k.engine === cast.engine;
    for (const r of k.rows) console.log(`  ${r.was.hash === r.now.hash && r.was.steps === r.now.steps ? 'same  ' : 'DIFFER'} ${r.shots}: ${r.was.value} (${r.was.steps} steps) -> ${r.now.value} (${r.now.steps} steps)`);
    console.log(`${k.same} of ${k.rows.length} plays ended bit for bit as recorded; ${((performance.now() - t0) / 60_000).toFixed(1)} min${sameDevice ? '' : ' (another adapter or engine: differences are expected)'}`);
    if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(k, null, 1));
    process.exitCode = sameDevice && k.same < k.rows.length ? 2 : 0;
  } finally {
    stuck = await close();
  }
  if (stuck.length) await exitNow();
  process.exit();
}
if (flags.has('cloud-of')) {
  const cast = JSON.parse(readFileSync(flags.get('cloud-of')!, 'utf8')) as CastResult, n = Number(flags.get('n') ?? 16);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--n needs a whole number of plays: ${flags.get('n')}`);
  console.log(`cloud check ${def.id} on ${player.adapter} (${player.engine}): ${n} nudges of ${cast.adapter}'s best line ${cast.bestLine.shots}`);
  let stuck: string[] = [];
  try {
    const t0 = performance.now(), k = await cloudCheck(def, player, cast, n, Number(flags.get('seed') ?? 1));
    const g = (name: string, x: { pass: boolean; value: number; note: string }) => `${name}: ${x.pass ? 'pass' : 'FAIL'} (${x.value.toFixed(4)}; ${x.note})`;
    console.log([`T3 here ${k.t3.toFixed(4)} vs ${cast.adapter} ${cast.raw.t3.toFixed(4)}; ${((performance.now() - t0) / 60_000).toFixed(1)} min`, g('cross-device (advisory)', k.crossDevice), g('no limit hit', k.limits), g('complete', k.complete)].join('\n'));
    if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(k, null, 1));
    // Cross-device is advisory (Will, 2026-11-01): it is reported, never a failed gate.
    process.exitCode = !k.limits.pass ? 4 : !k.complete.pass ? 2 : 0;
  } finally {
    stuck = await close();
  }
  if (stuck.length) await exitNow();
  process.exit();
}
console.log(`cast ${def.id} on ${player.adapter} (${player.engine}): ${playsOf(rec)} plays, seed ${flags.get('seed') ?? 1}`);
let stuck: string[] = [];
let failed = false, limited = false;
try {
  const t0 = performance.now();
  let last = t0;
  const r0 = await castLevel(def, player, {
    seed: Number(flags.get('seed') ?? 1), recipe: rec, ...(metric ? { metric } : {}),
    progress: (done, total, phase) => {
      const now = performance.now();
      console.log(`  ${done}/${total} plays (${phase}), ${((now - last) / 1000).toFixed(0)} s since last, ${((now - t0) / 60_000).toFixed(1)} min in`);
      last = now;
    },
  });
  const r = withWallTime(r0, performance.now() - t0, budgetMs);
  console.log(castMarkdown(r) + reopenNote());
  console.log(`stars: ${JSON.stringify(r.stars)}`);
  if (flags.has('compare')) {
    const other = JSON.parse(readFileSync(flags.get('compare')!, 'utf8')) as CastResult;
    const cmp = compareCasts(other, r);
    console.log(`recast vs ${flags.get('compare')}: ${cmp.recast.pass ? 'pass' : 'FAIL'} (${cmp.recast.note} = ${cmp.recast.value.toFixed(4)}, need < ${cmp.recast.need.toFixed(4)})`);
    console.log(`cross-device (advisory): ${cmp.crossDevice.pass ? 'pass' : 'harder here'} (${cmp.crossDevice.note})`);
    failed ||= !cmp.recast.pass;
  }
  if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(reopens.length ? { ...r, reopens } : r, null, 1));
  if (flags.has('md')) writeFileSync(flags.get('md')!, castMarkdown(r) + reopenNote());
  failed ||= Object.values(r.gates).some((g) => g && !g.pass);
  // Only a cast that passed every gate lands in the stars file the game reads.
  if (!failed) intoStarsFile(def.id, r.stars);
  else if (flags.has('stars-into')) console.log(`--stars-into: not written, a gate failed`);
  limited = !r.gates.limits.pass;
} finally {
  stuck = await close();
}
process.exitCode = limited ? 4 : failed ? 2 : 0;
if (stuck.length) await exitNow();

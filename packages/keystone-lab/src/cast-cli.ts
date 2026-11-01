// pnpm keystone:cast <level> [--engine gpu|ref|rapier] [--channel chrome] [--headed]
//   [--seed N] [--metric collapse|crowns|skyline|score] [--recipe short|full|C,L,M,K,N]
//   [--out cast.json] [--md cast.md] [--compare other.json] [--max-steps N] [--explore N]
// <level>: a built-in level id, or --level-file path.json (a LevelDef), or
// --scenario S3 --param W=50 ... (the automatic scenario level), or --draft B1a
// (keystone-lab drafts.ts). --explore N plays N competent lines only and
// reports collapse, crowns and heritage after each shot (exploreLevel), for
// designing a level before casting it.
// Casts an outcome level's stars (roadmap G5.1, spectacle-mode.md section 6):
// the GPU engine through the game's cast page by default (SwiftShader here,
// Metal with --channel chrome on a Mac); ref and rapier play in this thread.
// Prints the thresholds and gates, writes the whole cast as JSON (--out) and
// its summary as markdown (--md). --compare runs the recast and cross-device
// gates against an earlier cast's JSON. Exits 2 when a gate fails, 4 when a
// play hit an engine limit (as bench:browser does).
import { readFileSync, writeFileSync } from 'node:fs';
import { type LevelDef, levelById, scenarioLevel, STAR_METRICS, type StarMetric } from '@tb/keystone';
import { exitNow } from '@tb/testkit';
import { castLevel, castMarkdown, exploreLevel, explorationMarkdown, type CastPlayer, type CastRecipe, type CastResult, compareCasts, FULL_RECIPE, nodeCastPlayer, playsOf, SHORT_RECIPE, withWallTime } from './cast.ts';
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
  if (n.length !== 5 || !n.every((x) => Number.isInteger(x) && x >= 0) || n[0]! < 1 || n[4]! < 1) throw new Error(`--recipe is short, full, or competent,climbLines,climbMoves,climbNudges,cloud (whole numbers): ${r}`);
  return { competent: n[0]!, climbLines: n[1]!, climbMoves: n[2]!, climbNudges: n[3]!, cloud: n[4]! };
}

const def = level(), rec = recipe(), engine = flags.get('engine') ?? 'gpu';
const metric = flags.get('metric') as StarMetric | undefined;
if (metric !== undefined && !(STAR_METRICS as readonly string[]).includes(metric)) throw new Error(`--metric is one of ${STAR_METRICS.join(', ')}`);
const maxSteps = flags.has('max-steps') ? Number(flags.get('max-steps')) : undefined;
let player: CastPlayer, close = async (): Promise<string[]> => [];
if (engine === 'gpu' || engine === 'gpu-rapier') {
  const p = await openBrowserCastPlayer({ engine: engine === 'gpu' ? 'gpu' : 'rapier', ...(flags.has('channel') ? { channel: flags.get('channel')! } : {}), headed: flags.has('headed'), ...(maxSteps !== undefined ? { maxSteps } : {}) });
  player = p; close = p.close;
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
  const r = withWallTime(r0, performance.now() - t0);
  console.log(castMarkdown(r));
  console.log(`stars: ${JSON.stringify(r.stars)}`);
  if (flags.has('compare')) {
    const other = JSON.parse(readFileSync(flags.get('compare')!, 'utf8')) as CastResult;
    const cmp = compareCasts(other, r);
    console.log(`recast vs ${flags.get('compare')}: ${cmp.recast.pass ? 'pass' : 'FAIL'} (${cmp.recast.note} = ${cmp.recast.value.toFixed(4)}, need < ${cmp.recast.need.toFixed(4)})`);
    console.log(`cross-device: ${cmp.crossDevice.pass ? 'pass' : 'FAIL'} (${cmp.crossDevice.note})`);
    failed ||= !cmp.recast.pass || !cmp.crossDevice.pass;
  }
  if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify(r, null, 1));
  if (flags.has('md')) writeFileSync(flags.get('md')!, castMarkdown(r));
  failed ||= Object.values(r.gates).some((g) => g && !g.pass);
  limited = !r.gates.limits.pass;
} finally {
  stuck = await close();
}
process.exitCode = limited ? 4 : failed ? 2 : 0;
if (stuck.length) await exitNow();

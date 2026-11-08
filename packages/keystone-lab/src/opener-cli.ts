// pnpm keystone:opener <level> --from cast.json[,cast2.json] [--k 16] [--n 8] [--seed 1]
//   [--engine gpu[,rapier]] [--channel chrome] [--floor 0.45] [--no-current] [--out opener.json] [--md opener.md]
// Chooses a level's pre-aimed opener (the agent playtest's PT13, keystone-lab opener.ts): the k first shots of
// the casts' lines with the highest first-settle value, each played alone exactly and as n nudges on every
// engine named (gpu, the default: the game's cast page, SwiftShader here and Metal with --channel chrome on a
// Mac; rapier and ref: in this thread), ranked on their worst engine's lower quartile. The players' engine
// decides: Rapier parts from the GPU solver on B1 (PT12; Metal 0.725 at the first settle where Rapier brings
// 0.027 down), so name it only to see by how much. Prints the table and the pick; exits 2
// when no candidate wins on every engine (PT13's fallback: route a first visit through L1).
import { readFileSync, writeFileSync } from 'node:fs';
import { levelById, writeShots } from '@tb/keystone';
import { exitNow } from '@tb/testkit';
import { type CastPlayer, nodeCastPlayer } from './cast.ts';
import { type BrowserCastPlayer, openBrowserCastPlayer } from './cast-browser.ts';
import { judgeOpeners, openerCandidates, openerMarkdown } from './opener.ts';

const argv = process.argv.slice(2), flags = new Map<string, string>(), ids: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]!;
  if (!a.startsWith('--')) { ids.push(a); continue; }
  const next = argv[i + 1];
  flags.set(a.slice(2), next !== undefined && !next.startsWith('--') ? (i++, next) : 'true');
}
if (ids.length !== 1 || !flags.has('from')) throw new Error('usage: pnpm keystone:opener <level> --from cast.json[,more.json] [--k 16] [--n 8] [--engine gpu,rapier] [--channel chrome] [--floor 0.45] [--no-current]');
const level = levelById(ids[0]!);
const casts = flags.get('from')!.split(',').map((f) => JSON.parse(readFileSync(f, 'utf8')));
for (const c of casts) if (c.level !== level.id) throw new Error(`${c.level}'s cast given for ${level.id}`);
const k = Number(flags.get('k') ?? 16), n = Number(flags.get('n') ?? 8), seed = Number(flags.get('seed') ?? 1);
/** The score a winner must reach (judgeOpeners' floor); the objective's minimum when absent. */
const floor = flags.has('floor') ? Number(flags.get('floor')) : undefined;
const candidates = openerCandidates(casts, k);
// The level's current opener joins the candidates (--no-current leaves it out, when it is already measured).
const current = flags.has('no-current') ? undefined : level.solutions?.opener ?? level.solutions?.ace?.[0];
if (current) {
  const text = writeShots([current]);
  if (!candidates.some((c) => c.shot === text)) candidates.push({ shot: text, recorded: NaN });
}

const browsers: BrowserCastPlayer[] = [], players: CastPlayer[] = [];
for (const e of (flags.get('engine') ?? 'gpu').split(',')) {
  if (e === 'gpu') {
    const p = await openBrowserCastPlayer({ engine: 'gpu', ...(flags.has('channel') ? { channel: flags.get('channel')! } : {}) });
    browsers.push(p);
    players.push(p);
  } else if (e === 'rapier' || e === 'ref') players.push(nodeCastPlayer({ kind: e }));
  else throw new Error(`--engine takes gpu, rapier and ref: ${e}`);
}
console.log(`${level.id}: ${candidates.length} candidates x ${n + 1} plays on ${players.map((p) => `${p.engine} (${p.adapter})`).join(', ')}`);
const t0 = performance.now();
const judged = await judgeOpeners(level, candidates, players, n, seed, 'collapse', floor);
for (const b of browsers) await b.close();
const md = openerMarkdown(level, judged, n, floor) + `\nWall time ${((performance.now() - t0) / 60_000).toFixed(1)} min.\n`;
console.log(md);
if (flags.has('out')) writeFileSync(flags.get('out')!, JSON.stringify({ level: level.id, n, seed, k, floor: floor ?? null, judged }, null, 1));
if (flags.has('md')) writeFileSync(flags.get('md')!, md);
exitNow(judged[0]?.wins ? 0 : 2);

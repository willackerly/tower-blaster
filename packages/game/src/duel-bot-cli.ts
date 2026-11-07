// The Siege Table's balance numbers (docs/game/siege-table.md, "Balance"): novice duels (duel-bot.ts), first player
// alternating. `pnpm duel:bot D1,D2 [duels=40] [aspect=1.6] [seed=5000] [--engine rapier|gpu]`; 0.462 is an upright
// phone. Rapier runs in node; gpu plays each duel on the cast page (cast-page.ts duel) in headless Chromium, as the
// game builds the table's engine: SwiftShader here, Metal with TB_CHANNEL=chrome on a Mac (agent playtest round 2,
// PT5's verify: each seat and side wins 40 to 60% of the decided duels).
import { RapierEngine } from '@tb/adapter-rapier';
import { DUELS, type Player } from '@tb/keystone';
import { type DuelOutcome, duelOutcome, noviceDuel, tallyDuels, tallyLine } from './duel-bot.ts';

const argv = process.argv.slice(2), at = argv.indexOf('--engine');
const engine = at >= 0 ? argv.splice(at, 2)[1]! : 'rapier';
if (engine !== 'rapier' && engine !== 'gpu') throw new Error(`--engine must be rapier or gpu, not ${engine}`);
const [ids = 'D1,D2', n = '40', aspect = '1.6', base = '5000'] = argv;
const gpu = engine === 'gpu' ? await (await import('../../keystone-lab/src/cast-browser.ts')).openBrowserCastPlayer({ engine: 'gpu', ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) }) : null;
try {
  for (const def of DUELS.filter((d) => ids.split(',').includes(d.id))) {
    const rs: DuelOutcome[] = [];
    for (let s = 0; s < Number(n); s++) {
      const first = (s % 2) as Player, seed = Number(base) + s;
      const r = gpu ? await gpu.duel(def.id, first, seed, Number(aspect)) : duelOutcome(await noviceDuel(new RapierEngine(), def, first, seed, Number(aspect)));
      rs.push(r);
      if (gpu) console.error(`${def.id} seed ${seed}: first ${first ? 'Blue' : 'Gold'}, winner ${r.winner === null ? 'none' : r.winner ? 'Blue' : 'Gold'} (${r.why}), ${r.turns} turns`);
    }
    console.log(tallyLine(def.id, gpu ? `gpu (${gpu.software ? 'software adapter' : 'hardware'})` : 'rapier', Number(aspect), tallyDuels(rs)));
  }
} finally { await gpu?.close(); }

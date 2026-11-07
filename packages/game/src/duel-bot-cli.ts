// The Siege Table's balance numbers (docs/game/siege-table.md, "Balance"): novice duels (duel-bot.ts), first player
// alternating. `pnpm duel:bot D1,D2 [duels=40] [aspect=1.6] [seed=5000] [--engine rapier|gpu] [--swap] [--probe]`;
// 0.462 is an upright phone. Rapier runs in node; gpu plays each duel on the cast page (cast-page.ts duel) in headless
// Chromium, as the game builds the table's engine: SwiftShader here, Metal with TB_CHANNEL=chrome on a Mac (agent
// playtest round 2, PT5's verify: each seat and side wins 40 to 60% of the decided duels).
//   --swap   the sides' parts traded places in the part list (duel-bot.ts swappedOrder): same table, other solve order.
//   --probe  PT22's paired probe instead of duels: for each seed, Gold's first shot and Blue's, each on a fresh table
//            and aimed from the same click (the first of the seed's clicks that lands on a rival block) (the views are half-turn images: duel-mirror.test.ts), so any difference
//            between the two is the solver's, not the bot's.
import { RapierEngine } from '@tb/adapter-rapier';
import { DUELS, type Player } from '@tb/keystone';
import { type DuelOutcome, duelOutcome, noviceDuel, swappedOrder, tallyDuels, tallyLine } from './duel-bot.ts';

const argv = process.argv.slice(2), flag = (f: string) => { const k = argv.indexOf(f); if (k >= 0) argv.splice(k, 1); return k >= 0; };
const at = argv.indexOf('--engine');
const engine = at >= 0 ? argv.splice(at, 2)[1]! : 'rapier';
if (engine !== 'rapier' && engine !== 'gpu') throw new Error(`--engine must be rapier or gpu, not ${engine}`);
const swap = flag('--swap'), probe = flag('--probe');
const [ids = 'D1,D2', n = '40', aspect = '1.6', base = '5000'] = argv;
const gpu = engine === 'gpu' ? await (await import('../../keystone-lab/src/cast-browser.ts')).openBrowserCastPlayer({ engine: 'gpu', ...(process.env.TB_CHANNEL ? { channel: process.env.TB_CHANNEL } : {}) }) : null;
const label = `${gpu ? `gpu (${gpu.software ? 'software adapter' : 'hardware'})` : 'rapier'}${swap ? ', parts swapped' : ''}`;

interface Shot1 { rival: number; own: number; king: boolean; mirror: number }
/** One side's first shot of seed `seed` on a fresh table: the rival blocks it brought down, its own, whether the rival king fell. */
async function firstShot(id: string, p: Player, seed: number): Promise<Shot1> {
  const table = DUELS.find((d) => d.id === id)!, def = swap ? swappedOrder(table) : table;
  if (gpu) {
    const r = await gpu.duel(id, p, seed, Number(aspect), { turns: 1, swap, rivalOnly: true });
    const s = r.shots[0];
    return { rival: s?.rival ?? 0, own: s?.own ?? 0, king: !!s?.kingsDown[1 - p], mirror: r.mirror };
  }
  const r = await noviceDuel(new RapierEngine(), def, p, seed, Number(aspect), { turns: 1, rivalOnly: true }), t = r.turns[0];
  return { rival: t?.tally?.rival ?? 0, own: t?.tally?.own ?? 0, king: !!t?.kingsDown[1 - p], mirror: r.mirror };
}

try {
  for (const table of DUELS.filter((d) => ids.split(',').includes(d.id))) {
    if (probe) {
      let gold = 0, blue = 0, gk = 0, bk = 0, more = 0, less = 0, mirror = 0;
      for (let s = 0; s < Number(n); s++) {
        const seed = Number(base) + s, g = await firstShot(table.id, 0, seed), b = await firstShot(table.id, 1, seed);
        gold += g.rival; blue += b.rival; gk += +g.king; bk += +b.king; mirror = Math.max(mirror, g.mirror, b.mirror);
        if (g.rival > b.rival) more++; else if (g.rival < b.rival) less++;
        console.error(`${table.id} seed ${seed}: Gold's shot ${g.rival} down${g.king ? ' + king' : ''}, Blue's ${b.rival}${b.king ? ' + king' : ''}`);
      }
      console.log(`${table.id} ${label} aspect ${aspect}, ${n} paired first shots: rival blocks down Gold ${(gold / Number(n)).toFixed(1)}, Blue ${(blue / Number(n)).toFixed(1)} a shot; kings toppled Gold ${gk}, Blue ${bk}; Gold more ${more}, Blue more ${less}, level ${Number(n) - more - less}; settled table off its mirror by up to ${(1000 * mirror).toFixed(1)} mm`);
      continue;
    }
    const def = swap ? swappedOrder(table) : table, rs: DuelOutcome[] = [];
    for (let s = 0; s < Number(n); s++) {
      const first = (s % 2) as Player, seed = Number(base) + s;
      const r = gpu ? await gpu.duel(table.id, first, seed, Number(aspect), { swap }) : duelOutcome(await noviceDuel(new RapierEngine(), def, first, seed, Number(aspect)));
      rs.push(r);
      console.error(`${table.id} seed ${seed}: first ${first ? 'Blue' : 'Gold'}, winner ${r.winner === null ? 'none' : r.winner ? 'Blue' : 'Gold'} (${r.why}), ${r.turns} turns`);
    }
    console.log(tallyLine(table.id, label, Number(aspect), tallyDuels(rs)));
  }
} finally { await gpu?.close(); }

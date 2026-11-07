// The Siege Table's balance numbers (docs/game/siege-table.md, "Balance"): novice duels (duel-bot.ts) on Rapier,
// first player alternating. `pnpm duel:bot D1,D2 [duels=40] [aspect=1.6] [seed=5000]`; 0.462 is an upright phone.
import { RapierEngine } from '@tb/adapter-rapier';
import { DUELS, type Player } from '@tb/keystone';
import { noviceDuel } from './duel-bot.ts';

const [ids = 'D1,D2', n = '40', aspect = '1.6', base = '5000'] = process.argv.slice(2);
for (const def of DUELS.filter((d) => ids.split(',').includes(d.id))) {
  const tally = { gold: 0, blue: 0, draw: 0, first: 0, second: 0 };
  let turns = 0, own = 0, min = Infinity;
  for (let s = 0; s < Number(n); s++) {
    const r = await noviceDuel(new RapierEngine(), def, (s % 2) as Player, Number(base) + s, Number(aspect));
    if (r.result.over && r.result.winner !== null) { tally[r.result.winner ? 'blue' : 'gold']++; tally[r.result.winner === r.first ? 'first' : 'second']++; } else tally.draw++;
    turns += r.turns.length; own += r.turns.filter((t) => t.own).length; min = Math.min(min, r.turns.length);
  }
  console.log(`${def.id} aspect ${aspect}, ${n} duels from seed ${base}: Gold ${tally.gold}, Blue ${tally.blue}, draws ${tally.draw}; first ${tally.first}, second ${tally.second}; ${(turns / Number(n)).toFixed(1)} turns a duel (fewest ${min}); clicks on own blocks ${own}`);
}

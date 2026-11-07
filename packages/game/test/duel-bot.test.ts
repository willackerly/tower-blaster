// PT5's verify (agent playtest 1): seeded novice duels on both tables last at least two turns each, and end decided.
// The novice (duel-bot.ts) clicks about the middle of the turn view, as the agent playtest's bot did, and fires its
// first item at full power: on the first tables its first shot often ended the duel (D1 phone: one shot), or hit its
// own king (D1 desktop). Rapier in node, so it runs in every CI shard without a GPU; the counts in
// docs/game/siege-table.md ("Balance") come from the same bot over more seeds.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { D1, D2, type Player } from '@tb/keystone';
import { clickPoints, noviceDuel, seeded } from '../src/duel-bot.ts';

const SEEDS = Array.from({ length: 20 }, (_, k) => 9100 + k);

describe('novice duels (Rapier)', () => {
  it('the bot clicks about the middle of what shows, then spirals out from it', () => {
    const wide = clickPoints(1.6, seeded(1)), tall = clickPoints(390 / 844, seeded(1));
    expect(Math.abs(wide[0]![0])).toBeLessThanOrEqual(0.18);
    expect(Math.abs(wide[0]![1] + 0.05)).toBeLessThanOrEqual(0.18);
    expect(wide[1]).toEqual([0, -0.05]);
    expect(tall[1]).toEqual([0, -0.4]);
    expect(clickPoints(1.6, seeded(1))).toEqual(wide);
  });

  it.each([['D1', D1], ['D2', D2]] as const)('%s: 20 seeded novice duels each last at least two turns and end decided', async (_, def) => {
    const lengths: number[] = [];
    let own = 0;
    for (const [k, seed] of SEEDS.entries()) {
      const r = await noviceDuel(new RapierEngine(), def, (k % 2) as Player, seed);
      expect(r.result.over, `seed ${seed}: ${JSON.stringify(r.result)} after ${r.turns.length} turns`).toBe(true);
      lengths.push(r.turns.length);
      own += r.turns.filter((t) => t.own).length;
    }
    expect(Math.min(...lengths), `turns per duel: ${lengths.join(',')}`).toBeGreaterThanOrEqual(2);
    // Two Keeps: no novice click lands on its own keep (the turn view puts the rival in the middle).
    if (def.ruleset === 'keeps') expect(own).toBe(0);
  }, 240_000);
});

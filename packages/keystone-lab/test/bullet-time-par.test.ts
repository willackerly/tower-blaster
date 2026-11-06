// Bullet Time's par on a real engine (playtest PT8: "a cut-in costs a stroke, so Bullet Time can
// only hurt your score"). L5's opener (its par line, one marble down the dominoes) with one cut-in
// fired while it runs: the level clears in two strokes against par 1. With a freeze budget the
// cut-in spent a freeze, so the effective par is par + freezes used = 2 and the round stamps PAR
// with three stars; the same line on L5 as it ships (no budget) is rapid fire and stays a bogey.
// The scoring rule itself is keystone's (rules.ts parWithFreezes); this pins it end to end.
import { describe, expect, it } from 'vitest';
import { RapierEngine } from '@tb/adapter-rapier';
import { compileLevel, L5, runSession, type Shot } from '@tb/keystone';

const opener = L5.solutions!.par![0] as Shot;
/** Fired 30 steps into the opener from the same launcher spot, turned 90 degrees: it touches no domino. */
const cutIn: Shot = { ammo: 'marble', az: 0, y: 4, yaw: 900, pitch: 0, power: 30, after: 30 };

describe('Bullet Time par (PT8)', () => {
  it('L5: the opener plus one cut-in that clears stamps PAR with a freeze budget, BOGEY without', async () => {
    const play = (freeze?: number) => runSession(new RapierEngine(), compileLevel(freeze ? { ...L5, freeze } : L5), [opener, cutIn]);
    const bt = await play(1);
    expect(bt.session.phase).toBe('cleared');
    expect(bt.session.strokes).toBe(2);
    expect(bt.session.outcomes[0]!.cut).toBe(true);
    expect(bt.session.freezesLeft).toBe(0);
    const s = bt.session.score!;
    expect([s.stamp, s.stars, s.freezes]).toEqual(['PAR', 3, { used: 1, total: 1 }]);
    const plain = await play();
    expect(plain.session.phase).toBe('cleared');
    expect([plain.session.score!.stamp, plain.session.score!.stars, plain.session.score!.freezes]).toEqual(['BOGEY', 2, undefined]);
  }, 120_000);
});

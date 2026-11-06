// The weapon fun check (weapon-fun.ts) runs and means something: on L1, Scatter's pellets fly where the slug was aimed
// and knock the tower about (the first draft, pellets a fifth of a cube, moved 1% of it), and the table has a row per
// level and item.
import { describe, expect, it } from 'vitest';
import { L1 } from '@tb/keystone';
import { funTable, inlineRunner, weaponFun } from '../src/index.ts';

describe('weapon fun check', () => {
  it('Scatter on L1: most shots move the tower, and some clear it', { timeout: 120_000 }, async () => {
    const runner = inlineRunner({ kind: 'rapier' });
    try {
      const rows = await weaponFun([L1], ['w-scatter'], runner, { every: 4, powers: [100] });
      expect(rows).toHaveLength(1);
      const r = rows[0]!;
      expect(r.shots).toBeGreaterThan(10);
      expect(r.lively).toBeGreaterThan(0.6);
      expect(r.moved).toBeGreaterThan(0.15);
      expect(r.cleared).toBeGreaterThan(0);
      expect(funTable(rows).split('\n')).toHaveLength(3);
    } finally {
      await runner.close();
    }
  });
});

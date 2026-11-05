// Shared by the lot sheet proof tests (lot-sheets*.test.ts): every proven goal of the named sheets is met
// by its recorded proof line, replayed on the reference (docs/game/lot-sheets.md). A physics change that
// makes a goal unreachable by its proof fails here: re-explore the level (pnpm keystone:goals <id>
// --explore 24) and re-prove the sheet (pnpm keystone:goals <id>, which also replays 8 nudged copies).
import { availableParallelism } from 'node:os';
import { afterAll, describe, expect, it } from 'vitest';
import { checkLotSheet, compileLevel, levelById, LOT_SHEETS } from '@tb/keystone';
import { engineLabel, makeRunner, proveSheet } from '@tb/keystone-lab';

export function lotSheetProofs(levels: readonly string[]): void {
  const sheets = levels.map((id) => LOT_SHEETS[id]!);
  describe(`lot sheet proofs on the reference (${engineLabel({ kind: 'ref' })})`, () => {
    const runner = makeRunner({ kind: 'ref' }, Math.max(2, availableParallelism()));
    // Every sheet's proofs at once, side by side: the runner spreads the plays over its jobs.
    const proved = new Map(sheets.filter(Boolean).map((s) => {
      const p = proveSheet(levelById(s.level), s, runner);
      p.catch(() => {}); // a rejection surfaces in the sheet's own test
      return [s.level, p];
    }));
    afterAll(() => runner.close());

    it.each(levels.map((id) => [id] as const))('%s: a ref sheet, well formed, every goal proven, and each proof line meets its goal', async (id) => {
      const s = LOT_SHEETS[id];
      expect(s?.engine).toBe('ref');
      checkLotSheet(compileLevel(levelById(id)), s!);
      expect(s!.goals.filter((g) => g.proof === undefined).map((g) => g.id)).toEqual([]);
      const proofs = await proved.get(id)!;
      expect(proofs.filter((p) => !p.met).map((p) => p.id)).toEqual([]);
    }, 600_000);
  });
}

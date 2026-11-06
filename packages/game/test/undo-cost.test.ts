// What an undo costs on a big level (roadmap U6, docs/game/undo.md): B1 (1k), B2 (5k) and B3 (10k) play
// their ace line, then undo every shot, from the checkpoints (the default) and by replay
// (keystone.undo=0); each undo's wall time, how it went back, and the checkpoint memory held after
// the line are printed. A measurement for a real GPU only, so it runs only with TB_UNDO_COST=1 (with
// TB_CHANNEL=chrome on the Mac: Metal). Timings from SwiftShader are never performance results.
// A level with no ace line plays its par line, or else borrows B1's ace line when its rack can fire it
// (B3 did before its cast landed: its rack is B1's, three bombs; any line serves, since this measures
// the undos, not the score). TB_UNDO_LEVELS=B1,B3 picks the levels (default all three); TB_UNDO_OUT=<file> appends the
// results to a file, so they survive a reporter that hides console output.
import { appendFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { B1, B2, B3, type LevelDef, type Shot } from '@tb/keystone';
import { gamePage, ready } from './page.ts';

const MINUTES = 60_000;
const on = process.env.TB_UNDO_COST === '1';
const game = gamePage();
const pick = (process.env.TB_UNDO_LEVELS ?? 'B1,B2,B3').split(',').filter(Boolean);

/** The line to play: the level's ace, else its par, else B1's ace (same rack as B3's), and where it came from. */
export function undoLine(level: LevelDef): { line: Shot[]; from: string } {
  const own = level.solutions?.ace ?? level.solutions?.par;
  if (own) return { line: own as Shot[], from: level.solutions?.ace ? 'ace' : 'par' };
  const borrowed = B1.solutions!.ace! as Shot[];
  const left = [...level.rack];
  for (const s of borrowed) { const k = left.indexOf(s.ammo); if (k < 0) throw new Error(`${level.id} has no line, and its rack [${level.rack.join(', ')}] cannot fire B1's ace line`); left.splice(k, 1); }
  return { line: borrowed, from: "B1's ace" };
}

describe.runIf(on)('undo cost on a big level', () => {
  for (const level of [B1, B2, B3].filter((l) => pick.includes(l.id))) for (const mode of ['checkpoint', 'replay'] as const) {
    it(`${level.id}: undo every shot of a line (${mode})`, async () => {
      const o = await game.open(`/?level=${level.id}&engine=gpu&offscreen=1&progress=off${mode === 'replay' ? '&keystone.undo=0' : ''}`, 20 * MINUTES);
      expect(o).not.toBeNull();
      const { page, errors } = o!;
      await ready(page, 20 * MINUTES);
      await page.evaluate(() => { window.__game.fast = true; });
      const { line, from } = undoLine(level);
      for (const [i, s] of line.entries()) {
        await ready(page, 20 * MINUTES);
        if (await page.evaluate(() => window.__game.result !== null)) break;
        expect(await page.evaluate((x) => window.__game.fire(x), s)).toBe(true);
        await page.waitForFunction((n) => window.__game.result !== null || (window.__game.ready && window.__game.strokes === n), i + 1, { timeout: 20 * MINUTES, polling: 100 });
      }
      const mem = await page.evaluate(() => window.__game.undoMemory());
      const rows: string[] = [];
      for (let n = await page.evaluate(() => window.__game.strokes); n > 0; n--) {
        const t = await page.evaluate(async () => { const t0 = performance.now(); await window.__game.undo(); return { ms: performance.now() - t0, step: window.__game.stepIndex, how: window.__game.undone }; });
        expect(t.how!.mode).toBe(mode);
        rows.push(`undo to ${n - 1} shots: ${t.ms.toFixed(1)} ms wall (${t.how!.mode}, ${t.how!.ms.toFixed(1)} ms inside), at engine step ${t.step}`);
      }
      const text = `${level.id} undo cost (${mode}; ${from} line, ${line.length} shots; ${mem.marks} checkpoints, ${(mem.bytes / 2 ** 20).toFixed(1)} MB held after the line):\n  ${rows.join('\n  ')}\n`;
      console.log(text);
      if (process.env.TB_UNDO_OUT) appendFileSync(process.env.TB_UNDO_OUT, text);
      expect(errors).toEqual([]);
      await page.close();
    }, 60 * MINUTES);
  }
});

describe('the undo-cost line', () => {
  it("is the level's ace, else its par, else B1's ace when the rack can fire it", () => {
    expect(undoLine(B1)).toEqual({ line: B1.solutions!.ace, from: 'ace' });
    expect(undoLine(B3)).toEqual({ line: B3.solutions!.ace, from: 'ace' });
    expect(undoLine({ ...B3, solutions: undefined })).toEqual({ line: B1.solutions!.ace, from: "B1's ace" });
    expect(undoLine({ ...B3, solutions: { par: B2.solutions!.ace! } })).toEqual({ line: B2.solutions!.ace, from: 'par' });
    expect(() => undoLine({ ...B3, solutions: undefined, rack: ['w-ram'] })).toThrow(/cannot fire B1's ace line/);
  });
});

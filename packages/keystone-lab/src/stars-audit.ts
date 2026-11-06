// Helpers of the par levels' star audit (pnpm keystone:stars, stars-audit-cli.ts; docs/game/stars.md).
import { compileLevel, type LevelDef } from '@tb/keystone';

/** The rule this audit replaced: one star over par, two at par, three at par with no heritage broken and leverage at lGold. */
export function oldParStars(cleared: boolean, strokes: number, par: number, broken: number, L: number, lGold: number): 0 | 1 | 2 | 3 {
  return !cleared ? 0 : strokes > par ? 1 : broken === 0 && L >= lGold ? 3 : 2;
}

/** The game's launcher heights for a level (game aim.ts launchRange): its own, and the default 2 h over its top, in 1/4 h. */
export function launchHeights(def: LevelDef): { level: number; high: number } {
  const c = compileLevel(def), low = Math.round(c.frame.launcher.y * 4);
  return { level: low, high: Math.max(low, Math.ceil(4 * (c.height / c.frame.unit + 2))) };
}

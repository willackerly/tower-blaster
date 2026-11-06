// The star audit's helpers (pnpm keystone:stars): the replaced rule as it was, and the game's two
// launcher heights (game aim.ts launchRange: the level's own, and 2 h over the structure's top).
import { describe, expect, it } from 'vitest';
import { L1, L4, parStars } from '@tb/keystone';
import { launchHeights, oldParStars } from '../src/stars-audit.ts';

describe('star audit helpers', () => {
  it('the old rule: one over par, two at par, three at par with heritage intact and leverage at the line', () => {
    expect([oldParStars(false, 1, 1, 0, 9, 1), oldParStars(true, 2, 1, 0, 9, 1), oldParStars(true, 1, 1, 0, 0.99, 1), oldParStars(true, 1, 1, 1, 9, 1), oldParStars(true, 1, 1, 0, 1, 1)]).toEqual([0, 1, 2, 2, 3]);
    // L1's own par line on the reference: one shot, leverage 0.707 against lGold 0.71.
    expect([oldParStars(true, 1, 1, 0, 0.707, L1.lGold!), parStars(true, 1, 1, 0)]).toEqual([2, 3]);
  });
  it('launcher heights in 1/4 h: L1 (10 h tall, launcher 2 h) and L4 (crown top 5.25 h)', () => {
    expect(launchHeights(L1)).toEqual({ level: 8, high: 48 });
    expect(launchHeights(L4).level).toBe(8);
    expect(launchHeights(L4).high).toBeGreaterThan(8);
  });
});

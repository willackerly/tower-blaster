import { expect } from 'vitest';
import { U1, type Shot } from '@tb/keystone';
import { playShots, ready } from './page.ts';
import { parOnGpu } from './par-gpu.ts';

// U1, an Undercut par puzzle (undercut-levels.ts): on the GPU solver too, the par pair clears it
// and a wrong pair does not: the diagonal pair (legs 0 and 3) leaves the table balanced on the other diagonal. Retry then plays the par line from the start checkpoint.
const WRONG: Shot[] = [0, 3].map((body) => ({ ammo: 'pull', body }));

parOnGpu('U1', {
  async before(page) {
    await ready(page, 600_000);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(9);
    await playShots(page, WRONG, 600_000);
    expect(await page.evaluate(() => { const s = window.__game.state(); return { phase: s.phase, strokes: s.strokes, result: window.__game.result !== null }; })).toEqual({ phase: 'aiming', strokes: 2, result: false });
    await page.evaluate(() => window.__game.retry());
    await ready(page, 600_000);
    expect(await page.evaluate(() => window.__game.state().strokes)).toBe(0);
    expect(U1.solutions?.par).toHaveLength(U1.par);
  },
});

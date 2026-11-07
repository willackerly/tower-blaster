import { expect } from 'vitest';
import { U2, type Shot } from '@tb/keystone';
import { playShots, ready } from './page.ts';
import { parOnGpu } from './par-gpu.ts';

// U2, an Undercut par puzzle (undercut-levels.ts): on the GPU solver too, the par pair clears it
// and a wrong pair does not: the far rod and a near cube leave the beam level (centre of mass +0.63 h, the pier\'s edge at +1 h). Retry then plays the par line from the start checkpoint.
const WRONG: Shot[] = [6, 8].map((body) => ({ ammo: 'pull', body }));

parOnGpu('U2', {
  async before(page) {
    await ready(page, 600_000);
    expect(await page.evaluate(() => window.__game.bodies)).toBe(10);
    await playShots(page, WRONG, 600_000);
    expect(await page.evaluate(() => { const s = window.__game.state(); return { phase: s.phase, strokes: s.strokes, result: window.__game.result !== null }; })).toEqual({ phase: 'aiming', strokes: 2, result: false });
    await page.evaluate(() => window.__game.retry());
    await ready(page, 600_000);
    expect(await page.evaluate(() => window.__game.state().strokes)).toBe(0);
    expect(U2.solutions?.par).toHaveLength(U2.par);
  },
});
